import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Icon from "./Icon";
import { useTheme } from "../context/ThemeContext";
import { formatSeconds, timeAgo, formatTimestamp, durationSince } from "../lib/format";
import { getLatestRecording, getBaselineStatus, computePeaks, computeSpectrum, normalizeMfcc } from "../lib/audioRecordings";

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

// The spectrum chart is cropped to this range, not the full 20 Hz-8 kHz
// computeSpectrum() produces. The lower half of the range is still where the
// clean-vs-dirty evidence lives:
//   - low_freq_energy_ratio (one of the 5 features the drift baseline is
//     actually built on) is defined as exactly the 20-500 Hz energy
//     fraction (ML/extract_features_v2.py)
//   - the classifier's 3 highest-importance features of all 128 are the
//     lowest-index FFT bands, landing at ~70-230 Hz
//   - the lab clean-vs-dirty frequency study found its largest effect
//     sizes (Cohen's d) clustered at 46-358 Hz
//
// This was 500 Hz until 2026-10-06, chosen to keep one clean range and skip
// the lab study's smaller secondary cluster at 900-1000 Hz. Kannan House (P5)
// showed why that crop was too tight: a device mounted near a register hears
// AIRFLOW rather than motor rumble, and its blower-on signature is a hump at
// 500 Hz-2 kHz plus a narrow blade-pass tone at ~445 Hz -- +12.8 dB in the
// 500 Hz-1 kHz octave against ~0 dB below 60 Hz. At a 500 Hz crop that device's
// entire signature sat off the right edge of this chart. Abraham House (P3),
// mounted against the air handler, is the opposite: +24 dB below 60 Hz.
// 2 kHz covers both mountings and the secondary lab cluster, in one range.
//
// With computeSpectrum's log-spaced binning ~55 of its 72 bins fall in here,
// so it stays a dense bar view with no resolution change needed upstream.
const ISOLATED_BAND_MAX_HZ = 2000;

// Label for the crop, derived so the heading can't drift from the constant.
const ISOLATED_BAND_LABEL = `20–${
  ISOLATED_BAND_MAX_HZ >= 1000
    ? `${(ISOLATED_BAND_MAX_HZ / 1000).toFixed(ISOLATED_BAND_MAX_HZ % 1000 ? 1 : 0)} kHz`
    : `${ISOLATED_BAND_MAX_HZ} Hz`
}`;

// Silence gate -- the same decision the ML pipeline makes before a clip is
// allowed to reach a device's baseline. A gated clip produces no reading at
// all, which is why this panel can show a fresh recording while the
// baseline's count sits still. This tag is what explains that gap.
//
// The median is taken across ALL 72 bins computeSpectrum() returns, not the
// ISOLATED_BAND_MAX_HZ slice the chart draws, because that is what the
// pipeline does.
//
// WHICH CUT APPLIES IS PER DEVICE, AND THE SERVER DECIDES IT.
// This used to be one fleet-wide constant, 2.5 dB, measured on the lab rig.
// It is wrong for houses by about 20 dB: P5's clips sit at -20..-35 dB, so
// every single one rendered "Silent" here while the pipeline scored the same
// audio as blower-on. That is the identical error that discarded 82 of P3's
// consecutive wakes. device_baselines.gate_mode / .gate_boundary_db now carry
// the server's own rule (20261012010000_gate_mode.sql) and this panel defers
// to them:
//
//   gate_mode 'median' + a learned boundary -> compare against that boundary
//   gate_mode 'median', no boundary yet     -> the fleet fallback below,
//                                              labelled as provisional
//   gate_mode 'shape'                       -> SAY NOTHING. That rule needs
//     the clip's spectral shape (ML/blower_signature.py), which cannot be
//     recovered from the 72 bins a browser holds. Substituting a level test
//     is exactly the bug this replaces.
//
// One caveat, stated rather than hidden: the browser trims
// TRIM_LEADING_SECONDS off the front before analysing and the Python side
// does not, so the two can differ by a fraction of a dB.
const SILENCE_GATE_FALLBACK_DB = 2.5;


// (label, tone, explanation) for the blower tag, or null to show no tag.
function blowerTag(medianDb, gateMode, boundaryDb) {
  if (medianDb == null) return null;
  if (gateMode === "shape") {
    return {
      label: "Blower state: server",
      silent: null,
      title: `Median ${medianDb.toFixed(1)} dB. This device's blower is identified `
        + `by the spectral SHAPE of its airflow, not by loudness, because it is `
        + `mounted where a level test cannot separate the blower from ordinary `
        + `household noise. That rule runs server-side and cannot be reproduced `
        + `from this chart, so no on/off claim is made here.`,
    };
  }
  if (boundaryDb != null) {
    const silent = medianDb <= boundaryDb;
    return {
      label: silent ? "Silent" : "Blower on",
      silent,
      title: `Median ${medianDb.toFixed(1)} dB against this device's own learned `
        + `boundary of ${boundaryDb.toFixed(1)} dB. `
        + (silent
          ? "The blower was off, so this clip was skipped -- no verdict and no baseline sample."
          : "The blower was running, so this clip counts toward the baseline."),
    };
  }
  const silent = medianDb <= SILENCE_GATE_FALLBACK_DB;
  return {
    label: silent ? "Silent?" : "Blower on?",
    silent,
    title: `Median ${medianDb.toFixed(1)} dB against the fleet-wide fallback of `
      + `${SILENCE_GATE_FALLBACK_DB} dB. This device has not yet learned its own `
      + `boundary, and the fallback was measured on the lab rig -- it reads about `
      + `20 dB high for a device in a house, so treat this as provisional.`,
  };
}

// numpy-compatible median: an even-length array averages the two middle
// values, so this matches np.median() over the same 72 bins.
function medianDb(points) {
  const v = points.map((p) => p.db).filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

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
  const [baselineSpectrum, setBaselineSpectrum] = useState(null); // null = none accumulated yet
  const [baselineState, setBaselineState] = useState(null);       // "cold_start" | "warming" | "warm"
  // The server's own blower rule for this device -- never inferred here.
  const [gateMode, setGateMode] = useState("median");
  const [gateBoundaryDb, setGateBoundaryDb] = useState(null);
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

  // Fetch the audio_logs row (and mint a signed URL, if applicable) and the
  // device's baseline spectrum (if it's accumulated one yet) whenever the
  // device changes.
  useEffect(() => {
    let cancelled = false;
    setRecording(undefined);
    setLoadError(null);
    setBaselineSpectrum(null);
    setBaselineState(null);
    setGateMode("median");
    setGateBoundaryDb(null);
    (async () => {
      if (!deviceMac) { if (!cancelled) setRecording(null); return; }
      try {
        const [rec, baseline] = await Promise.all([
          getLatestRecording(deviceMac),
          getBaselineStatus(deviceMac),
        ]);
        if (!cancelled) {
          setRecording(rec);
          setBaselineSpectrum(baseline?.spectrum ?? null);
          setBaselineState(baseline?.state ?? null);
          setGateMode(baseline?.gateMode ?? "median");
          setGateBoundaryDb(baseline?.gateBoundaryDb ?? null);
        }
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
  // baselineSpectrum.db[i] lines up with spectrum[i] by index, not by
  // frequency value -- both sides use the identical log-spaced bin scheme
  // (see spectrum_viz.py's module docstring), so this merge is exact, not
  // an approximation.
  const isolatedSpectrum = useMemo(
    () => spectrum
      .map((p, i) => ({ freq: p.freq, db: p.db, baselineDb: baselineSpectrum?.db?.[i] ?? null }))
      .filter((p) => p.freq <= ISOLATED_BAND_MAX_HZ),
    [spectrum, baselineSpectrum]
  );

  // Full 72-bin median, not isolatedSpectrum -- see the gate note above.
  const gateMedianDb = useMemo(() => (spectrum.length ? medianDb(spectrum) : null), [spectrum]);
  const tag = useMemo(
    () => blowerTag(gateMedianDb, gateMode, gateBoundaryDb),
    [gateMedianDb, gateMode, gateBoundaryDb]
  );

  const classification = recording?.classification || null;
  // "calibrating" means the device hasn't finished its acoustic warmup --
  // the classifier alone is unreliable on a brand-new environment (a real
  // device called 100% of a real house's clean readings "dirty"), so its
  // raw opinion is never surfaced as a verdict until drift takes over.
  //
  // Gated on the baseline's own state, not the last decision alone. The
  // reading that completes a warmup is itself still logged as "calibrating"
  // -- FilterHealthMonitor consumes it as the final warmup sample and only
  // then freezes -- so the decision lags the baseline by one reading, and
  // lags indefinitely if the device goes quiet at that moment. Once
  // device_baselines says "warm" the calibration is genuinely done and
  // we're only waiting for the next reading to be scored, which is a
  // different thing to tell the user.
  // Y-axis bounds derived from what's actually plotted rather than pinned.
  // A fixed [-20, 50] wasted the top half of the chart: real spectra here
  // span roughly -21..+25 dB, so everything above 25 was blank and the few-dB
  // differences that carry the whole signal were squeezed into the bottom
  // 45% of the plot -- and anything below -20 clipped. Rounded outward to
  // whole 5 dB steps so the ticks stay tidy and the axis doesn't twitch on
  // every new reading.
  const spectrumDomain = useMemo(() => {
    const vals = isolatedSpectrum.flatMap((p) => [p.db, p.baselineDb])
      .filter((v) => v != null && isFinite(v));
    if (!vals.length) return [-20, 50];
    const lo = Math.floor(Math.min(...vals) / 5) * 5 - 5;
    const hi = Math.ceil(Math.max(...vals) / 5) * 5 + 5;
    return [lo, hi];
  }, [isolatedSpectrum]);

  const baselineWarm = baselineState === "warm";
  const isCalibrating = classification?.decision === "calibrating" && !baselineWarm;
  const awaitingFirstVerdict = classification?.decision === "calibrating" && baselineWarm;
  const isDirty = classification?.decision === "dirty";
  // classifier_confidence is the classifier's own P(dirty) specifically --
  // labeled as such rather than implied to be "confidence in this verdict",
  // since once a device is WARM the verdict usually comes from drift, not
  // the classifier.
  const confidencePct = classification?.classifier_confidence != null
    ? Math.round(classification.classifier_confidence * 100)
    : null;
  // When the verdict on display landed -- the first reading of its current
  // run (see getDecisionRunStart in lib/audioRecordings.js), i.e. the moment
  // this device crossed over and the site began showing this verdict. Only
  // shown for a real verdict: during calibration there is nothing to date.
  const verdictSince = (!isCalibrating && !awaitingFirstVerdict && classification?.decision_since)
    ? classification.decision_since
    : null;
  const verdictHeld = verdictSince ? durationSince(verdictSince) : null;
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
        {recording?.kind === "audio" && tag && (
          <span
            className="badge"
            style={tag.silent === true
              ? { background: "#f59e0b1f", color: "#f59e0b" }
              : { background: "var(--inputBg)", color: "var(--subtext)" }}
            title={tag.title}
          >
            <Icon name={tag.silent === true ? "warning" : "waveform"} size={11} />
            {tag.label}
          </span>
        )}

        {recording && (
          isCalibrating ? (
            <span className="badge" style={{ background: "#6366f11f", color: "#6366f1" }}>
              <Icon name="pulse" size={11} /> Calibrating…
            </span>
          ) : awaitingFirstVerdict ? (
            <span className="badge" style={{ background: "#6366f11f", color: "#6366f1" }}>
              <Icon name="success" size={11} /> Calibrated
            </span>
          ) : classification ? (
            <span
              className="badge"
              style={{ background: isDirty ? "#ef44441f" : "#22c55e1f", color: isDirty ? "#ef4444" : "#22c55e" }}
              title={
                `${classification.classifier_label} · clf ${confidencePct}% dirty · ${timeAgo(classification.recorded_at)}`
                + (verdictSince ? ` · since ${formatTimestamp(verdictSince)}` : "")
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

      {verdictSince && (
        <div
          className="banner"
          style={isDirty
            ? { background: "#ef44440f", borderColor: "#ef444438" }
            : { background: "var(--inputBg)", borderColor: "var(--border)" }}
        >
          <Icon
            name={isDirty ? "warning" : "success"}
            size={16}
            style={{ color: isDirty ? "#ef4444" : "var(--subtext)" }}
          />
          <span className="grow">
            Read as <strong>{isDirty ? "dirty" : "clean"}</strong> since{" "}
            {formatTimestamp(verdictSince)}
            {verdictHeld ? ` — ${verdictHeld}` : ""}
          </span>
        </div>
      )}

      {awaitingFirstVerdict && (
        <div className="banner" style={{ background: "var(--inputBg)", borderColor: "var(--border)" }}>
          <Icon name="success" size={16} style={{ color: "var(--subtext)" }} />
          <span className="grow">
            Calibration complete — the first verdict lands on this device's next reading.
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
                      title="Cropped on purpose: the classifier's top features, the strongest lab clean-vs-dirty effect sizes, and low_freq_energy_ratio all concentrate below 500 Hz, while a blower heard through a register (rather than against the air handler) shows up between 500 Hz and 2 kHz. The range covers both -- see ISOLATED_BAND_MAX_HZ in this file."
                    >
                      FREQUENCY SPECTRUM · {ISOLATED_BAND_LABEL}
                    </div>
                    {baselineSpectrum ? (
                      <div className="row" style={{ gap: 12 }}>
                        <span className="hint" style={{ fontSize: 10.5, display: "flex", alignItems: "center", gap: 5 }}>
                          <span style={{ width: 9, height: 9, borderRadius: 2, background: theme.accent, display: "inline-block" }} />
                          now
                        </span>
                        <span className="hint" style={{ fontSize: 10.5, display: "flex", alignItems: "center", gap: 5 }}>
                          <span style={{ width: 9, height: 2, background: theme.subtext, display: "inline-block" }} />
                          baseline · {baselineSpectrum.n} reading{baselineSpectrum.n === 1 ? "" : "s"}
                        </span>
                      </div>
                    ) : (
                      <span
                        className="hint"
                        style={{ fontSize: 10.5 }}
                        title="This device hasn't accumulated a baseline spectrum yet -- built the same way as its drift baseline, from its first warmup readings (ML/service/poll_and_infer.py)."
                      >
                        baseline not available yet
                      </span>
                    )}
                  </div>
                  <ResponsiveContainer width="100%" height={190}>
                    <ComposedChart data={isolatedSpectrum} barCategoryGap="8%" margin={{ top: 4, right: 8, left: 0, bottom: 18 }}>
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
                      {/* No axis title here on purpose -- with only ~34px of
                          width, a rotated "Magnitude (dB)" label collided
                          with the tick numbers (rendered as unreadable
                          overlapping text). The tooltip already labels
                          values in dB, and the section header above the
                          chart gives the rest of the context. */}
                      <YAxis
                        domain={spectrumDomain}
                        allowDataOverflow
                        tick={{ fill: theme.subtext, fontSize: 10, fontWeight: 600 }}
                        tickLine={false} axisLine={false} width={34}
                      />
                      <Tooltip
                        cursor={{ fill: theme.divider, opacity: 0.3 }}
                        contentStyle={{ background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 10, fontSize: 12 }}
                        formatter={(v, name) => [`${v.toFixed(1)} dB`, name === "baselineDb" ? "baseline" : "now"]}
                        labelFormatter={(f) => (f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f} Hz`)}
                      />
                      <Bar dataKey="db" fill="url(#spectrumFill)" barSize={6} radius={[1, 1, 0, 0]} isAnimationActive={false} />
                      {baselineSpectrum && (
                        <Line
                          type="monotone" dataKey="baselineDb"
                          stroke={theme.subtext} strokeWidth={1.6} strokeDasharray="4 3"
                          dot={false} isAnimationActive={false}
                        />
                      )}
                    </ComposedChart>
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
