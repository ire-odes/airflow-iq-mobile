import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "../components/Icon";
import Modal from "../components/Modal";
import MetricCard, { MetricCardSkeleton } from "../components/MetricCard";
import TrendChart from "../components/TrendChart";
import AcousticPanel from "../components/AcousticPanel";
import FilterStatus from "../components/FilterStatus";
import ScopePicker from "../components/ScopePicker";
import { supabase } from "../lib/supabase";
import { useScope } from "../context/ScopeContext";
import { formatIntervalLabel, getTimeOfDay, timeAgo } from "../lib/format";
import {
  ALL_METRICS, CARDS_STORAGE_KEY, DEFAULT_CARD_KEYS, METRICS, TIME_RANGES,
  computeHvacMetrics, getRangeStatus, getStatusColor, getStatusLabel, parseTs, toDisplay,
} from "../lib/metrics";
import { DEFAULT_FILTER_INTERVAL_DAYS } from "../lib/config";

const DUCT_AREA_KEY = "duct_area";

export default function Dashboard() {
  const { scopedDeviceIds, devicesInScope, selectedDevice, loading: scopeLoading } = useScope();

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

  const [editingCards, setEditingCards] = useState(false);
  const [detailMetric, setDetailMetric] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const range = TIME_RANGES[rangeIndex];
  const isLine = range.hours === 24;
  const deviceKey = scopedDeviceIds.join(",");

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

    try {
      if (isLine) {
        const { data, error } = await supabase
          .from("sensor_logs")
          .select(`recorded_at, ${metric.key}`)
          .in("device_id", scopedDeviceIds)
          .gte("recorded_at", start).lte("recorded_at", end)
          .order("recorded_at", { ascending: true })
          .limit(500);

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
        setChartData(
          data.filter((_, i) => i % step === 0).map((row) => {
            const value = toDisplay(metric.key, parseFloat(row[metric.key]) || 0) ?? 0;
            const z = sd > 0 ? (value - mean) / sd : 0;
            const anomaly = Math.abs(z) > 1.5;
            const d = parseTs(row.recorded_at);
            return {
              value,
              anomaly,
              color: anomaly ? (z > 0 ? "#ef4444" : "#45B7D1") : metric.color,
              label: `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`,
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

        setChartData(
          data.map((r) => {
            const value = toDisplay(metric.key, r.avg_val) ?? 0;
            const z = sd > 0 ? (value - mean) / sd : 0;
            const d = new Date(r.bucket);
            return {
              value,
              color: Math.abs(z) > 1.5 ? (z > 0 ? "#ef4444" : "#45B7D1") : metric.color,
              label: range.hours === 168
                ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]
                : `${d.getMonth() + 1}/${d.getDate()}`,
            };
          })
        );
      }
      setLastUpdated(new Date().toISOString());
    } catch (e) {
      setError(e.message || "Failed to load chart data");
    }
    setLoading(false);
  }, [deviceKey, metric, rangeIndex, offset, isLine, range.bucket, range.hours, window_]); // eslint-disable-line react-hooks/exhaustive-deps

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
      <header className="topbar">
        <div className="topbar-titles">
          <div className="topbar-eyebrow">Good {getTimeOfDay()}</div>
          <h1 className="topbar-title">Dashboard</h1>
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

              <div className="row gap-sm" style={{ marginLeft: "auto" }}>
                <button className="btn btn-icon" onClick={() => setOffset((o) => o + 1)} title="Previous period">
                  <Icon name="chevron-left" size={16} />
                </button>
                <span style={{ fontSize: 13.5, fontWeight: 700, minWidth: 140, textAlign: "center" }}>
                  {formatIntervalLabel(range.hours, offset)}
                </span>
                <button
                  className="btn btn-icon"
                  onClick={() => setOffset((o) => Math.max(0, o - 1))}
                  disabled={offset === 0}
                  title="Next period"
                >
                  <Icon name="chevron-right" size={16} />
                </button>
              </div>
            </div>

            <div className="dash-split">
              {/* ── Left column ─────────────────────────────────────────── */}
              <div className="col" style={{ gap: 18 }}>
                <section className="card card-pad">
                  <div className="row wrap" style={{ marginBottom: 15 }}>
                    <span className="dot" style={{ background: metric.color, width: 10, height: 10 }} />
                    <h3 className="section-title grow">{metric.label}</h3>
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
                    <TrendChart data={chartData} metric={metric} isLine={isLine} />
                  )}

                  <div className="stat-strip" style={{ marginTop: 16, boxShadow: "none", background: "var(--inputBg)" }}>
                    <div className="stat-cell">
                      <div className="stat-num" style={{ color: "#45B7D1" }}>
                        {chartStats.min != null ? `${chartStats.min.toFixed(1)}${metric.unit}` : "—"}
                      </div>
                      <div className="stat-lbl">Min</div>
                    </div>
                    <div className="stat-cell">
                      <div className="stat-num" style={{ color: "#ef4444" }}>
                        {chartStats.max != null ? `${chartStats.max.toFixed(1)}${metric.unit}` : "—"}
                      </div>
                      <div className="stat-lbl">Max</div>
                    </div>
                    <div className="stat-cell">
                      <div className="stat-num">{chartStats.lastTs ? timeAgo(chartStats.lastTs) : "—"}</div>
                      <div className="stat-lbl">Last reading</div>
                    </div>
                    <div className="stat-cell">
                      <div className="stat-num">{scopedDeviceIds.length}</div>
                      <div className="stat-lbl">{scopedDeviceIds.length === 1 ? "Device" : "Devices"}</div>
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
                <AcousticPanel
                  deviceId={selectedDevice?.id || scopedDeviceIds[0]}
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
          borderTop: `3px solid ${metric.color}`,
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
                  background: `${m.color}16`, border: `1px solid ${m.color}3a`,
                  borderRadius: 12, padding: "9px 11px",
                }}
              >
                <span className="list-icon" style={{ width: 28, height: 28, background: `${m.color}26`, color: m.color }}>
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
                <span className="list-icon" style={{ width: 28, height: 28, background: `${m.color}26`, color: m.color }}>
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
                <span className="list-icon" style={{ color: "#6366f1", background: "#6366f11f" }}>
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
