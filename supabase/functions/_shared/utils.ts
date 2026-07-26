// Shared helpers for AirFlow IQ billing functions.
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function getStripe(): Stripe {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
  return new Stripe(key, { apiVersion: "2024-06-20" });
}

// Service-role client — bypasses RLS. Server-side only.
export function getAdminClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

// Resolve the calling user from the request's Authorization header.
export async function getCallingUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const client = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data, error } = await client.auth.getUser();
  if (error) return null;
  return data.user;
}

// https page Stripe can redirect to, which then bounces back into the app.
export function billingReturnUrl(status: string): string {
  return `${Deno.env.get("SUPABASE_URL")}/functions/v1/billing-return?status=${status}`;
}

// Where Stripe should send the user after checkout.
//
// The mobile app relies on billingReturnUrl(), which bounces through a deep
// link — that does nothing in a desktop browser, so the web app passes its own
// `return_to`. Anything a client supplies here ends up as a Stripe redirect
// target, so it is only honoured when its origin exactly matches WEB_APP_URL;
// otherwise we silently fall back to the deep-link page. Exact origin match,
// not a prefix test — a prefix test would let `https://evil.com` through for a
// WEB_APP_URL of `https://evil.com.attacker.net`.
export function resolveReturnUrl(returnTo: unknown, status: string): string {
  const allowed = Deno.env.get("WEB_APP_URL");
  if (typeof returnTo === "string" && returnTo && allowed) {
    try {
      const target = new URL(returnTo);
      if (target.origin === new URL(allowed).origin) {
        target.searchParams.set("status", status);
        return target.toString();
      }
    } catch {
      // Malformed URL — fall through to the deep-link page.
    }
  }
  return billingReturnUrl(status);
}
