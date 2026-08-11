import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon";
import { useTheme } from "../context/ThemeContext";
import { formatSeconds, timeAgo, formatTimestamp } from "../lib/format";
import { getLatestRecording, computePeaks, normalizeMfcc } from "../lib/audioRecordings";

// ============================================================================
// Acoustic Data — real recordings from audio_logs / hvac-recordings storage,
// paired with real classifier output from filter_ml_readings when a device
// has been scored (a separate pipeline — not this repo — writes those rows).
// Devices with no reading yet show "not yet classified", never a guess.
// See lib/audioRecordings.js for the data shape and the WiFi-audio vs.
// LoRaWAN-MFCC split.
// ============================================================================

const WAVE_BINS = 190;
const TRIM_LEADING_SECONDS = 0.05; // drop the mic-startup click at the very start of the clip

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

  const classification = recording?.classification || null;
  const isDirty = classification?.decision === "dirty";
  const confidencePct = classification?.classifier_confidence != null
    ? Math.round(classification.classifier_confidence * 100)
    : null;
  const hasDisagreement = !!classification?.disagreement_flag
    && !["none", "false", "no"].includes(String(classification.disagreement_flag).toLowerCase());

  return (
    <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
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
          classification ? (
            <span className="badge" style={{ background: isDirty ? "#ef44441f" : "#22c55e1f", color: isDirty ? "#ef4444" : "#22c55e" }}>
              <Icon name={isDirty ? "warning" : "success"} size={11} />
              {isDirty ? "Filter Dirty" : "Filter Clean"} · {confidencePct}%
            </span>
          ) : (
            <span className="badge" style={{ background: "#6366f11f", color: "#6366f1" }}>
              <Icon name="info" size={11} /> Not yet classified
            </span>
          )
        )}
      </div>

      {classification && (
        <div
          className="banner"
          style={{
            background: isDirty ? "#ef44441a" : "#22c55e1a",
            borderColor: isDirty ? "#ef444455" : "#22c55e55",
            color: isDirty ? "#ef4444" : "#16a34a",
          }}
        >
          <Icon name={isDirty ? "warning" : "success"} size={16} />
          <span className="grow">
            <strong>{classification.classifier_label}</strong> — {confidencePct}% confidence
            {hasDisagreement && <> · <strong>flagged:</strong> {classification.disagreement_flag}</>}
          </span>
          <span className="hint" style={{ fontSize: 11 }}>{timeAgo(classification.recorded_at)}</span>
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
            </div>
          )}
        </>
      )}
    </section>
  );
}
