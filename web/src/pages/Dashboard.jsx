import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "../components/Icon";
import Modal from "../components/Modal";
import MetricCard, { MetricCardSkeleton } from "../components/MetricCard";
import TrendChart from "../components/TrendChart";
import AcousticPanel from "../components/AcousticPanel";
import FilterStatus from "../components/FilterStatus";
import PriorityQueue from "../components/PriorityQueue";
import ScopePicker from "../components/ScopePicker";
import PropertySwitcher from "../components/PropertySwitcher";
import { supabase } from "../lib/supabase";
import { useScope } from "../context/ScopeContext";
import {
  centralDateInputValue, centralDayStartMs, chartTimeZoneLabel, formatChartDay,
  formatChartHour, formatChartWeekday, formatIntervalLabel, getTimeOfDay, timeAgo,
} from "../lib/format";
import {
  ALL_METRICS, BRAND_BLUE, CARDS_STORAGE_KEY, DEFAULT_CARD_KEYS, METRICS, TIME_RANGES,
  computeHvacMetrics, getRangeStatus, getStatusColor, getStatusLabel, parseTs, toDisplay,
} from "../lib/metrics";
import { DEFAULT_FILTER_INTERVAL_DAYS } from "../lib/config";

const DUCT_AREA_KEY = "duct_area";
const DAY_MS = 24 * 3600 * 1000;

export default function Dashboard() {
  const { scopedDeviceIds, devicesInScope, devices, selectedDevice, loading: scopeLoading } = useScope();

  const [rangeIndex, setRangeIndex] = useState(0);
  const [offset, setOffset] = useState(0);
  const [metric, setMetric] = useState(METRICS[0]);

  const [chartData, setChartData] = useState([]);
  const [chartStats, setChartStats] = useState({ min: null, max: null, lastTs: null });
  const [metricStats, setMetricStats] = useState({});
  const [latestReadings, setLatestReadings] = useState({});
  const [averages, setAverages] = useState({});
  const [prevAverages, setPrevAverages] = useState({});

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [cardKeys, setCardKeys] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CARDS_STORAGE_KEY) || "null");
      return Array.isArray(saved) && saved.length ? saved : DEFAULT_CARD_KEYS;
    } catch { return DEFAULT_CARD_KEYS; }
  });
  const [ductArea] = useState(() => parseFloat(localStorage.getItem(DUCT_AREA_KEY)) || 0.1);

  const [datePickerOpen, setDatePickerOpen] = useState(false);

  // Paired LoRaWAN nodes sit either side of the filter and sample the same
  // moment (see supabase/migrations/20260831000000_lora_device_pairing.sql),
  // so their series are directly comparable -- a widening gap is restriction
  // across the filter rather than something ambient affecting both.
  const [comparePair, setComparePair] = useState(false);
  const pairPartner = useMemo(() => {
    const pid = selectedDevice?.paired_device_id;
    if (!pid) return null;
    return (devices || []).find((d) => d.id === pid) || null;
  }, [selectedDevice, devices]);

  const [editingCards, setEditingCards] = useState(false);
  const [detailMetric, setDetailMetric] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const range = TIME_RANGES[rangeIndex];
  const isLine = range.hours === 24;
  const deviceKey = scopedDeviceIds.join(",");

  useEffect(() => { if (!pairPartner) setComparePair(false); }, [pairPartner]);

  const window_ = useCallback(() => {
    const rangeMs = range.hours * 3600000;
    const end = Date.now() - offset * rangeMs;
    return { start: new Date(end - rangeMs).toISOString(), end: new Date(end).toISOString() };
  }, [range.hours, offset]);

  // ── Chart series ───────────────────────────────────────────────────────────
  const fetchChart = useCallback(async () => {
    if (!scopedDeviceIds.length) {
      setChartData([]); setChartStats({ min: null, max: null, lastTs: null });
      setLoading(false);
      return;
    }

    setLoading(true); setError(null);
    const { start, end } = window_();
    let points = [];

    try {
      if (isLine) {
        // Ordered DESCENDING then reversed, so the 500-row cap keeps the
        // NEWEST readings rather than the oldest. Ascending + limit returns
        // the first 500 rows in the window, which for a device uplinking
        // more than 500 times in the range meant the chart showed only the
        // beginning of the period and "Last reading" reported the 500th
        // OLDEST row as the latest -- P9 read "21 hours ago" while it was
        // uplinking every few minutes, because row 500 of 1164 landed there.
        const { data: newestFirst, error } = await supabase
          .from("sensor_logs")
          .select(`recorded_at, ${metric.key}`)
          .in("device_id", scopedDeviceIds)
          .gte("recorded_at", start).lte("recorded_at", end)
          .order("recorded_at", { ascending: false })
          .limit(500);
        const data = (newestFirst || []).slice().reverse();

        if (error) throw error;
        if (!data?.length) {
          setChartData([]); setChartStats({ min: null, max: null, lastTs: null });
          setLoading(false);
          return;
        }

        const raw = data.map((r) => parseFloat(r[metric.key])).filter((v) => !isNaN(v));
        const display = raw.map((v) => toDisplay(metric.key, v));
        const mean = display.reduce((s, v) => s + v, 0) / display.length;
        const sd = Math.sqrt(display.reduce((s, v) => s + (v - mean) ** 2, 0) / display.length);

        setChartStats({
          min: toDisplay(metric.key, Math.min(...raw)),
          max: toDisplay(metric.key, Math.max(...raw)),
          lastTs: data[data.length - 1]?.recorded_at || null,
        });

        // Thin dense series so the chart stays readable.
        const step = Math.max(1, Math.floor(data.length / 160));
        points = (
          data.filter((_, i) => i % step === 0).map((row) => {
            const value = toDisplay(metric.key, parseFloat(row[metric.key]) || 0) ?? 0;
            const z = sd > 0 ? (value - mean) / sd : 0;
            const anomaly = Math.abs(z) > 1.5;
            const d = parseTs(row.recorded_at);
            return {
              value,
              anomaly,
              color: anomaly ? (z > 0 ? "#ef4444" : "#45B7D1") : metric.color,
              label: formatChartHour(d),
            };
          })
        );
      } else {
        const { data, error } = await supabase.rpc("get_chart_data", {
          p_device_ids: scopedDeviceIds,
          p_metric: metric.key,
          p_start: start,
          p_end: end,
          p_bucket: range.bucket,
        });

        if (error) throw error;
        if (!data?.length) {
          setChartData([]); setChartStats({ min: null, max: null, lastTs: null });
          setLoading(false);
          return;
        }

        const avgs = data.map((r) => toDisplay(metric.key, r.avg_val)).filter((v) => v != null);
        const mean = avgs.reduce((s, v) => s + v, 0) / avgs.length;
        const sd = Math.sqrt(avgs.reduce((s, v) => s + (v - mean) ** 2, 0) / avgs.length);

        setChartStats({
          min: toDisplay(metric.key, Math.min(...data.map((r) => r.min_val).filter((v) => v != null))),
          max: toDisplay(metric.key, Math.max(...data.map((r) => r.max_val).filter((v) => v != null))),
          lastTs: data[data.length - 1]?.bucket || null,
        });

        points = (
          data.map((r) => {
            const value = toDisplay(metric.key, r.avg_val) ?? 0;
            const z = sd > 0 ? (value - mean) / sd : 0;
            const d = new Date(r.bucket);
            return {
              value,
              color: Math.abs(z) > 1.5 ? (z > 0 ? "#ef4444" : "#45B7D1") : metric.color,
              label: range.hours === 168 ? formatChartWeekday(d) : formatChartDay(d),
              // Kept so clicking a bar can jump to that day's 24H view. Using
              // the bucket boundary itself means the jump always lands on the
              // same day get_chart_data bucketed by, with no second timezone
              // derivation that could disagree at midnight.
              bucket: r.bucket,
            };
          })
        );
      }

      // Overlay the paired node's series. Fetched with the same window and
      // shape, then merged on the axis label -- safe here precisely because
      // the two nodes are slot-synchronised, so their readings fall on the
      // same boundaries and therefore produce the same labels. Missing points
      // stay undefined rather than 0, so a gap in one unit reads as a gap
      // instead of a fabricated dip to zero.
      if (comparePair && pairPartner && points.length) {
        const partnerPoints = isLine
          ? await (async () => {
              const { data: pd } = await supabase
                .from("sensor_logs")
                .select(`recorded_at, ${metric.key}`)
                .eq("device_id", pairPartner.id)
                .gte("recorded_at", start).lte("recorded_at", end)
                .order("recorded_at", { ascending: false }).limit(500);
              return (pd || []).slice().reverse().map((row) => ({
                label: formatChartHour(parseTs(row.recorded_at)),
                value: toDisplay(metric.key, parseFloat(row[metric.key])),
              }));
            })()
          : await (async () => {
              const { data: pd } = await supabase.rpc("get_chart_data", {
                p_device_ids: [pairPartner.id],
                p_metric: metric.key,
                p_start: start, p_end: end, p_bucket: range.bucket,
              });
              return (pd || []).map((r) => ({
                label: range.hours === 168
                  ? formatChartWeekday(new Date(r.bucket))
                  : formatChartDay(new Date(r.bucket)),
                value: toDisplay(metric.key, r.avg_val),
              }));
            })();

        const byLabel = new Map(partnerPoints.map((p) => [p.label, p.value]));
        points = points.map((p) => ({ ...p, compareValue: byLabel.get(p.label) }));
      }

      setChartData(points);
      setLastUpdated(new Date().toISOString());
    } catch (e) {
      setError(e.message || "Failed to load chart data");
    }
    setLoading(false);
  }, [deviceKey, metric, rangeIndex, offset, isLine, range.bucket, range.hours, window_,
      comparePair, pairPartner]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Jump to one calendar day's 24H view ────────────────────────────────────
  // Used by both the 7D/30D bar click and the date picker.
  //
  // Offsets are relative to "now", and window_() / formatIntervalLabel() both
  // re-read Date.now() on EVERY render -- so an offset computed here decays as
  // real time passes:
  //
  //     end = Date.now()_render - offset * DAY_MS
  //         = anchor + (time elapsed since the click)
  //
  // This previously anchored `end` at dayEnd - 1ms (23:59:59.999 of the
  // clicked day). Any elapsed time at all -- including the few milliseconds
  // before React re-rendered -- pushed `end` past midnight, and the view
  // showed the FOLLOWING day. Whether it misfired depended purely on render
  // timing, which is why it only happened sometimes.
  //
  // A whole number of days back puts `end` at the same clock time N days ago:
  // squarely inside the clicked day with ~12h of slack either side, stable
  // until the viewer's own clock crosses midnight. Math.round absorbs DST
  // days, where the true gap is 23h or 25h rather than DAY_MS.
  const jumpToDay = useCallback((dayStartMs) => {
    const todayStartMs = centralDayStartMs(centralDateInputValue(new Date()));
    const daysBack = Math.round((todayStartMs - dayStartMs) / DAY_MS);
    setRangeIndex(TIME_RANGES.findIndex((t) => t.hours === 24));
    setOffset(Math.max(0, daysBack));   // a future day clamps to "now"
    setDatePickerOpen(false);
  }, []);

  // ── Averages, min/max and period-over-period change ────────────────────────
  const fetchAverages = useCallback(async () => {
    if (!scopedDeviceIds.length) { setMetricStats({}); setAverages({}); return; }

    const { start, end } = window_();
    const rangeMs = range.hours * 3600000;
    const prevStart = new Date(new Date(start).getTime() - rangeMs).toISOString();
    const cols = "temp_c, humidity, pressure_pa, windSpeed";

    const { data: current, error } = await supabase
      .from("sensor_logs").select(cols)
      .in("device_id", scopedDeviceIds)
      .gte("recorded_at", start).lte("recorded_at", end);

    if (error || !current?.length) { setAverages({}); setMetricStats({}); setPrevAverages({}); return; }

    const nums = (rows, key) => rows.map((r) => parseFloat(r[key])).filter((v) => !isNaN(v));
    // Averages ignore exact zeros, matching the mobile app's behaviour.
    const avg = (rows, key) => {
      const v = nums(rows, key).filter((n) => n !== 0);
      return v.length ? v.reduce((s, n) => s + n, 0) / v.length : null;
    };

    const raw = {
      temp_c: avg(current, "temp_c"),
      humidity: avg(current, "humidity"),
      pressure_pa: avg(current, "pressure_pa"),
      windSpeed: avg(current, "windSpeed"),
    };
    setAverages(raw);

    const stats = {};
    ["temp_c", "humidity", "pressure_pa", "windSpeed"].forEach((key) => {
      const all = nums(current, key);
      stats[key] = {
        avg: toDisplay(key, raw[key]),
        min: all.length ? toDisplay(key, Math.min(...all)) : null,
        max: all.length ? toDisplay(key, Math.max(...all)) : null,
      };
    });

    // Derived HVAC metrics have a single value, no min/max.
    const hvac = computeHvacMetrics(raw, ductArea);
    if (hvac) {
      ["volumetricAirflow", "airDensity", "dewPoint", "comfortIndex"].forEach((k) => {
        stats[k] = { avg: parseFloat(hvac[k].value), min: null, max: null };
      });
    }
    setMetricStats(stats);

    const { data: prev } = await supabase
      .from("sensor_logs").select(cols)
      .in("device_id", scopedDeviceIds)
      .gte("recorded_at", prevStart).lt("recorded_at", start);

    setPrevAverages(
      prev?.length
        ? {
            temp_c: avg(prev, "temp_c"),
            humidity: avg(prev, "humidity"),
            pressure_pa: avg(prev, "pressure_pa"),
            windSpeed: avg(prev, "windSpeed"),
          }
        : {}
    );
  }, [deviceKey, rangeIndex, offset, ductArea, range.hours, window_]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchLatest = useCallback(async () => {
    if (!scopedDeviceIds.length) { setLatestReadings({}); return; }
    const { data } = await supabase
      .from("sensor_logs")
      .select("temp_c, humidity, pressure_pa, windSpeed, recorded_at")
      .in("device_id", scopedDeviceIds)
      .order("recorded_at", { ascending: false })
      .limit(1);

    if (data?.length) {
      setLatestReadings({
        temp_c: parseFloat(data[0].temp_c),
        humidity: parseFloat(data[0].humidity),
        pressure_pa: parseFloat(data[0].pressure_pa),
        windSpeed: parseFloat(data[0].windSpeed),
        recorded_at: data[0].recorded_at,
      });
    }
  }, [deviceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchChart(); }, [fetchChart]);
  useEffect(() => { fetchAverages(); }, [fetchAverages]);
  useEffect(() => { fetchLatest(); }, [fetchLatest]);

  const refreshAll = () => { fetchChart(); fetchAverages(); fetchLatest(); };

  const saveCardKeys = (keys) => {
    setCardKeys(keys);
    localStorage.setItem(CARDS_STORAGE_KEY, JSON.stringify(keys));
  };

  // Percent change is a ratio, so raw vs. display units doesn't matter.
  const pctChange = (key) => {
    const curr = averages[key], prev = prevAverages[key];
    if (curr == null || prev == null || prev === 0) return null;
    return ((curr - prev) / Math.abs(prev)) * 100;
  };

  const status = getStatusLabel(averages[metric.key], prevAverages[metric.key]);
  const statusColor = getStatusColor(status);
  const fallbackInterval = useMemo(
    () => devicesInScope[0]?.filter_interval_days || DEFAULT_FILTER_INTERVAL_DAYS,
    [devicesInScope]
  );

  const noDevices = !scopeLoading && scopedDeviceIds.length === 0;

  return (
    <>
      <div className="dashboard-wave-bg" aria-hidden="true">
        <svg viewBox="0 0 1200 500" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M -50 260 C 100 120, 250 400, 400 250 S 700 100, 850 260 S 1150 400, 1300 250"
            fill="none" strokeWidth="2" opacity="0.4"
          />
          <path
            d="M -50 290 C 150 420, 300 130, 500 290 S 800 420, 950 290 S 1250 130, 1350 290"
            fill="none" strokeWidth="1.4" opacity="0.26"
          />
        </svg>
      </div>

      <header className="topbar topbar-gradient">
        <div className="topbar-titles">
          <div className="topbar-eyebrow">Good {getTimeOfDay()}</div>
          <div className="row" style={{ gap: 12 }}>
            <h1 className="topbar-title">Dashboard</h1>
            <PropertySwitcher />
          </div>
        </div>
        <div className="topbar-actions">
          {lastUpdated && (
            <span className="hint" style={{ fontSize: 12 }}>Updated {timeAgo(lastUpdated)}</span>
          )}
          <ScopePicker />
          <button className="btn btn-icon" onClick={refreshAll} title="Refresh">
            <Icon name="refresh" size={16} />
          </button>
        </div>
      </header>

      <div className="page">
        {noDevices ? (
          <div className="card empty">
            <div className="empty-icon"><Icon name="device" size={26} /></div>
            <h3 style={{ fontSize: 18, fontWeight: 800, color: "var(--text)" }}>No devices in scope</h3>
            <p className="hint">
              Claim a device on the Devices page, or widen the selection to “All properties”.
            </p>
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 18 }}>
              <PriorityQueue />
            </div>

            {/* Range + window controls */}
            <div className="row wrap" style={{ gap: 12, marginBottom: 18 }}>
              <div className="pill-row">
                {TIME_RANGES.map((t, i) => (
                  <button
                    key={t.label}
                    className={`pill${rangeIndex === i ? " active" : ""}`}
                    onClick={() => { setRangeIndex(i); setOffset(0); }}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

            </div>

            <div className="dash-split">
              {/* ── Left column ─────────────────────────────────────────── */}
              <div className="col" style={{ gap: 18 }}>
                <section className="card card-pad card-lift">
                  <div className="row wrap" style={{ marginBottom: 15 }}>
                    <span className="dot" style={{ background: metric.color, width: 10, height: 10 }} />
                    <h3 className="section-title grow">{metric.label}</h3>
                    {/* Period navigation sits in the chart's own header rather
                        than in the range row above: it only ever acts on this
                        chart, and the arrows were previously separated from the
                        graph they scrub by the whole metric pill row. */}
                    <div className="row gap-sm">
                      <button className="btn btn-icon" onClick={() => setOffset((o) => o + 1)} title="Previous period">
                        <Icon name="chevron-left" size={16} />
                      </button>
                      <div style={{ position: "relative" }}>
                        <button
                          className="date-jump-btn"
                          onClick={() => setDatePickerOpen((v) => !v)}
                          title="Jump to a specific date"
                          aria-haspopup="dialog"
                          aria-expanded={datePickerOpen}
                        >
                          {formatIntervalLabel(range.hours, offset)}
                        </button>

                        {datePickerOpen && (
                          <>
                            <div className="date-jump-backdrop" onClick={() => setDatePickerOpen(false)} />
                            <div className="date-jump-pop" role="dialog" aria-label="Jump to date">
                              <label className="field-label" style={{ marginBottom: 6, display: "block" }}>
                                JUMP TO DATE
                              </label>
                              <input
                                type="date"
                                className="input input-sm"
                                autoFocus
                                max={centralDateInputValue(new Date())}
                                defaultValue={centralDateInputValue(
                                  new Date(Date.now() - offset * range.hours * 3600000)
                                )}
                                onChange={(e) => {
                                  if (e.target.value) jumpToDay(centralDayStartMs(e.target.value));
                                }}
                              />
                              <p className="hint" style={{ marginTop: 6, fontSize: 11 }}>
                                Opens that day in the 24H view ({chartTimeZoneLabel()}).
                              </p>
                            </div>
                          </>
                        )}
                      </div>
                      <button
                        className="btn btn-icon"
                        onClick={() => setOffset((o) => Math.max(0, o - 1))}
                        disabled={offset === 0}
                        title="Next period"
                      >
                        <Icon name="chevron-right" size={16} />
                      </button>
                    </div>
                    <span className="badge" style={{ background: `${statusColor}22`, color: statusColor }}>
                      <span className="dot" style={{ background: statusColor }} />
                      {status}
                    </span>
                  </div>

                  <div className="pill-row" style={{ marginBottom: 16 }}>
                    {METRICS.map((m) => {
                      const active = metric.key === m.key;
                      return (
                        <button
                          key={m.key}
                          className="pill"
                          onClick={() => setMetric(m)}
                          style={active
                            ? { background: m.color, borderColor: m.color, color: "#fff" }
                            : undefined}
                        >
                          <span className="row" style={{ gap: 6 }}>
                            <Icon name={m.icon} size={13} />
                            {m.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {error ? (
                    <div className="banner" style={{ background: "#ef44441a", borderColor: "#ef444455", color: "#ef4444" }}>
                      <Icon name="alert" size={17} />
                      <span className="grow">{error}</span>
                      <button className="btn btn-sm" onClick={fetchChart}>Retry</button>
                    </div>
                  ) : loading ? (
                    <div className="skel" style={{ height: 300, borderRadius: 14 }} />
                  ) : (
                    <TrendChart
                      data={chartData}
                      metric={metric}
                      isLine={isLine}
                      onBarClick={isLine ? undefined : (d) => d?.bucket && jumpToDay(new Date(d.bucket).getTime())}
                      compareLabel={comparePair && pairPartner
                        ? `${pairPartner.name || pairPartner.device_mac}${pairPartner.duct_role ? ` (${pairPartner.duct_role})` : ""}`
                        : undefined}
                      primaryLabel={selectedDevice
                        ? `${selectedDevice.name || selectedDevice.device_mac}${selectedDevice.duct_role ? ` (${selectedDevice.duct_role})` : ""}`
                        : undefined}
                    />
                  )}

                  {/* Sits directly under the chart it acts on rather than up
                      in the range controls: it only ever applies to the chart,
                      and only appears for a paired device, so grouping it with
                      the always-present period controls implied otherwise. */}
                  <div className="row" style={{ marginTop: 6, gap: 10, alignItems: "center" }}>
                    {chartData.length > 0 && (
                      <p className="hint" style={{ fontSize: 11.5, margin: 0 }}>
                        Times shown in {chartTimeZoneLabel()}.
                        {!isLine && " Click a bar to open that day in the 24H view."}
                      </p>
                    )}
                    <span className="grow" />
                    {pairPartner && (
                      <button
                        className={`pill${comparePair ? " active" : ""}`}
                        onClick={() => setComparePair((v) => !v)}
                        title={`Overlay ${pairPartner.name || pairPartner.device_mac}`}
                      >
                        <Icon name="device" size={13} />{" "}
                        {comparePair ? "Hide" : "Compare"} {pairPartner.duct_role === "blower" ? "blower" : "filter"} unit
                      </button>
                    )}
                  </div>

                  <div className="chart-footer">
                    <div className="chart-footer-stats">
                      <div>
                        <div className="chart-stat-label">Min</div>
                        <div className="chart-stat-value">
                          {chartStats.min != null ? `${chartStats.min.toFixed(1)}${metric.unit}` : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="chart-stat-label">Max</div>
                        <div className="chart-stat-value">
                          {chartStats.max != null ? `${chartStats.max.toFixed(1)}${metric.unit}` : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="chart-stat-label">Last reading</div>
                        <div className="chart-stat-value">{chartStats.lastTs ? timeAgo(chartStats.lastTs) : "—"}</div>
                      </div>
                    </div>
                    <div className="chart-legend">
                      <span className="legend-item"><span className="legend-dot" style={{ background: metric.color }} />Normal</span>
                      <span className="legend-item"><span className="legend-dot" style={{ background: "#ef4444" }} />High</span>
                      <span className="legend-item"><span className="legend-dot" style={{ background: "#45B7D1" }} />Low</span>
                    </div>
                  </div>
                </section>

                <div>
                  <div className="section-head" style={{ marginTop: 0 }}>
                    <div>
                      <h2 className="section-title">My Metrics</h2>
                      <p className="section-sub">Click any card for detail</p>
                    </div>
                    <div className="row gap-sm">
                      <button className="btn btn-sm" onClick={() => setShowAdvanced(true)}>
                        <Icon name="chart" size={14} /> Advanced HVAC
                      </button>
                      <button className="btn btn-sm" onClick={() => setEditingCards(true)}>
                        <Icon name="pencil" size={14} /> Edit
                      </button>
                    </div>
                  </div>

                  <div className="grid-metrics">
                    {loading
                      ? Array.from({ length: cardKeys.length || 4 }).map((_, i) => <MetricCardSkeleton key={i} />)
                      : cardKeys.map((key) => {
                          const m = ALL_METRICS.find((x) => x.key === key);
                          if (!m) return null;
                          return (
                            <MetricCard
                              key={key}
                              metric={m}
                              stats={metricStats[key]}
                              pct={pctChange(key)}
                              onClick={() => {
                                setDetailMetric(m);
                                const chartable = METRICS.find((x) => x.key === key);
                                if (chartable) setMetric(chartable);
                              }}
                            />
                          );
                        })}
                  </div>
                </div>

                <FilterStatus deviceIds={scopedDeviceIds} fallbackIntervalDays={fallbackInterval} />
              </div>

              {/* ── Right column ────────────────────────────────────────── */}
              <div className="col" style={{ gap: 18 }}>
                {/* Acoustic data is inherently per-device — no arbitrary
                    fallback to "whichever device is first in scope" when
                    viewing an aggregate; the panel itself prompts to pick one. */}
                <AcousticPanel
                  deviceMac={selectedDevice?.device_mac}
                  deviceName={selectedDevice?.name}
                />
              </div>
            </div>
          </>
        )}
      </div>

      <MetricDetailModal
        metric={detailMetric}
        stats={detailMetric ? metricStats[detailMetric.key] : null}
        latest={detailMetric ? toDisplay(detailMetric.key, latestReadings[detailMetric.key]) : null}
        pct={detailMetric ? pctChange(detailMetric.key) : null}
        onClose={() => setDetailMetric(null)}
      />

      <EditCardsModal
        open={editingCards}
        onClose={() => setEditingCards(false)}
        keys={cardKeys}
        onSave={saveCardKeys}
      />

      <AdvancedModal
        open={showAdvanced}
        onClose={() => setShowAdvanced(false)}
        averages={averages}
        ductArea={ductArea}
      />

    </>
  );
}

// ── Metric detail ────────────────────────────────────────────────────────────
function MetricDetailModal({ metric, stats, latest, pct, onClose }) {
  if (!metric) return null;
  const dec = metric.decimals ?? 1;
  const rs = getRangeStatus(latest ?? stats?.avg, metric.normalRange);
  const color = rs === "high" ? "#ef4444" : rs === "low" ? "#45B7D1" : "#22c55e";
  const label = rs === "high" ? "Above Normal Range" : rs === "low" ? "Below Normal Range" : "Within Normal Range";
  const isUp = pct != null && pct >= 0;

  return (
    <Modal open onClose={onClose} title={metric.label} subtitle={metric.unit.trim()} icon={metric.icon}>
      <div
        style={{
          background: "var(--inputBg)",
          border: "1px solid var(--border)",
          borderTop: `3px solid ${BRAND_BLUE}`,
          borderRadius: 14, padding: 22, textAlign: "center",
        }}
      >
        <div className="field-label">LATEST READING</div>
        <div
          style={{
            fontSize: 38, fontWeight: 800, letterSpacing: -1.4,
            margin: "4px 0 10px", fontVariantNumeric: "tabular-nums",
          }}
        >
          {latest != null ? `${latest.toFixed(dec)}${metric.unit}` : "—"}
        </div>
        <span className="badge" style={{ background: `${color}1f`, color }}>
          <Icon name={rs === "normal" ? "success" : "warning"} size={12} /> {label}
        </span>
      </div>

      <div className="stat-strip" style={{ boxShadow: "none", background: "var(--inputBg)" }}>
        <div className="stat-cell">
          <div className="stat-num">{stats?.avg != null ? stats.avg.toFixed(dec) : "—"}</div>
          <div className="stat-lbl">Average</div>
        </div>
        <div className="stat-cell">
          <div className="stat-num" style={{ color: "#45B7D1" }}>{stats?.min != null ? stats.min.toFixed(dec) : "—"}</div>
          <div className="stat-lbl">Min</div>
        </div>
        <div className="stat-cell">
          <div className="stat-num" style={{ color: "#ef4444" }}>{stats?.max != null ? stats.max.toFixed(dec) : "—"}</div>
          <div className="stat-lbl">Max</div>
        </div>
      </div>

      {pct != null && (
        <div className="banner" style={{ background: "var(--inputBg)", borderColor: "var(--border)" }}>
          <Icon name={isUp ? "trending-up" : "trending-down"} size={17} style={{ color: isUp ? "#f59e0b" : "#45B7D1" }} />
          <span>
            <strong style={{ color: isUp ? "#f59e0b" : "#45B7D1" }}>{isUp ? "+" : ""}{pct.toFixed(1)}%</strong>
            {" "}vs previous period
          </span>
        </div>
      )}

      <div className="row" style={{ justifyContent: "space-between", borderTop: "1px solid var(--divider)", paddingTop: 13 }}>
        <span className="hint" style={{ fontWeight: 600 }}>Normal range</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>
          {metric.normalRange[0]}{metric.unit} – {metric.normalRange[1]}{metric.unit}
        </span>
      </div>
    </Modal>
  );
}

// ── Edit which metric cards are shown ────────────────────────────────────────
function EditCardsModal({ open, onClose, keys, onSave }) {
  const [draft, setDraft] = useState(keys);
  useEffect(() => { if (open) setDraft(keys); }, [open, keys]);

  const move = (i, dir) => {
    setDraft((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  // Keep at least one card on the dashboard.
  const remove = (key) => setDraft((p) => (p.length > 1 ? p.filter((k) => k !== key) : p));
  const add = (key) => setDraft((p) => [...p, key]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit Metric Cards"
      subtitle="Reorder with the arrows, or add and remove metrics"
      icon="pencil"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => { onSave(draft); onClose(); }}>Save</button>
        </>
      }
    >
      <div>
        <div className="field-label" style={{ marginBottom: 8 }}>ACTIVE</div>
        <div className="col gap-sm">
          {draft.map((key, i) => {
            const m = ALL_METRICS.find((x) => x.key === key);
            if (!m) return null;
            return (
              <div
                key={key}
                className="row"
                style={{
                  background: `${BRAND_BLUE}16`, border: `1px solid ${BRAND_BLUE}3a`,
                  borderRadius: 12, padding: "9px 11px",
                }}
              >
                <span className="list-icon" style={{ width: 28, height: 28, background: `${BRAND_BLUE}26`, color: BRAND_BLUE }}>
                  <Icon name={m.icon} size={14} />
                </span>
                <span className="grow" style={{ fontSize: 13.5, fontWeight: 600 }}>{m.label}</span>
                <span className="hint" style={{ fontSize: 11.5 }}>{m.unit.trim()}</span>
                <button className="btn btn-icon btn-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                  <Icon name="chevron-up" size={14} />
                </button>
                <button className="btn btn-icon btn-sm" onClick={() => move(i, 1)} disabled={i === draft.length - 1} aria-label="Move down">
                  <Icon name="chevron-down" size={14} />
                </button>
                <button className="btn btn-icon btn-sm btn-danger" onClick={() => remove(key)} disabled={draft.length === 1} aria-label="Remove">
                  <Icon name="close" size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {ALL_METRICS.some((m) => !draft.includes(m.key)) && (
        <div>
          <div className="field-label" style={{ marginBottom: 8 }}>ADD METRIC</div>
          <div className="col gap-sm">
            {ALL_METRICS.filter((m) => !draft.includes(m.key)).map((m) => (
              <button
                key={m.key}
                className="row"
                onClick={() => add(m.key)}
                style={{
                  background: "var(--inputBg)", border: "1px solid var(--border)",
                  borderRadius: 12, padding: "9px 11px", width: "100%", textAlign: "left",
                }}
              >
                <span className="list-icon" style={{ width: 28, height: 28, background: `${BRAND_BLUE}26`, color: BRAND_BLUE }}>
                  <Icon name={m.icon} size={14} />
                </span>
                <span className="grow" style={{ fontSize: 13.5, fontWeight: 600 }}>{m.label}</span>
                {m.computed && (
                  <span className="badge" style={{ background: "#6366f11f", color: "#6366f1" }}>computed</span>
                )}
                <Icon name="plus" size={15} style={{ color: "#22c55e" }} />
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Full derived-metric breakdown ────────────────────────────────────────────
function AdvancedModal({ open, onClose, averages, ductArea }) {
  const hvac = averages.temp_c != null ? computeHvacMetrics(averages, ductArea) : null;
  const rows = hvac ? Object.values(hvac) : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Advanced HVAC"
      subtitle="Derived from the current sensor averages"
      icon="chart"
    >
      {!hvac ? (
        <div className="empty">
          <div className="empty-icon"><Icon name="chart" size={24} /></div>
          <p>No data available yet</p>
        </div>
      ) : (
        <>
          <div className="banner" style={{ background: "var(--inputBg)", borderColor: "var(--border)", fontWeight: 500 }}>
            <Icon name="info" size={16} style={{ color: "var(--subtext)" }} />
            <span className="hint">All values derived from sensor data. Duct area: {ductArea} m².</span>
          </div>

          <div className="col gap-sm">
            {rows.map((r) => (
              <div key={r.label} className="row" style={{ alignItems: "flex-start", background: "var(--inputBg)", border: "1px solid var(--border)", borderRadius: 13, padding: 14 }}>
                <span className="list-icon" style={{ color: BRAND_BLUE, background: `${BRAND_BLUE}1f` }}>
                  <Icon name={r.icon} size={17} />
                </span>
                <div className="grow">
                  <div className="list-label">{r.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 800, margin: "2px 0 4px" }}>
                    {r.value}<span className="hint" style={{ fontSize: 13, fontWeight: 600 }}>{r.unit}</span>
                  </div>
                  <p className="hint" style={{ fontSize: 12 }}>{r.description}</p>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
