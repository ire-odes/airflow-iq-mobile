/**
 * ttn_webhook — Supabase Edge Function
 *
 * Receives uplink webhooks from The Things Network, looks up the device
 * by MAC address in the devices table, then inserts a row into sensor_logs.
 *
 * TTN Console setup:
 *   Integrations → Webhooks → Custom webhook
 *   Base URL  : https://<project>.functions.supabase.co/functions/v1/ingest_ttn
 *   Headers   : Authorization: Bearer <supabase-anon-key>
 *   Messages  : ✅ Uplink message
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const uplink = body?.uplink_message as Record<string, unknown> | undefined;
  if (!uplink) {
    return new Response("Missing uplink_message field", { status: 400 });
  }

  const decoded = uplink?.decoded_payload as Record<string, unknown> | undefined;
  if (!decoded || Object.keys(decoded).length === 0) {
    return new Response("decoded_payload is empty — check your TTN payload formatter", { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Look up device_id from devices table using the MAC address in the payload
  const mac = (decoded.mac as string | undefined)?.replaceAll(":", "");
  if (!mac) {
    return new Response("decoded_payload missing mac field", { status: 400 });
  }

  const { data: device, error: deviceError } = await supabase
    .from("devices")
    .select("id")
    .eq("device_mac", mac)
    .single();

  if (deviceError || !device) {
    console.error("Device lookup error:", deviceError);
    return new Response(`Device not found for MAC ${mac}`, { status: 404 });
  }

  const row = {
    device_id:     device.id,
    boot:          decoded.boot                                ?? null,
    battery:       decoded.battery_v                          ?? null,
    temp_c:        decoded.temp_c                             ?? null,
    humidity:      decoded.humidity                           ?? null,
    pressure_pa:   decoded.pressure_pa                        ?? null,
    windSpeed:     decoded.windspeed_mps                      ?? null,
    rfid:          decoded.rfid                               ?? null,
    filter_status: decoded.filter_ok === true ? "Success" : "Fail",
    recorded_at:   uplink?.received_at ?? new Date().toISOString(),
  };

  const { error: insertError } = await supabase
    .from("sensor_logs")
    .insert(row);

  if (insertError) {
    console.error("Supabase insert error:", insertError);
    return new Response(`DB insert failed: ${insertError.message}`, { status: 500 });
  }

  // Bandwidth-limited LoRaWAN devices send MFCC (mel-frequency cepstral
  // coefficient) features instead of a raw audio file — see the formatter's
  // `mfcc` field, 13 floats. One row per device (its primary key is the MAC),
  // overwritten on every uplink; audio_logs.device_id stores the MAC as
  // text, not the devices.id uuid. Best-effort: a bad/missing mfcc field
  // shouldn't fail the sensor-data write above, which already succeeded.
  const mfcc = decoded.mfcc as number[] | undefined;
  if (Array.isArray(mfcc) && mfcc.length > 0) {
    const { error: audioError } = await supabase
      .from("audio_logs")
      .upsert(
        { device_id: mac, is_lora: true, mfcc_coefficients: mfcc, storage_path: null, updated_at: new Date().toISOString() },
        { onConflict: "device_id" },
      );
    if (audioError) console.error("audio_logs upsert error:", audioError);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});