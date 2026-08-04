// Real acoustic recordings — reads from audio_logs + the private
// hvac-recordings Storage bucket (see
// supabase/migrations/20260728030000_audio_logs_rls.sql for the access
// rules: owner, landlord-wide technician, or property-level technician).
//
// audio_logs has one row per device (its primary key is device_id, the
// device's MAC address) and the ingestion pipeline overwrites it on every
// new recording — there is no history to browse, only "latest."
//
// Two ingestion paths, distinguished by is_lora:
//   - WiFi devices upload a real .wav file; storage_path points to it.
//   - LoRaWAN devices can't fit audio over that link, so they send MFCC
//     (mel-frequency cepstral coefficient) features instead — there is no
//     playable audio for these, only the numeric feature vector.
//
// ML classification lives in filter_ml_readings — a separate pipeline (a
// desktop script polling audio_logs, running the model, writing results
// back) populates it; nothing in this repo writes to it. Keyed by
// device_mac + recorded_at, so unlike audio_logs it can hold real history —
// this only ever reads the latest one, to pair with the latest recording.
import { supabase } from "./supabase";

const SIGNED_URL_TTL_SECONDS = 600;

async function getLatestClassification(deviceMac) {
  const { data, error } = await supabase
    .from("filter_ml_readings")
    .select("classifier_label, classifier_confidence, decision, mahalanobis_distance, ewma_value, disagreement_flag, recorded_at")
    .eq("device_mac", deviceMac)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

// Returns null if there's no recording yet, otherwise:
//   { kind: "audio", updatedAt, url, classification }   — WiFi device, playable
//   { kind: "lora",  updatedAt, mfcc, classification }  — LoRaWAN device, features only
// `classification` is null when the desktop pipeline hasn't scored this
// device yet — never fabricated.
export async function getLatestRecording(deviceMac) {
  if (!deviceMac) return null;

  const { data: row, error } = await supabase
    .from("audio_logs")
    .select("device_id, is_lora, storage_path, mfcc_coefficients, updated_at")
    .eq("device_id", deviceMac)
    .maybeSingle();

  if (error || !row) return null;

  const classification = await getLatestClassification(deviceMac);

  if (row.is_lora) {
    return { kind: "lora", updatedAt: row.updated_at, mfcc: row.mfcc_coefficients, classification };
  }

  if (!row.storage_path) return null;

  const { data: signed, error: signError } = await supabase
    .storage.from("hvac-recordings")
    .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);

  if (signError || !signed?.signedUrl) return null;

  return { kind: "audio", updatedAt: row.updated_at, url: signed.signedUrl, classification };
}

// Downsamples a decoded AudioBuffer to `bins` peak amplitudes for waveform rendering.
export function computePeaks(buffer, bins = 220) {
  const data = buffer.getChannelData(0);
  const blockSize = Math.floor(data.length / bins) || 1;
  const peaks = new Array(bins);
  let max = 0;

  for (let b = 0; b < bins; b++) {
    const start = b * blockSize;
    let peak = 0;
    for (let i = 0; i < blockSize && start + i < data.length; i++) {
      const v = Math.abs(data[start + i]);
      if (v > peak) peak = v;
    }
    peaks[b] = peak;
    if (peak > max) max = peak;
  }

  return max > 0 ? peaks.map((p) => p / max) : peaks;
}

// Flattens mfcc_coefficients into one representative array for a simple bar
// chart. Tolerant of shape because no real LoRa row has been observed yet
// (0 exist in production as of this writing) — could be a flat array of
// numbers, or an array of per-frame arrays.
export function normalizeMfcc(mfcc) {
  if (!Array.isArray(mfcc) || mfcc.length === 0) return null;
  const first = mfcc[0];
  if (Array.isArray(first)) {
    const n = first.length;
    const sums = new Array(n).fill(0);
    mfcc.forEach((frame) => frame.forEach((v, i) => { sums[i] += Number(v) || 0; }));
    return sums.map((s) => s / mfcc.length);
  }
  if (typeof first === "number") return mfcc.map(Number);
  return null;
}
