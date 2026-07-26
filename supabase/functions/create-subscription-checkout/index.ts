// POST {} → { url }
// Starts a Stripe Checkout session for the Pro subscription.
// Requires secret STRIPE_PRO_PRICE_ID (a recurring Price id, e.g. price_...).
import {
  corsHeaders, jsonResponse, getStripe, getAdminClient, getCallingUser, billingReturnUrl,
} from "../_shared/utils.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await getCallingUser(req);
    if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

    const priceId = Deno.env.get("STRIPE_PRO_PRICE_ID");
    if (!priceId) return jsonResponse({ error: "Subscriptions are not configured yet" }, 500);

    const admin = getAdminClient();
    const stripe = getStripe();

    // Reuse the Stripe customer if this user already has one
    const { data: existing } = await admin
      .from("subscriptions")
      .select("stripe_customer_id, status")
      .eq("user_id", user.id)
      .maybeSingle();

    if (existing && ["active", "trialing"].includes(existing.status)) {
      return jsonResponse({ error: "You already have an active subscription" }, 400);
    }

    let customerId = existing?.stripe_customer_id ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { user_id: user.id },
      });
      customerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { metadata: { user_id: user.id } },
      metadata: { user_id: user.id },
      success_url: billingReturnUrl("success"),
      cancel_url: billingReturnUrl("cancel"),
    });

    return jsonResponse({ url: session.url });
  } catch (e) {
    console.error("create-subscription-checkout:", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
