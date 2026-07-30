// Drains public.email_outbox through Resend. Invoked by pg_cron every minute
// (see migration 20260715010000_email_outbox_sender.sql).
// Secrets: RESEND_API_KEY (required), EMAIL_FROM (optional, defaults below).
import { corsHeaders, jsonResponse, getAdminClient } from "../_shared/utils.ts";

const DEFAULT_FROM = "AirFlow IQ <support@airfloiq.com>";

const money = (cents: unknown, currency = "USD") =>
  typeof cents === "number"
    ? new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100)
    : "";

const when = (ts: unknown) =>
  typeof ts === "string"
    ? new Date(ts).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : "";

// deno-lint-ignore no-explicit-any
function bodyLines(template: string, p: any): string[] {
  switch (template) {
    case "order_submitted":
      return [
        `We received your order and it's being processed.`,
        p.total_cents != null ? `<b>Total:</b> ${money(p.total_cents)}` : "",
        p.submitted_at ? `<b>Placed:</b> ${when(p.submitted_at)}` : "",
        `Order reference: <code>${p.order_id ?? ""}</code>`,
      ];
    case "invoice_paid":
      return [
        `Thanks — your payment was received.`,
        p.invoice_number ? `<b>Invoice:</b> ${p.invoice_number}` : "",
        p.total_cents != null ? `<b>Amount:</b> ${money(p.total_cents)}` : "",
        p.paid_at ? `<b>Paid:</b> ${when(p.paid_at)}` : "",
      ];
    case "shipment_in_transit":
      return [
        `Your order has shipped!`,
        p.carrier ? `<b>Carrier:</b> ${p.carrier}${p.service ? ` (${p.service})` : ""}` : "",
        p.tracking_number ? `<b>Tracking #:</b> ${p.tracking_number}` : "",
        p.tracking_url ? `<a href="${p.tracking_url}">Track your package</a>` : "",
      ];
    case "shipment_delivered":
      return [
        `Your order was delivered${p.delivered_at ? ` on ${when(p.delivered_at)}` : ""}. Enjoy!`,
        `If anything's wrong with your order, just reply to this email.`,
      ];
    case "tenant_filter_due":
      return [
        `This is a reminder that the HVAC filter for <b>${p.device_name ?? "your unit"}</b>${p.hvac_location ? ` (${p.hvac_location})` : ""} is due for replacement.`,
        p.days_since != null && p.interval_days != null
          ? `It's been installed for <b>${p.days_since} days</b> (recommended interval: ${p.interval_days} days).`
          : "",
        `Please reach out to your property manager to schedule a replacement, or replace it yourself if that's part of your lease arrangement.`,
      ];
    default:
      // Unknown template — send subject + payload fields rather than dropping it
      return Object.entries(p ?? {}).map(([k, v]) => `<b>${k}:</b> ${String(v)}`);
  }
}

// deno-lint-ignore no-explicit-any
function renderEmail(row: any): string {
  const lines = bodyLines(row.template, row.payload ?? {})
    .filter(Boolean)
    .map((l) => `<p style="margin:0 0 12px">${l}</p>`)
    .join("\n");
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f7f8fc;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px">
    <div style="font-size:20px;font-weight:800;color:#007BFF;margin-bottom:16px">AirFlow IQ</div>
    <div style="background:#fff;border-radius:14px;padding:24px;color:#1a1a2e;font-size:15px;line-height:1.5">
      <div style="font-size:17px;font-weight:700;margin-bottom:14px">${row.subject}</div>
      ${lines}
    </div>
    <div style="color:#9ca3af;font-size:12px;margin-top:16px;text-align:center">
      AirFlow IQ &middot; HVAC filter monitoring
    </div>
  </div>
</body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) return jsonResponse({ error: "RESEND_API_KEY is not set" }, 500);
    const from = Deno.env.get("EMAIL_FROM") ?? DEFAULT_FROM;

    const admin = getAdminClient();

    // Atomic claim (status → 'sending') so overlapping runs never double-send
    const { data: batch, error } = await admin.rpc("claim_queued_emails", { p_limit: 25 });
    if (error) return jsonResponse({ error: error.message }, 500);

    let sent = 0;
    let failed = 0;
    for (const row of batch ?? []) {
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from,
            to: [row.to_email],
            subject: row.subject,
            html: renderEmail(row),
          }),
        });
        if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
        await admin.from("email_outbox")
          .update({ status: "sent", sent_at: new Date().toISOString(), error: null })
          .eq("id", row.id);
        sent++;
      } catch (e) {
        await admin.from("email_outbox")
          .update({ status: "failed", error: String(e).slice(0, 500) })
          .eq("id", row.id);
        failed++;
        console.error(`send-emails ${row.id}:`, e);
      }
    }

    return jsonResponse({ claimed: batch?.length ?? 0, sent, failed });
  } catch (e) {
    console.error("send-emails:", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
