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

/**
 * Pushes the device's configured sample slot back as a LoRaWAN downlink.
 *
 * LoRaWAN devices can't fetch config the way WiFi devices poll
 * devices.effective_wake_seconds over REST -- they have no IP -- so
 * settings have to ride a downlink. Downlinks can only be *queued*; the
 * network delivers one in the RX window that follows an uplink, which is
 * why this runs here rather than on a timer.
 *
 * "replace" rather than "push" deliberately: the queue should hold at most
 * the current desired slot. Pushing would let stale values pile up behind
 * a device that was offline and deliver a whole backlog when it returns.
 *
 * Best-effort. The sensor data is already written by the time this runs
 * and matters more than the config echo, so every failure path here logs
 * and returns instead of throwing. Silently disabled when the TTN env vars
 * aren't set, so existing deployments keep working untouched.
 */
async function queueSlotDownlink(devEui: string, slotSeconds: number) {
  const apiKey = Deno.env.get("TTN_API_KEY");
  const appId = Deno.env.get("TTN_APP_ID");
  const region = Deno.env.get("TTN_REGION") ?? "nam1";
  const fPort = Number(Deno.env.get("TTN_CONFIG_FPORT") ?? "10");

  if (!apiKey || !appId) return; // not configured -- nothing to do

  // 4-byte big-endian seconds. Fixed width keeps the device-side decode a
  // couple of shifts with no length handling, and 32 bits is far more than
  // any sane slot needs.
  const payload = new Uint8Array([
    (slotSeconds >>> 24) & 0xff,
    (slotSeconds >>> 16) & 0xff,
    (slotSeconds >>> 8) & 0xff,
    slotSeconds & 0xff,
  ]);
  const frmPayload = btoa(String.fromCharCode(...payload));

  const url = `https://${region}.cloud.thethings.network/api/v3/as/applications/` +
    `${appId}/devices/${devEui}/down/replace`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        downlinks: [{
          f_port: fPort,
          frm_payload: frmPayload,
          priority: "LOW", // config, not an alarm -- never displace real traffic
        }],
      }),
    });
    if (!res.ok) {
      console.error("TTN downlink queue failed:", res.status, await res.text());
    }
  } catch (e) {
    console.error("TTN downlink queue error:", e);
  }
}

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
    .select("id, sample_slot_seconds")
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

  // Queue the sampling slot for this device. The device id TTN addresses is
  // the end-device id from the uplink envelope, which is not necessarily the
  // MAC in the payload, so take it from end_device_ids rather than reusing
  // `mac`. Skipped entirely when no slot is configured, leaving the device
  // on its compiled-in default.
  const endDeviceIds = body?.end_device_ids as Record<string, unknown> | undefined;
  const ttnDeviceId = endDeviceIds?.device_id as string | undefined;
  const slot = device.sample_slot_seconds as number | null;
  if (ttnDeviceId && typeof slot === "number" && slot > 0) {
    await queueSlotDownlink(ttnDeviceId, slot);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});