// Acoustic ML verdict — written by an external inference poller
// (ML/service/poll_and_infer.py, service-role only) into filter_ml_readings,
// keyed by device_mac + recorded_at (real history, unlike audio_logs which
// is one row per device overwritten on every upload). Matches
// web/src/lib/audioRecordings.js's getLatestClassification -- this mobile
// helper only needs the latest one, for the Devices list badge.
//
// verdict is one of:
//   "calibrating" -- device hasn't finished its acoustic warmup yet. The
//     classifier alone is known to misfire on a brand-new environment (a
//     real device called 100% of a real house's clean readings "dirty"),
//     so its raw opinion is never surfaced as a verdict during this phase.
//   "clean" | "dirty" -- a real verdict, from drift once warm (or from the
//     classifier only very early on).
// Returns null if there's no reading yet at all (or ever, for LoRa devices,
// not handled by the poller yet) -- callers should treat that as "not yet
// classified", not an error.
import { supabase } from "./supabase";

// Returns null, or { verdict, confidence, updatedAt }. confidence is the
// classifier's own P(dirty), not necessarily "confidence in this verdict"
// -- the verdict itself usually comes from drift once a device is warm.
export async function getLatestVerdict(deviceMac) {
  if (!deviceMac) return null;
  const { data, error } = await supabase
    .from("filter_ml_readings")
    .select("decision, classifier_confidence, recorded_at")
    .eq("device_mac", deviceMac)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    verdict: data.decision,
    confidence: data.classifier_confidence,
    updatedAt: data.recorded_at,
  };
}
