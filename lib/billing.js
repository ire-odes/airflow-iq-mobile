// lib/billing.js
// Stripe billing helpers. All money handling happens server-side in Supabase
// Edge Functions (see supabase/functions/) — the app only opens Stripe-hosted
// pages, so no card data ever touches the app and no secret keys ship in it.

import * as WebBrowser from "expo-web-browser";
import { supabase } from "./supabase";

// Deep link Stripe redirects back to after checkout/portal
const RETURN_URL = "airflowiq://billing-return";

export const SUBSCRIPTION_PLANS = {
  free: {
    name: "Free",
    features: ["1 device", "Live sensor readings", "Manual filter tracking"],
  },
  pro: {
    name: "Pro",
    priceLabel: "$9.99/mo",
    features: [
      "Unlimited devices",
      "Push alerts & tenant emails",
      "Filter life predictions",
      "Technician team access",
      "Priority support",
    ],
  },
};

async function invokeBilling(fn, body = {}) {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    // Supabase wraps non-2xx responses; surface the function's message if present
    let message = error.message || "Billing request failed";
    try {
      const ctx = await error.context?.json?.();
      if (ctx?.error) message = ctx.error;
    } catch (_) {}
    throw new Error(message);
  }
  return data;
}

// Opens a Stripe-hosted URL and resolves when the user returns to the app.
async function openStripeUrl(url) {
  const result = await WebBrowser.openAuthSessionAsync(url, RETURN_URL);
  return result.type; // "success" | "cancel" | "dismiss"
}

// ── Catalog / orders ─────────────────────────────────────────────────────────

export async function fetchProducts() {
  const { data, error } = await supabase
    .from("products")
    .select("*")
    .eq("active", true)
    .order("price_cents", { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function fetchOrders(userId) {
  const { data, error } = await supabase
    .from("orders")
    .select("id, status, payment_status, total_cents, currency, created_at, order_items(qty, unit_price_cents, products(name))")
    .eq("customer_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  // Enrich with invoice/shipment progress from the fulfillment pipeline view
  let fulfillment = [];
  const { data: fData, error: fError } = await supabase
    .from("v_my_orders")
    .select("order_id, invoice_status, paid_at, shipment_status, tracking_number, tracking_url, delivered_at");
  if (fError) console.warn("v_my_orders:", fError.message);
  else fulfillment = fData || [];

  const byOrder = new Map(fulfillment.map(f => [f.order_id, f]));
  return (data || []).map(o => ({ ...o, fulfillment: byOrder.get(o.id) || null }));
}

// items: [{ product_id, quantity }]
export async function startDeviceCheckout(items) {
  const data = await invokeBilling("create-checkout", { items });
  if (!data?.url) throw new Error("Checkout could not be started");
  return openStripeUrl(data.url);
}

// ── Subscriptions ────────────────────────────────────────────────────────────

export async function fetchSubscription(userId) {
  const { data, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data; // null = free plan
}

export function isSubscriptionActive(sub) {
  return !!sub && ["active", "trialing", "past_due"].includes(sub.status);
}

export async function startSubscriptionCheckout() {
  const data = await invokeBilling("create-subscription-checkout", {});
  if (!data?.url) throw new Error("Checkout could not be started");
  return openStripeUrl(data.url);
}

export async function openBillingPortal() {
  const data = await invokeBilling("customer-portal", {});
  if (!data?.url) throw new Error("Billing portal could not be opened");
  return openStripeUrl(data.url);
}

export function formatMoney(cents, currency = "usd") {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}
