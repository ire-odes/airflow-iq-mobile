import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Icon from "./Icon";
import { useTheme } from "../context/ThemeContext";
import { formatSeconds, timeAgo, formatTimestamp } from "../lib/format";
import { getLatestRecording, computePeaks, computeSpectrum, normalizeMfcc } from "../lib/audioRecordings";

// ============================================================================
// Acoustic Data — real recordings from audio_logs / hvac-recordings storage,
// paired with real classifier output from filter_ml_readings when a device
// has been scored (a separate pipeline — not this repo — writes those rows).
// Three states, never a guess in place of the honest one:
//   no classification row yet -> "Not yet classified"
//   decision === "calibrating" -> device hasn't finished its acoustic
//     warmup; the classifier's raw opinion is known to misfire on a new
//     environment, so it's deliberately never shown as a verdict here
//   decision === "clean" | "dirty" -> a real verdict, from drift once the
//     device is warm (or from the classifier only very early on)
// See lib/audioRecordings.js for the data shape and the WiFi-audio vs.
// LoRaWAN-MFCC split.
// ============================================================================

const WAVE_BINS = 190;
const TRIM_LEADING_SECONDS = 0.05; // drop the mic-startup click at the very start of the clip

// The spectrum chart is deliberately cropped to this range, not the full
// 20 Hz-8 kHz computeSpectrum() produces. Real evidence, not a guess:
//   - low_freq_energy_ratio (one of the 5 features the drift baseline is
//     actually built on) is defined as exactly the 20-500 Hz energy
//     fraction (ML/extract_features_v2.py)
//   - the classifier's 3 highest-importance features of all 128 are the
//     lowest-index FFT bands, landing at ~70-230 Hz
//   - the lab clean-vs-dirty frequency study found its largest effect
//     sizes (Cohen's d) clustered at 46-358 Hz, dwarfing a much smaller
//     secondary cluster around 900-1000 Hz that isn't included here to
//     keep this a single clean range rather than two clusters with a gap
// With computeSpectrum's log-spaced binning, ~39 of its 72 bins already
// fall in this range -- plenty dense for a bar view, no resolution change
// needed upstream.
const ISOLATED_BAND_MAX_HZ = 500;

// Returns a new AudioBuffer with the first `seconds` removed from every
// channel — used once, right after decode, so the waveform, duration, and
// playback all agree on the trimmed clip.
function trimBufferStart(ctx, buffer, seconds) {
  const trimSamples = Math.min(Math.floor(seconds * buffer.sampleRate), buffer.length - 1);
  if (trimSamples <= 0) return buffer;
  const trimmed = ctx.createBuffer(buffer.numberOfChannels, buffer.length - trimSamples, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    trimmed.getChannelData(ch).set(buffer.getChannelData(ch).subarray(trimSamples));
  }
  return trimmed;
}

export default function AcousticPanel({ deviceMac, deviceName }) {
  const { theme } = useTheme();

  const [recording, setRecording] = useState(undefined); // undefined = loading, null = none
  const [loadError, setLoadError] = useState(null);

  const [peaks, setPeaks] = useState([]);
  const [spectrum, setSpectrum] = useState([]);
  const [duration, setDuration] = useState(0);
  const [audioLoading, setAudioLoading] = useState(false);
  const [audioError, setAudioError] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const ctxRef = useRef(null);
  const gainRef = useRef(null);
  const bufferRef = useRef(null);
  const sourceRef = useRef(null);
  const startedAtRef = useRef(0);
  const offsetRef = useRef(0);
  const rafRef = useRef(null);
  const stoppingRef = useRef(false);

  const stopSource = useCallback(() => {
    stoppingRef.current = true;
    try { sourceRef.current?.stop(); } catch { /* already stopped */ }
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    stoppingRef.current = false;
    cancelAnimationFrame(rafRef.current);
  }, []);

  // Fetch the audio_logs row (and mint a signed URL, if applicable) whenever
  // the device changes.
  useEffect(() => {
    let cancelled = false;
    setRecording(undefined);
    setLoadError(null);
    (async () => {
      if (!deviceMac) { if (!cancelled) setRecording(null); return; }
      try {
        const rec = await getLatestRecording(deviceMac);
        if (!cancelled) setRecording(rec);
      } catch (e) {
        if (!cancelled) { setLoadError(e.message || "Couldn't load recording"); setRecording(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [deviceMac]);

  // Fetch + decode the actual audio once we know there's a playable recording.
  useEffect(() => {
    let cancelled = false;

    if (!ctxRef.current) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (Ctor) {
        ctxRef.current = new Ctor();
        gainRef.current = ctxRef.current.createGain();
        gainRef.current.gain.value = 0.55;
        gainRef.current.connect(ctxRef.current.destination);
      }
    }

    stopSource();
    setPlaying(false);
    setElapsed(0);
    offsetRef.current = 0;
    setPeaks([]);
    setSpectrum([]);
    setDuration(0);
    setAudioError(null);
    bufferRef.current = null;

    if (recording?.kind !== "audio" || !ctxRef.current) return;

    setAudioLoading(true);
    (async () => {
      try {
        const res = await fetch(recording.url);
        if (!res.ok) throw new Error(`Recording fetch failed (${res.status})`);
        const arrayBuf = await res.arrayBuffer();
        const decoded = await ctxRef.current.decodeAudioData(arrayBuf);
        const buffer = trimBufferStart(ctxRef.current, decoded, TRIM_LEADING_SECONDS);
        if (cancelled) return;
        bufferRef.current = buffer;
        setPeaks(computePeaks(buffer, WAVE_BINS));
        setSpectrum(computeSpectrum(buffer));
        setDuration(buffer.duration);
      } catch (e) {
        if (!cancelled) setAudioError(e.message || "Couldn't load recording");
      }
      if (!cancelled) setAudioLoading(false);
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, stopSource]);

  useEffect(() => () => {
    stopSource();
    ctxRef.current?.close();
    ctxRef.current = null;
  }, [stopSource]);

  const tick = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const t = offsetRef.current + (ctx.currentTime - startedAtRef.current);
    setElapsed(Math.min(t, duration));
    rafRef.current = requestAnimationFrame(tick);
  }, [duration]);

  const playFrom = useCallback(async (offset) => {
    const ctx = ctxRef.current;
    if (!ctx || !bufferRef.current) return;
    if (ctx.state === "suspended") await ctx.resume();

    stopSource();

    const src = ctx.createBufferSource();
    src.buffer = bufferRef.current;
    src.connect(gainRef.current);
    src.onended = () => {
      if (stoppingRef.current) return;
      setPlaying(false);
      setElapsed(0);
      offsetRef.current = 0;
      cancelAnimationFrame(rafRef.current);
    };

    offsetRef.current = offset;
    startedAtRef.current = ctx.currentTime;
    src.start(0, offset);
    sourceRef.current = src;

    setPlaying(true);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [stopSource, tick]);

  const togglePlay = () => {
    if (playing) {
      const ctx = ctxRef.current;
      const t = offsetRef.current + (ctx.currentTime - startedAtRef.current);
      stopSource();
      offsetRef.current = Math.min(t, duration);
      setElapsed(offsetRef.current);
      setPlaying(false);
    } else {
      playFrom(offsetRef.current >= duration ? 0 : offsetRef.current);
    }
  };

  const restart = () => {
    offsetRef.current = 0;
    setElapsed(0);
    if (playing) playFrom(0);
  };

  const seek = (e) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const target = ratio * duration;
    offsetRef.current = target;
    setElapsed(target);
    if (playing) playFrom(target);
  };

  const progress = duration ? elapsed / duration : 0;
  const mfccBars = useMemo(
    () => (recording?.kind === "lora" ? normalizeMfcc(recording.mfcc) : null),
    [recording]
  );
  // See ISOLATED_BAND_MAX_HZ's comment for why this range specifically.
  const isolatedSpectrum = useMemo(
    () => spectrum.filter((p) => p.freq <= ISOLATED_BAND_MAX_HZ),
    [spectrum]
  );

  const classification = recording?.classification || null;
  // "calibrating" means the device hasn't finished its acoustic warmup --
  // the classifier alone is unreliable on a brand-new environment (a real
  // device called 100% of a real house's clean readings "dirty"), so its
  // raw opinion is never surfaced as a verdict until drift takes over.
  const isCalibrating = classification?.decision === "calibrating";
  const isDirty = classification?.decision === "dirty";
  // classifier_confidence is the classifier's own P(dirty) specifically --
  // labeled as such rather than implied to be "confidence in this verdict",
  // since once a device is WARM the verdict usually comes from drift, not
  // the classifier.
  const confidencePct = classification?.classifier_confidence != null
    ? Math.round(classification.classifier_confidence * 100)
    : null;
  const hasDisagreement = !isCalibrating && !!classification?.disagreement_flag
    && !["none", "false", "no"].includes(String(classification.disagreement_flag).toLowerCase());

  return (
    <section className="card card-pad card-lift" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="property-icon"><Icon name="waveform" size={18} /></div>
        <div className="grow">
          <h3 className="section-title">Acoustic Data</h3>
          <p className="section-sub">
            {deviceName ? `${deviceName} · ` : ""}
            {recording?.updatedAt ? `Recorded ${timeAgo(recording.updatedAt)}` : "No device selected"}
          </p>
        </div>
        {recording && (
          isCalibrating ? (
            <span className="badge" style={{ background: "#6366f11f", color: "#6366f1" }}>
              <Icon name="pulse" size={11} /> Calibrating…
            </span>
          ) : classification ? (
            <span
              className="badge"
              style={{ background: isDirty ? "#ef44441f" : "#22c55e1f", color: isDirty ? "#ef4444" : "#22c55e" }}
              title={
                `${classification.classifier_label} · clf ${confidencePct}% dirty · ${timeAgo(classification.recorded_at)}`
                + (hasDisagreement ? ` · flagged: ${classification.disagreement_flag}` : "")
              }
            >
              <Icon name={isDirty ? "warning" : "success"} size={11} />
              {isDirty ? "Filter Dirty" : "Filter Clean"}
            </span>
          ) : (
            <span className="badge" style={{ background: "#6366f11f", color: "#6366f1" }}>
              <Icon name="info" size={11} /> Not yet classified
            </span>
          )
        )}
      </div>

      {isCalibrating && (
        <div className="banner" style={{ background: "var(--inputBg)", borderColor: "var(--border)" }}>
          <Icon name="pulse" size={16} style={{ color: "var(--subtext)" }} />
          <span className="grow">
            Learning this device's normal acoustic signature — verdicts appear once it's
            collected enough readings. This can take a while after a device is claimed, moved,
            or recalibrated.
          </span>
        </div>
      )}

      {!deviceMac ? (
        <div className="empty" style={{ padding: "28px 20px" }}>
          <div className="empty-icon"><Icon name="waveform" size={22} /></div>
          <p style={{ fontWeight: 700, color: "var(--text)" }}>Select a device</p>
          <p className="hint">Acoustic data is per-device — pick one to see its latest recording.</p>
        </div>
      ) : recording === undefined ? (
        <div className="skel" style={{ height: 108, borderRadius: 14 }} />
      ) : loadError ? (
        <div className="banner" style={{ background: "#ef44441a", borderColor: "#ef444455", color: "#ef4444" }}>
          <Icon name="alert" size={17} />
          <span className="grow">{loadError}</span>
        </div>
      ) : !recording ? (
        <div className="empty" style={{ padding: "28px 20px" }}>
          <div className="empty-icon"><Icon name="waveform" size={22} /></div>
          <p style={{ fontWeight: 700, color: "var(--text)" }}>No recording yet</p>
          <p className="hint">This device hasn't uploaded an acoustic sample.</p>
        </div>
      ) : recording.kind === "lora" ? (
        <>
          <div className="banner" style={{ background: "var(--inputBg)", borderColor: "var(--border)" }}>
            <Icon name="info" size={16} style={{ color: "var(--subtext)" }} />
            <span className="hint">
              This device reports over a bandwidth-limited LoRaWAN connection, so raw audio
              isn't transmitted — only compact frequency-domain (MFCC) features.
            </span>
          </div>
          {mfccBars ? (
            <div>
              <div className="field-label" style={{ marginBottom: 8 }}>MFCC FEATURE VECTOR</div>
              <div className="row" style={{ alignItems: "flex-end", gap: 3, height: 70 }}>
                {mfccBars.map((v, i) => {
                  const max = Math.max(...mfccBars.map(Math.abs)) || 1;
                  const h = Math.max(3, (Math.abs(v) / max) * 70);
                  return (
                    <div
                      key={i}
                      title={`#${i + 1}: ${v.toFixed(3)}`}
                      style={{ flex: 1, height: h, borderRadius: 3, background: "var(--accent)", opacity: 0.75 }}
                    />
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="hint">Feature data is present but in an unrecognized format.</p>
          )}
        </>
      ) : (
        <>
          {audioLoading ? (
            <div className="skel" style={{ height: 108, borderRadius: 13 }} />
          ) : audioError ? (
            <div className="banner" style={{ background: "#ef44441a", borderColor: "#ef444455", color: "#ef4444" }}>
              <Icon name="alert" size={17} />
              <span className="grow">{audioError}</span>
            </div>
          ) : (
            <div>
              <div
                className="waveform"
                onClick={seek}
                role="slider"
                aria-label="Seek recording"
                aria-valuenow={Math.round(progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                tabIndex={0}
              >
                <svg viewBox={`0 0 ${WAVE_BINS} 100`} preserveAspectRatio="none">
                  {peaks.map((p, i) => {
                    const h = Math.max(2, p * 88);
                    const played = i / WAVE_BINS <= progress;
                    return (
                      <rect
                        key={i}
                        x={i + 0.18}
                        y={(100 - h) / 2}
                        width={0.64}
                        height={h}
                        rx={0.3}
                        fill={played ? theme.accent : theme.subtext}
                        opacity={played ? 0.95 : 0.34}
                      />
                    );
                  })}
                </svg>
                <div className="waveform-playhead" style={{ left: `${progress * 100}%` }} />
              </div>

              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btn-primary btn-icon" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
                  <Icon name={playing ? "pause" : "play"} size={17} />
                </button>
                <button className="btn btn-icon" onClick={restart} aria-label="Restart">
                  <Icon name="restart" size={16} />
                </button>
                <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: "var(--subtext)" }}>
                  {formatSeconds(elapsed)} / {formatSeconds(duration)}
                </span>
                <span className="grow" />
                <span className="hint" style={{ fontSize: 11.5 }}>{formatTimestamp(recording.updatedAt)}</span>
              </div>

              {isolatedSpectrum.length > 0 && (
                <div style={{ marginTop: 18 }}>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <div
                      className="field-label grow"
                      title="Cropped to 20-500 Hz on purpose: this is where the classifier's top features, the strongest lab clean-vs-dirty effect sizes, and low_freq_energy_ratio (one of the 5 features the drift baseline is built on) all concentrate -- see ISOLATED_BAND_MAX_HZ in this file."
                    >
                      FREQUENCY SPECTRUM · 20–500 Hz
                    </div>
                    <span
                      className="hint"
                      style={{ fontSize: 10.5 }}
                      title="No historical spectrum is stored for this device yet, so there's nothing real to compare against -- audio_logs only ever holds the latest recording, not a history."
                    >
                      baseline not available yet
                    </span>
                  </div>
                  <ResponsiveContainer width="100%" height={190}>
                    <BarChart data={isolatedSpectrum} barCategoryGap="12%" margin={{ top: 4, right: 8, left: 0, bottom: 18 }}>
                      <defs>
                        <linearGradient id="spectrumFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={theme.accent} stopOpacity={0.95} />
                          <stop offset="100%" stopColor={theme.accent} stopOpacity={0.45} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="4 4" stroke={theme.divider} vertical={false} />
                      <XAxis
                        dataKey="freq" tickLine={false} axisLine={{ stroke: theme.divider }}
                        tick={{ fill: theme.subtext, fontSize: 10, fontWeight: 600 }}
                        tickFormatter={(f) => (f >= 1000 ? `${(f / 1000).toFixed(1)}k` : f)}
                        minTickGap={24}
                        label={{ value: "Frequency (Hz)", position: "insideBottom", offset: -12, fill: theme.subtext, fontSize: 10.5, fontWeight: 600 }}
                      />
                      <YAxis
                        domain={[-100, 0]}
                        tick={{ fill: theme.subtext, fontSize: 10, fontWeight: 600 }}
                        tickLine={false} axisLine={false} width={46}
                        label={{ value: "Magnitude (dB)", angle: -90, position: "insideLeft", offset: 6, fill: theme.subtext, fontSize: 10.5, fontWeight: 600 }}
                      />
                      <Tooltip
                        cursor={{ fill: theme.divider, opacity: 0.3 }}
                        contentStyle={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 10, fontSize: 12 }}
                        formatter={(v) => [`${v.toFixed(1)} dB`, ""]}
                        labelFormatter={(f) => (f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f} Hz`)}
                      />
                      <Bar dataKey="db" fill="url(#spectrumFill)" isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
