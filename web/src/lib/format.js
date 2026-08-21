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
// Formatted in CHART_TIMEZONE (see below) for the same reason the axis
// labels are: this sits directly above the chart, so if it resolved in the
// viewer's local timezone it could name a different day than the bars it's
// labelling.
export function formatIntervalLabel(rangeHours, off) {
  const end = new Date(Date.now() - off * rangeHours * 3600000);
  const start = new Date(end.getTime() - rangeHours * 3600000);

  if (rangeHours === 24) return _weekdayDateFmt.format(end);
  if (rangeHours === 168) {
    const sm = _monthFmt.format(start), em = _monthFmt.format(end);
    return sm === em
      ? `${sm} ${_dayNumFmt.format(start)} – ${_dayNumFmt.format(end)}`
      : `${sm} ${_dayNumFmt.format(start)} – ${em} ${_dayNumFmt.format(end)}`;
  }
  if (rangeHours === 720) return _monthYearFmt.format(start);
  return `${_monthFmt.format(start)} – ${_monthYearFmt.format(end)}`;
}

// ── Chart timezone ──────────────────────────────────────────────────────────
// Chart axis labels are pinned to Central time rather than the viewer's own
// local timezone, so a given reading reads the same no matter where the
// dashboard is opened from -- the devices are all in Central, so that's the
// timezone the data actually means something in.
//
// America/Chicago (an IANA zone) rather than a fixed -06:00 offset or a
// literal "CST", deliberately: the US is on daylight time (CDT, -05:00) for
// roughly eight months a year, so a hardcoded CST offset would render every
// label an hour off for most of the year. This lets the runtime pick the
// right one per date. Mirrors the database's own session timezone -- see
// supabase/migrations/20260820120000_db_timezone_central.sql.
export const CHART_TIMEZONE = "America/Chicago";

const _hourFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: CHART_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false,
});
const _weekdayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: CHART_TIMEZONE, weekday: "short",
});
const _dayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: CHART_TIMEZONE, month: "numeric", day: "numeric",
});
const _dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: CHART_TIMEZONE, month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
const _fullDayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: CHART_TIMEZONE, weekday: "long", month: "short", day: "numeric",
});
// Used by formatIntervalLabel above (safe to declare after it: the function
// only dereferences these when called, long after module init).
const _weekdayDateFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: CHART_TIMEZONE, weekday: "short", month: "short", day: "numeric",
});
const _monthFmt = new Intl.DateTimeFormat("en-US", { timeZone: CHART_TIMEZONE, month: "short" });
const _dayNumFmt = new Intl.DateTimeFormat("en-US", { timeZone: CHART_TIMEZONE, day: "numeric" });
const _monthYearFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: CHART_TIMEZONE, month: "short", year: "numeric",
});

export const formatChartHour = (d) => _hourFmt.format(d);
export const formatChartWeekday = (d) => _weekdayFmt.format(d);
export const formatChartDay = (d) => _dayFmt.format(d);
export const formatChartDateTime = (d) => _dateTimeFmt.format(d);
export const formatChartFullDay = (d) => _fullDayFmt.format(d);

// "CST" or "CDT" for the given instant -- shown next to axis labels so it's
// explicit which timezone the chart is in rather than leaving it ambiguous.
export function chartTimeZoneLabel(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CHART_TIMEZONE, timeZoneName: "short",
  }).formatToParts(d);
  return parts.find((p) => p.type === "timeZoneName")?.value || "CT";
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
