// POST {} → { url }
// Opens the Stripe customer portal so users manage/cancel their subscription.
import {
  corsHeaders, jsonResponse, getStripe, getAdminClient, getCallingUser, resolveReturnUrl,
} from "../_shared/utils.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await getCallingUser(req);
    if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

    const { return_to } = await req.json().catch(() => ({}));

    const admin = getAdminClient();
    const { data: sub, error } = await admin
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) return jsonResponse({ error: error.message }, 500);
    if (!sub?.stripe_customer_id) {
      return jsonResponse({ error: "No billing account found. Subscribe first." }, 400);
    }

    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: resolveReturnUrl(return_to, "portal-done"),
    });

    return jsonResponse({ url: session.url });
  } catch (e) {
    console.error("customer-portal:", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
