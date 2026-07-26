// ============================================================================
// Acoustic analysis — MOCK DATA
//
// Everything in this file is placeholder. The real pipeline will upload a
// recording from the device, run an ML model server-side, and store the
// verdict + features. Until then we synthesize an HVAC-ish audio buffer in the
// browser so the player, scrubber and waveform are genuinely functional, and
// pair it with hard-coded feature values.
//
// To swap in real data later, replace `getRecordings()` with a Supabase query
// and feed the returned audio URL into an <audio> element instead of the
// Web Audio buffer built here.
// ============================================================================

// Deterministic PRNG so a given recording always renders the same waveform.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const VERDICTS = {
  clean: {
    key: "clean",
    label: "Clean",
    color: "#22c55e",
    summary: "Airflow signature is smooth and within the expected band for this duct geometry.",
  },
  partial: {
    key: "partial",
    label: "Partially Restricted",
    color: "#f59e0b",
    summary: "Mid-band turbulence is elevated. Early sign of loading — worth a visual check.",
  },
  clogged: {
    key: "clogged",
    label: "Clogged",
    color: "#ef4444",
    summary: "Broadband hiss and high-frequency energy indicate significant restriction. Replace the filter.",
  },
};

// The spectral features the ML model will eventually output.
// `key` matches what the feature extractor will emit.
export const FEATURE_DEFS = [
  { key: "spectral_centroid",   label: "Spectral Centroid",       unit: " Hz", decimals: 2, hint: "Brightness — the energy-weighted mean frequency. Rises as a filter loads up." },
  { key: "spectral_rolloff",    label: "Spectral Rolloff",        unit: " Hz", decimals: 2, hint: "Frequency below which 85% of the spectral energy sits." },
  { key: "low_freq_ratio",      label: "Low Frequency Energy Ratio", unit: "", decimals: 3, hint: "Share of total energy under 500 Hz. Drops when airflow is restricted." },
  { key: "spectral_flatness",   label: "Spectral Flatness",       unit: "",    decimals: 3, hint: "How noise-like vs. tonal the signal is. 1.0 is pure white noise." },
  { key: "zero_crossing_rate",  label: "Zero Crossing Rate",      unit: "",    decimals: 4, hint: "Rate of sign changes in the waveform. Correlates with hiss." },
  { key: "rms_energy",          label: "RMS Energy",              unit: " dB", decimals: 2, hint: "Overall loudness of the recording." },
  { key: "spectral_bandwidth",  label: "Spectral Bandwidth",      unit: " Hz", decimals: 2, hint: "Spread of the spectrum around its centroid." },
  { key: "mfcc_1",              label: "MFCC-1",                  unit: "",    decimals: 3, hint: "First mel-frequency cepstral coefficient — coarse spectral shape." },
];

// ── Mock recording set ───────────────────────────────────────────────────────
// Ordered newest first. `seed` drives the synthesized audio + waveform.
const RECORDINGS = [
  {
    id: "rec_003",
    recorded_at: hoursAgo(3),
    duration: 12,
    seed: 20260725,
    verdict: "clean",
    confidence: 0.94,
    features: {
      spectral_centroid: 1284.37,
      spectral_rolloff: 2610.88,
      low_freq_ratio: 0.612,
      spectral_flatness: 0.184,
      zero_crossing_rate: 0.0817,
      rms_energy: -28.44,
      spectral_bandwidth: 1103.52,
      mfcc_1: -412.06,
    },
  },
  {
    id: "rec_002",
    recorded_at: hoursAgo(27),
    duration: 12,
    seed: 771123,
    verdict: "partial",
    confidence: 0.81,
    features: {
      spectral_centroid: 1946.15,
      spectral_rolloff: 3877.41,
      low_freq_ratio: 0.438,
      spectral_flatness: 0.291,
      zero_crossing_rate: 0.1264,
      rms_energy: -25.19,
      spectral_bandwidth: 1462.08,
      mfcc_1: -368.72,
    },
  },
  {
    id: "rec_001",
    recorded_at: hoursAgo(51),
    duration: 12,
    seed: 55098,
    verdict: "clogged",
    confidence: 0.89,
    features: {
      spectral_centroid: 2733.60,
      spectral_rolloff: 5218.93,
      low_freq_ratio: 0.287,
      spectral_flatness: 0.406,
      zero_crossing_rate: 0.1938,
      rms_energy: -21.73,
      spectral_bandwidth: 1890.44,
      mfcc_1: -297.51,
    },
  },
];

function hoursAgo(h) {
  return new Date(Date.now() - h * 3600000).toISOString();
}

// Returns the mock recordings for a device. Device id is accepted (and used to
// jitter the seed) purely so different devices look different in the demo.
export function getRecordings(deviceId) {
  const jitter = String(deviceId || "")
    .split("")
    .reduce((acc, ch) => (acc + ch.charCodeAt(0)) % 9973, 0);
  return RECORDINGS.map((r) => ({ ...r, seed: r.seed + jitter }));
}

// ── Synthesized audio ────────────────────────────────────────────────────────
// Builds an HVAC-like sound: a low rumble plus filtered noise. "Clogged"
// recordings get more high-frequency hiss so the three clips audibly differ.
export function buildAudioBuffer(audioCtx, recording) {
  const sampleRate = audioCtx.sampleRate;
  const length = Math.floor(sampleRate * recording.duration);
  const buffer = audioCtx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const rand = mulberry32(recording.seed);

  // Higher = more broadband hiss, less low-end.
  const restriction =
    recording.verdict === "clogged" ? 0.85 : recording.verdict === "partial" ? 0.5 : 0.18;

  // One-pole low-pass state, plus its complement for the hiss component.
  let lp = 0;
  const lpCoeff = 0.02 + 0.16 * restriction; // brighter as restriction rises

  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const white = rand() * 2 - 1;

    lp += lpCoeff * (white - lp);
    const rumbleNoise = lp * (1.1 - restriction * 0.55);
    const hiss = (white - lp) * (0.12 + restriction * 0.42);

    // Blower fundamental + a couple of harmonics, amplitude-wobbled.
    const fan =
      0.16 * Math.sin(2 * Math.PI * 58 * t) +
      0.07 * Math.sin(2 * Math.PI * 116 * t) +
      0.03 * Math.sin(2 * Math.PI * 174 * t);
    const wobble = 1 + 0.06 * Math.sin(2 * Math.PI * 0.7 * t);

    // Short fade in/out so playback doesn't click.
    const fadeSamples = sampleRate * 0.15;
    const fade = Math.min(1, i / fadeSamples, (length - i) / fadeSamples);

    data[i] = (rumbleNoise + hiss + fan * wobble) * 0.55 * fade;
  }

  return buffer;
}

// Downsamples a buffer to `bins` peak amplitudes for waveform rendering.
export function computePeaks(buffer, bins = 220) {
  const data = buffer.getChannelData(0);
  const blockSize = Math.floor(data.length / bins);
  const peaks = new Array(bins);
  let max = 0;

  for (let b = 0; b < bins; b++) {
    const start = b * blockSize;
    let peak = 0;
    for (let i = 0; i < blockSize; i++) {
      const v = Math.abs(data[start + i]);
      if (v > peak) peak = v;
    }
    peaks[b] = peak;
    if (peak > max) max = peak;
  }

  // Normalise to 0..1 so the waveform always fills its box.
  return max > 0 ? peaks.map((p) => p / max) : peaks;
}
