import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Icon from "./Icon";
import { useTheme } from "../context/ThemeContext";
import { formatSeconds, timeAgo, formatTimestamp } from "../lib/format";
import {
  FEATURE_DEFS, VERDICTS, buildAudioBuffer, computePeaks, getRecordings,
} from "../lib/acoustic";

// ============================================================================
// Acoustic Data
//
// PLACEHOLDER DATA — the verdict and every spectral feature below are mocked
// in lib/acoustic.js. The audio itself is synthesized in the browser so the
// player, scrubber and waveform are real and exercisable; once the ML pipeline
// lands, swap getRecordings() for a Supabase query and point the player at the
// stored audio file. See the header comment in lib/acoustic.js.
// ============================================================================

const WAVE_BINS = 190;

export default function AcousticPanel({ deviceId, deviceName }) {
  const { theme } = useTheme();

  const recordings = useMemo(() => getRecordings(deviceId), [deviceId]);
  const [index, setIndex] = useState(0);
  const recording = recordings[index];

  const [peaks, setPeaks] = useState([]);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const ctxRef = useRef(null);
  const gainRef = useRef(null);
  const bufferRef = useRef(null);
  const sourceRef = useRef(null);
  const startedAtRef = useRef(0);   // ctx.currentTime when playback began
  const offsetRef = useRef(0);      // seconds into the clip at that moment
  const rafRef = useRef(null);
  const stoppingRef = useRef(false); // distinguishes manual stop from natural end

  // Tear down any in-flight playback.
  const stopSource = useCallback(() => {
    stoppingRef.current = true;
    try { sourceRef.current?.stop(); } catch { /* already stopped */ }
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    stoppingRef.current = false;
    cancelAnimationFrame(rafRef.current);
  }, []);

  // Build the audio buffer + waveform whenever the selected recording changes.
  useEffect(() => {
    if (!ctxRef.current) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return; // No Web Audio — waveform/player simply won't render.
      ctxRef.current = new Ctor();
      gainRef.current = ctxRef.current.createGain();
      gainRef.current.gain.value = 0.55;
      gainRef.current.connect(ctxRef.current.destination);
    }

    stopSource();
    setPlaying(false);
    setElapsed(0);
    offsetRef.current = 0;

    const buffer = buildAudioBuffer(ctxRef.current, recording);
    bufferRef.current = buffer;
    setPeaks(computePeaks(buffer, WAVE_BINS));
  }, [recording, stopSource]);

  // Release the AudioContext when the panel unmounts.
  useEffect(() => () => {
    stopSource();
    ctxRef.current?.close();
    ctxRef.current = null;
  }, [stopSource]);

  const tick = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const t = offsetRef.current + (ctx.currentTime - startedAtRef.current);
    setElapsed(Math.min(t, recording.duration));
    rafRef.current = requestAnimationFrame(tick);
  }, [recording.duration]);

  const playFrom = useCallback(async (offset) => {
    const ctx = ctxRef.current;
    if (!ctx || !bufferRef.current) return;

    // Browsers start the context suspended until a user gesture.
    if (ctx.state === "suspended") await ctx.resume();

    stopSource();

    const src = ctx.createBufferSource();
    src.buffer = bufferRef.current;
    src.connect(gainRef.current);
    src.onended = () => {
      if (stoppingRef.current) return; // manual stop, not the end of the clip
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
      offsetRef.current = Math.min(t, recording.duration);
      setElapsed(offsetRef.current);
      setPlaying(false);
    } else {
      playFrom(offsetRef.current >= recording.duration ? 0 : offsetRef.current);
    }
  };

  const restart = () => {
    offsetRef.current = 0;
    setElapsed(0);
    if (playing) playFrom(0);
  };

  // Click anywhere on the waveform to seek there.
  const seek = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const target = ratio * recording.duration;
    offsetRef.current = target;
    setElapsed(target);
    if (playing) playFrom(target);
  };

  const verdict = VERDICTS[recording.verdict];
  const progress = recording.duration ? elapsed / recording.duration : 0;

  return (
    <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header */}
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="property-icon"><Icon name="waveform" size={18} /></div>
        <div className="grow">
          <h3 className="section-title">Acoustic Data</h3>
          <p className="section-sub">
            {deviceName ? `${deviceName} · ` : ""}Most recent recording · {timeAgo(recording.recorded_at)}
          </p>
        </div>
        <span className="badge" style={{ background: "#6366f11f", color: "#6366f1" }}>
          <Icon name="sparkles" size={11} /> Mock data
        </span>
      </div>

      {/* ML verdict */}
      <div
        className="verdict-banner"
        style={{ background: `${verdict.color}14`, borderColor: `${verdict.color}44` }}
      >
        <div className="verdict-icon" style={{ background: `${verdict.color}26`, color: verdict.color }}>
          <Icon name={recording.verdict === "clean" ? "success" : "warning"} size={20} />
        </div>
        <div className="grow">
          <div className="row gap-sm">
            <span style={{ fontSize: 16, fontWeight: 800, color: verdict.color }}>{verdict.label}</span>
            <span className="badge" style={{ background: `${verdict.color}20`, color: verdict.color }}>
              {(recording.confidence * 100).toFixed(0)}% confidence
            </span>
          </div>
          <p className="hint" style={{ marginTop: 4 }}>{verdict.summary}</p>
        </div>
      </div>

      {/* Player */}
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
              // Bars left of the playhead take the verdict colour.
              const played = i / WAVE_BINS <= progress;
              return (
                <rect
                  key={i}
                  x={i + 0.18}
                  y={(100 - h) / 2}
                  width={0.64}
                  height={h}
                  rx={0.3}
                  fill={played ? verdict.color : theme.subtext}
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
            {formatSeconds(elapsed)} / {formatSeconds(recording.duration)}
          </span>
          <span className="grow" />
          <span className="hint" style={{ fontSize: 11.5 }}>{formatTimestamp(recording.recorded_at)}</span>
        </div>
      </div>

      {/* Recording history */}
      <div>
        <div className="field-label" style={{ marginBottom: 7 }}>RECENT RECORDINGS</div>
        <div className="pill-row">
          {recordings.map((r, i) => {
            const v = VERDICTS[r.verdict];
            return (
              <button
                key={r.id}
                className={`pill${i === index ? " active" : ""}`}
                onClick={() => setIndex(i)}
                style={i === index ? undefined : { color: "var(--text)" }}
              >
                <span className="dot" style={{ background: v.color, display: "inline-block", marginRight: 6 }} />
                {timeAgo(r.recorded_at)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Extracted features */}
      <div>
        <div className="field-label" style={{ marginBottom: 8 }}>EXTRACTED FEATURES</div>
        <div className="feature-grid">
          {FEATURE_DEFS.map((f) => {
            const value = recording.features[f.key];
            return (
              <div className="feature-cell" key={f.key} title={f.hint}>
                <div className="feature-label">
                  {f.label}
                  <Icon name="info" size={11} style={{ opacity: 0.55, flexShrink: 0 }} />
                </div>
                <div className="feature-value">
                  {value != null ? value.toFixed(f.decimals) : "—"}
                  {f.unit && <span className="feature-unit">{f.unit}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <p className="hint" style={{ marginTop: 11, fontSize: 11.5 }}>
          Features shown are placeholders. The production pipeline will extract these
          server-side and classify filter condition from them.
        </p>
      </div>
    </section>
  );
}
