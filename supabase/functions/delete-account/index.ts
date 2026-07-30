// POST {} → { deleted: boolean, anonymized: boolean }
// Self-service account deletion. Only ever acts on the calling user's own
// id (from their JWT) — never accepts a client-supplied user id.
//
// Order records are financial history (orders.customer_id has an ON DELETE
// RESTRICT foreign key to profiles) — deleting the account outright while
// any exist would just fail with a Postgres FK violation. So: users with no
// order history get a real, permanent delete; users who've ordered
// something get their personal data scrubbed and their login permanently
// disabled instead, while the order/invoice records stay intact for
// business/tax record-keeping. Either way the account is unusable
// afterward — the distinction is invisible to the person deleting it.
import {
  corsHeaders, jsonResponse, getStripe, getAdminClient, getCallingUser,
} from "../_shared/utils.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const user = await getCallingUser(req);
    if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

    const admin = getAdminClient();

    // 1. Cancel any active Stripe subscription — don't leave someone being
    // billed for an account that no longer exists.
    const { data: sub } = await admin
      .from("subscriptions")
      .select("stripe_subscription_id, status")
      .eq("user_id", user.id)
      .maybeSingle();

    if (sub?.stripe_subscription_id && ["active", "trialing", "past_due"].includes(sub.status)) {
      try {
        await getStripe().subscriptions.cancel(sub.stripe_subscription_id);
      } catch (e) {
        console.error("delete-account: Stripe cancel failed:", e);
      }
    }

    // 2. Unclaim owned devices rather than deleting them — this is real
    // hardware that should stay claimable, and its sensor history shouldn't
    // vanish just because an account closed.
    await admin
      .from("devices")
      .update({ owner_id: null, property_id: null, tenant_email: null })
      .eq("owner_id", user.id);

    // 3. Delete owned properties (cascades property_technician_assignments).
    await admin.from("properties").delete().eq("owner_id", user.id);

    // 4. Drop technician relationships in both directions.
    await admin.from("technician_assignments").delete().eq("landlord_id", user.id);
    if (user.email) {
      await admin.from("technician_assignments").delete().eq("technician_email", user.email);
      await admin.from("property_technician_assignments").delete().eq("technician_email", user.email);
    }

    // 5. Orders determine the path: hard delete, or scrub + disable.
    const { count } = await admin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", user.id);

    if (count && count > 0) {
      await admin.from("profiles").update({ full_name: "Deleted User" }).eq("id", user.id);

      // Randomised, unusable credentials + an effectively-permanent ban —
      // as close to "deleted" as it gets while an order still points here.
      await admin.auth.admin.updateUserById(user.id, {
        password: crypto.randomUUID() + crypto.randomUUID(),
        email: `deleted-${user.id}@deleted.airfloiq.invalid`,
        ban_duration: "876000h", // ~100 years
      });

      return jsonResponse({ deleted: false, anonymized: true });
    }

    // No order history — safe to fully delete.
    const { error: delError } = await admin.auth.admin.deleteUser(user.id);
    if (delError) return jsonResponse({ error: delError.message }, 500);

    return jsonResponse({ deleted: true, anonymized: false });
  } catch (e) {
    console.error("delete-account:", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
