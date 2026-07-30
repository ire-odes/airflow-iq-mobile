// Drains public.sms_outbox through Twilio. Invoked by pg_cron every minute
// (see migration 20260730000000_sms_outbox.sql).
// Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER (all required).
import { corsHeaders, jsonResponse, getAdminClient } from "../_shared/utils.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    const fromNumber = Deno.env.get("TWILIO_FROM_NUMBER");
    if (!accountSid || !authToken || !fromNumber) {
      return jsonResponse({ error: "Twilio secrets are not set" }, 500);
    }

    const admin = getAdminClient();

    const { data: batch, error } = await admin.rpc("claim_queued_sms", { p_limit: 25 });
    if (error) return jsonResponse({ error: error.message }, 500);

    const basicAuth = btoa(`${accountSid}:${authToken}`);
    let sent = 0;
    let failed = 0;

    for (const row of batch ?? []) {
      try {
        const res = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
          {
            method: "POST",
            headers: {
              Authorization: `Basic ${basicAuth}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ To: row.to_phone, From: fromNumber, Body: row.body }),
          },
        );
        if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
        await admin.from("sms_outbox")
          .update({ status: "sent", sent_at: new Date().toISOString(), error: null })
          .eq("id", row.id);
        sent++;
      } catch (e) {
        await admin.from("sms_outbox")
          .update({ status: "failed", error: String(e).slice(0, 500) })
          .eq("id", row.id);
        failed++;
        console.error(`send-sms ${row.id}:`, e);
      }
    }

    return jsonResponse({ claimed: batch?.length ?? 0, sent, failed });
  } catch (e) {
    console.error("send-sms:", e);
    return jsonResponse({ error: (e as Error).message }, 500);
  }
});
