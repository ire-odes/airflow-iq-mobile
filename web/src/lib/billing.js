// Stripe billing helpers for the web app.
// Mirrors the mobile lib/billing.js — same Edge Functions, same data — but
// redirects the browser to Stripe instead of opening an in-app auth session.
// All money handling stays server-side; no secret keys ship here.

import { supabase } from "./supabase.js";

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

// Where Stripe sends the browser back to. The Edge Function only honours this
// when its origin matches the WEB_APP_URL secret, so it can't be used to
// redirect elsewhere.
function returnTo(path = "/orders") {
  return `${window.location.origin}${path}`;
}

async function invokeBilling(fn, body = {}) {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    // Supabase wraps non-2xx responses; surface the function's message if present
    let message = error.message || "Billing request failed";
    try {
      const ctx = await error.context?.json?.();
      if (ctx?.error) message = ctx.error;
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new Error(message);
  }
  return data;
}

// Full-page redirect to Stripe's hosted page. Nothing after this runs.
function goToStripe(url) {
  window.location.href = url;
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

  const byOrder = new Map(fulfillment.map((f) => [f.order_id, f]));
  return (data || []).map((o) => ({ ...o, fulfillment: byOrder.get(o.id) || null }));
}

// items: [{ product_id, quantity }]
export async function startDeviceCheckout(items) {
  const data = await invokeBilling("create-checkout", { items, return_to: returnTo("/orders") });
  if (!data?.url) throw new Error("Checkout could not be started");
  goToStripe(data.url);
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
  const data = await invokeBilling("create-subscription-checkout", { return_to: returnTo("/account") });
  if (!data?.url) throw new Error("Checkout could not be started");
  goToStripe(data.url);
}

export async function openBillingPortal() {
  const data = await invokeBilling("customer-portal", { return_to: returnTo("/account") });
  if (!data?.url) throw new Error("Billing portal could not be opened");
  goToStripe(data.url);
}

export function formatMoney(cents, currency = "usd") {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

// Collapse the fulfillment pipeline (order → invoice → shipment) into one badge
export function effectiveStatus(order) {
  const f = order.fulfillment;
  if (f?.delivered_at || f?.shipment_status === "delivered") return "delivered";
  if (f?.shipment_status === "shipped" || f?.tracking_number) return "shipped";
  if (["canceled", "cancelled"].includes(order.status)) return "canceled";
  if (order.payment_status === "paid" || f?.paid_at || order.status === "submitted") return "paid";
  return "pending"; // draft orders awaiting checkout
}

// Deletes the current user's account (see supabase/functions/delete-account).
// Cancels any active subscription, unclaims owned devices, and either fully
// deletes the account or — if it has order history that can't be deleted
// for financial record-keeping reasons — scrubs personal data and
// permanently disables login instead. Either way the caller should sign out
// immediately after this resolves.
export async function deleteAccount() {
  return invokeBilling("delete-account", {});
}

export const ORDER_STATUS = {
  pending:   { color: "#f59e0b", icon: "clock",   label: "Awaiting payment" },
  paid:      { color: "#22c55e", icon: "success", label: "Paid" },
  shipped:   { color: "#3b82f6", icon: "truck",   label: "Shipped" },
  delivered: { color: "#22c55e", icon: "package", label: "Delivered" },
  canceled:  { color: "#ef4444", icon: "close",   label: "Canceled" },
};
