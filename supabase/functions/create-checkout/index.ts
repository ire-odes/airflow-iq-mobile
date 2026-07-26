// POST { items: [{ product_id, quantity }] } → { url }
// Creates a draft order in the existing store schema and a Stripe Checkout
// session for one-time payment. Line/order totals are computed by the
// database triggers (trg_calc_order_item_line_total / trg_recalc_order_totals).
import {
  corsHeaders, jsonResponse, getStripe, getAdminClient, getCallingUser, billingReturnUrl,
} from "../_shared/utils.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await getCallingUser(req);
    if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

    const { items } = await req.json();
    if (!Array.isArray(items) || items.length === 0) {
      return jsonResponse({ error: "Cart is empty" }, 400);
    }
    for (const item of items) {
      const qty = Number(item?.quantity);
      if (!item?.product_id || !Number.isInteger(qty) || qty < 1 || qty > 50) {
        return jsonResponse({ error: "Invalid cart item" }, 400);
      }
    }

    const admin = getAdminClient();

    // Server-side price lookup — never trust prices from the client
    const productIds = items.map((i: { product_id: string }) => i.product_id);
    const { data: products, error: prodError } = await admin
      .from("products")
      .select("id, name, description, price_cents, currency, active")
      .in("id", productIds);
    if (prodError) return jsonResponse({ error: prodError.message }, 500);

    const byId = new Map((products ?? []).map((p) => [p.id, p]));
    for (const item of items) {
      const p = byId.get(item.product_id);
      if (!p || !p.active) return jsonResponse({ error: "Product not available" }, 400);
    }

    // Draft order — the webhook flips it to 'submitted' after payment,
    // which fires the invoice-creation trigger.
    const { data: order, error: orderError } = await admin
      .from("orders")
      .insert({
        customer_id: user.id,
        created_by: user.id,
        status: "draft",
        payment_provider: "stripe",
        currency: byId.get(items[0].product_id)!.currency ?? "USD",
      })
      .select("id")
      .single();
    if (orderError) return jsonResponse({ error: orderError.message }, 500);

    // line_total_cents and order totals are filled in by DB triggers
    const { error: itemsError } = await admin.from("order_items").insert(
      items.map((i: { product_id: string; quantity: number }) => ({
        order_id: order.id,
        product_id: i.product_id,
        qty: i.quantity,
        unit_price_cents: byId.get(i.product_id)!.price_cents,
      })),
    );
    if (itemsError) {
      await admin.from("orders").delete().eq("id", order.id);
      return jsonResponse({ error: itemsError.message }, 500);
    }

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: user.email ?? undefined,
      line_items: items.map((i: { product_id: string; quantity: number }) => {
        const p = byId.get(i.product_id)!;
        return {
          quantity: i.quantity,
          price_data: {
            currency: (p.currency ?? "USD").toLowerCase(),
            unit_amount: p.price_cents,
            product_data: { name: p.name, description: p.description ?? undefined },
          },
        };
      }),
      shipping_address_collection: { allowed_countries: ["US", "CA"] },
      metadata: { order_id: order.id, user_id: user.id },
      success_url: billingReturnUrl("success"),
      cancel_url: billingReturnUrl("cancel"),
    });

    await admin
      .from("orders")
      .update({ stripe_checkout_session_id: session.id })
      .eq("id", order.id);

    return jsonResponse({ url: session.url });
  } catch (e) {
    console.error("create-checkout:", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
