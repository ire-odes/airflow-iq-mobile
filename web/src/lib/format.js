import { parseTs } from "./metrics.js";
import { DEFAULT_WAKE_INTERVAL_SECONDS } from "./config.js";

export function formatTimestamp(ts) {
  if (!ts) return "—";
  const d = parseTs(ts);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function timeAgo(ts) {
  if (!ts) return null;
  const diff = Math.floor((Date.now() - parseTs(ts).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return "Morning";
  if (h < 17) return "Afternoon";
  return "Evening";
}

// Human label for the window currently being viewed, e.g. "Mar 3 – 9".
export function formatIntervalLabel(rangeHours, off) {
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const end = new Date(Date.now() - off * rangeHours * 3600000);
  const start = new Date(end.getTime() - rangeHours * 3600000);

  if (rangeHours === 24) {
    return end.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  if (rangeHours === 168) {
    const sm = M[start.getMonth()], em = M[end.getMonth()];
    return start.getMonth() === end.getMonth()
      ? `${sm} ${start.getDate()} – ${end.getDate()}`
      : `${sm} ${start.getDate()} – ${em} ${end.getDate()}`;
  }
  if (rangeHours === 720) return `${M[start.getMonth()]} ${start.getFullYear()}`;
  return `${M[start.getMonth()]} – ${M[end.getMonth()]} ${end.getFullYear()}`;
}

export function formatSeconds(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function wakeLabel(seconds) {
  const s = seconds || DEFAULT_WAKE_INTERVAL_SECONDS;
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${s / 60}m`;
  return `${s / 3600}h`;
}
