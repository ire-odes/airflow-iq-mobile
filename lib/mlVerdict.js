// Acoustic ML verdict — written by an external inference poller
// (ML/service/poll_and_infer.py, service-role only) into
// audio_logs.latest_verdict / latest_confidence. See
// supabase/migrations/20260731000000_ml_inference.sql and
// web/src/lib/audioRecordings.js (the web app's equivalent, which also
// surfaces the playable recording — this mobile helper only needs the
// verdict for the Devices list badge).
//
// A device has no verdict until the poller has processed at least one of
// its uploads (or ever, for LoRa devices, which aren't handled by the
// poller yet) — callers should treat null as "not yet classified", not
// an error.
import { supabase } from "./supabase";

// Returns null if there's no verdict yet, otherwise { verdict, confidence, updatedAt }.
export async function getLatestVerdict(deviceMac) {
  if (!deviceMac) return null;
  const { data, error } = await supabase
    .from("audio_logs")
    .select("latest_verdict, latest_confidence, updated_at")
    .eq("device_id", deviceMac)
    .maybeSingle();
  if (error || !data || !data.latest_verdict) return null;
  return {
    verdict: data.latest_verdict,
    confidence: data.latest_confidence,
    updatedAt: data.updated_at,
  };
}
