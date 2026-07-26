// Stripe webhook — keeps orders, invoices and subscriptions in sync.
// Deploy with: supabase functions deploy stripe-webhook --no-verify-jwt
// Requires secrets STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.
//
// Events to enable on the Stripe endpoint:
//   checkout.session.completed
//   checkout.session.expired
//   customer.subscription.created
//   customer.subscription.updated
//   customer.subscription.deleted
import Stripe from "npm:stripe@17";
import { jsonResponse, getStripe, getAdminClient } from "../_shared/utils.ts";

async function upsertSubscription(sub: Stripe.Subscription) {
  const admin = getAdminClient();
  const userId = sub.metadata?.user_id;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;

  // Resolve user id from customer metadata if the subscription lacks it
  let resolvedUserId = userId;
  if (!resolvedUserId && customerId) {
    const stripe = getStripe();
    const customer = await stripe.customers.retrieve(customerId);
    if (!("deleted" in customer)) resolvedUserId = customer.metadata?.user_id;
  }
  if (!resolvedUserId) {
    console.error("upsertSubscription: no user_id in metadata for", sub.id);
    return;
  }

  const { error } = await admin.from("subscriptions").upsert(
    {
      user_id: resolvedUserId,
      stripe_customer_id: customerId,
      stripe_subscription_id: sub.id,
      plan: "pro",
      status: sub.status,
      current_period_end: sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null,
      cancel_at_period_end: sub.cancel_at_period_end ?? false,
    },
    { onConflict: "user_id" },
  );
  if (error) console.error("upsertSubscription:", error.message);
}

async function handleOrderPaid(session: Stripe.Checkout.Session) {
  const admin = getAdminClient();
  const orderId = session.metadata!.order_id;

  const shipping = (session as unknown as {
    shipping_details?: {
      name?: string;
      address?: {
        line1?: string; line2?: string; city?: string;
        state?: string; postal_code?: string; country?: string;
      };
    };
  }).shipping_details;
  const addr = shipping?.address;

  // Submitting the order fires the existing DB triggers that create the
  // invoice and queue the confirmation email. Guarded by status='draft'
  // so Stripe webhook retries stay idempotent.
  const { data: updated, error } = await admin
    .from("orders")
    .update({
      status: "submitted",
      submitted_at: new Date().toISOString(),
      payment_status: "paid",
      payment_intent_id: typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id ?? null,
      ship_to_name: shipping?.name ?? session.customer_details?.name ?? null,
      ship_to_line1: addr?.line1 ?? null,
      ship_to_line2: addr?.line2 ?? null,
      ship_to_city: addr?.city ?? null,
      ship_to_state: addr?.state ?? null,
      ship_to_postal: addr?.postal_code ?? null,
      ship_to_country: addr?.country ?? "US",
      ship_to_phone: session.customer_details?.phone ?? null,
    })
    .eq("id", orderId)
    .eq("status", "draft")
    .select("id");
  if (error) {
    console.error("order submit:", error.message);
    return;
  }
  if (!updated || updated.length === 0) return; // already processed

  // The submit trigger just created the invoice — mark it paid, since Stripe
  // already collected the money.
  const paymentIntentId = typeof session.payment_intent === "string"
    ? session.payment_intent
    : session.payment_intent?.id ?? null;
  const { error: invError } = await admin
    .from("invoices")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      payment_ref: paymentIntentId,
      updated_at: new Date().toISOString(),
    })
    .eq("order_id", orderId)
    .is("paid_at", null);
  if (invError) console.error("invoice paid update:", invError.message);
}

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!signature || !webhookSecret) {
    return jsonResponse({ error: "Missing signature or webhook secret" }, 400);
  }

  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    const body = await req.text();
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
  } catch (e) {
    console.error("Webhook signature verification failed:", (e as Error).message);
    return jsonResponse({ error: "Invalid signature" }, 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === "payment" && session.metadata?.order_id) {
          await handleOrderPaid(session);
        } else if (session.mode === "subscription" && session.subscription) {
          const subId = typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;
          const sub = await stripe.subscriptions.retrieve(subId);
          await upsertSubscription(sub);
        }
        break;
      }
      case "checkout.session.expired": {
        // Abandoned checkout — remove the draft order so it doesn't linger
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === "payment" && session.metadata?.order_id) {
          const admin = getAdminClient();
          const { error } = await admin
            .from("orders")
            .delete()
            .eq("id", session.metadata.order_id)
            .eq("status", "draft");
          if (error) console.error("draft cleanup:", error.message);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await upsertSubscription(event.data.object as Stripe.Subscription);
        break;
      }
      default:
        break; // ignore everything else
    }
    return jsonResponse({ received: true });
  } catch (e) {
    console.error("stripe-webhook:", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
