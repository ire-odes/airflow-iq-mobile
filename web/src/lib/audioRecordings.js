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

// ── Frequency spectrum (real FFT of the decoded recording) ──────────────────
// In-house radix-2 Cooley-Tukey FFT -- no DSP library in this project, and
// this is the only place that needs one. Operates on parallel re/im arrays
// in place, length must be a power of 2.
function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;
  const half = n / 2;
  const evenRe = new Float64Array(half), evenIm = new Float64Array(half);
  const oddRe = new Float64Array(half), oddIm = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    evenRe[i] = re[2 * i]; evenIm[i] = im[2 * i];
    oddRe[i] = re[2 * i + 1]; oddIm[i] = im[2 * i + 1];
  }
  fft(evenRe, evenIm);
  fft(oddRe, oddIm);
  for (let k = 0; k < half; k++) {
    const angle = (-2 * Math.PI * k) / n;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const tRe = cos * oddRe[k] - sin * oddIm[k];
    const tIm = sin * oddRe[k] + cos * oddIm[k];
    re[k] = evenRe[k] + tRe;
    im[k] = evenIm[k] + tIm;
    re[k + half] = evenRe[k] - tRe;
    im[k + half] = evenIm[k] - tIm;
  }
}

const nextPow2 = (n) => 1 << Math.ceil(Math.log2(n));

// Magnitude spectrum (in dB) of a decoded AudioBuffer, log-frequency-binned
// so low-frequency HVAC content isn't crushed into a couple of pixels next
// to a long, mostly-empty high-frequency tail. Uses Welch's method (Hann-
// windowed, 50%-overlapping frames, averaged) for a stable estimate from a
// single short clip rather than one noisy full-length transform. Real FFT
// of the actual recording -- nothing here is simulated or guessed.
export function computeSpectrum(buffer, { frameSize = 2048, bins = 72, fMin = 20 } = {}) {
  const data = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const nyquist = sampleRate / 2;

  const n = nextPow2(frameSize);
  const hop = Math.floor(n / 2);
  const window = new Float64Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));

  const accum = new Float64Array(n / 2);
  let frames = 0;

  for (let start = 0; start + n <= data.length; start += hop) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = data[start + i] * window[i];
    fft(re, im);
    for (let k = 0; k < n / 2; k++) accum[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  if (frames === 0) return [];

  const logMin = Math.log10(Math.max(fMin, 1));
  const logMax = Math.log10(nyquist);
  const out = [];
  for (let b = 0; b < bins; b++) {
    const f0 = Math.pow(10, logMin + ((logMax - logMin) * b) / bins);
    const f1 = Math.pow(10, logMin + ((logMax - logMin) * (b + 1)) / bins);
    const k0 = Math.max(0, Math.floor((f0 / nyquist) * (n / 2)));
    const k1 = Math.min(n / 2, Math.ceil((f1 / nyquist) * (n / 2)));
    let sum = 0, count = 0;
    for (let k = k0; k < k1; k++) { sum += accum[k]; count++; }
    const mag = count > 0 ? sum / count / frames : 0;
    out.push({ freq: Math.round((f0 + f1) / 2), db: Math.max(20 * Math.log10(mag + 1e-9), -100) });
  }
  return out;
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
