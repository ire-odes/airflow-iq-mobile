import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import Icon from "./Icon";
import { supabase } from "../lib/supabase";
import { useTheme } from "../context/ThemeContext";
import { parseTs } from "../lib/metrics";
import { formatTimestamp } from "../lib/format";
import { DEFAULT_FILTER_INTERVAL_DAYS } from "../lib/config";

// Filter lifecycle, derived from RFID tag changes in sensor_logs — the same
// inference the mobile app does: a new tag id means a new filter was fitted.

const RANGES = ["D", "W", "M", "Y"];

function getWeekNumber(d) {
  const j = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - j) / 86400000 + j.getDay() + 1) / 7);
}

export default function FilterStatus({ deviceIds, fallbackIntervalDays = DEFAULT_FILTER_INTERVAL_DAYS }) {
  const { theme } = useTheme();

  const [changes, setChanges] = useState([]);
  const [currentRfid, setCurrentRfid] = useState(null);
  const [installedAt, setInstalledAt] = useState(null);
  const [lastChange, setLastChange] = useState(null);
  const [range, setRange] = useState("M");
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!deviceIds.length) {
        setChanges([]); setCurrentRfid(null); setInstalledAt(null); setLastChange(null);
        return;
      }

      const { data } = await supabase
        .from("sensor_logs")
        .select("recorded_at, rfid, device_id")
        .in("device_id", deviceIds)
        .not("rfid", "is", null)
        .order("recorded_at", { ascending: true });

      if (cancelled) return;
      if (!data?.length) {
        setChanges([]); setCurrentRfid(null); setInstalledAt(null); setLastChange(null);
        return;
      }

      const reversed = [...data].reverse();
      const curr = reversed.find((r) => r.rfid)?.rfid || null;
      setCurrentRfid(curr);

      if (curr) {
        setInstalledAt(data.find((r) => r.rfid === curr)?.recorded_at || null);
        setLastChange(reversed.find((r) => r.rfid && r.rfid !== curr)?.recorded_at || null);
      }

      // Walk forward and record each point where the tag id changed.
      const list = [];
      let lastRfid = null;
      data.forEach((row) => {
        if (row.rfid && row.rfid !== lastRfid) {
          if (lastRfid !== null) {
            list.push({ changed_at: row.recorded_at, rfid: row.rfid, device_id: row.device_id });
          }
          lastRfid = row.rfid;
        }
      });
      setChanges(list.reverse());
    })();

    return () => { cancelled = true; };
  }, [deviceIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const daysSinceInstall = installedAt
    ? Math.floor((Date.now() - parseTs(installedAt).getTime()) / 86400000)
    : null;

  // Predict remaining life from observed lifespans, falling back to the
  // device's configured replacement interval when there's no history.
  const { predictedDaysLeft, avgLifespan } = useMemo(() => {
    if (daysSinceInstall == null) return { predictedDaysLeft: null, avgLifespan: null };

    if (changes.length >= 2) {
      const spans = [];
      for (let i = 0; i < changes.length - 1; i++) {
        const days = Math.abs(
          Math.floor((parseTs(changes[i].changed_at) - parseTs(changes[i + 1].changed_at)) / 86400000)
        );
        if (days > 0 && days < 730) spans.push(days);
      }
      if (spans.length) {
        const avg = Math.round(spans.reduce((s, v) => s + v, 0) / spans.length);
        return { predictedDaysLeft: Math.max(0, avg - daysSinceInstall), avgLifespan: avg };
      }
    }

    return {
      predictedDaysLeft: Math.max(0, fallbackIntervalDays - daysSinceInstall),
      avgLifespan: fallbackIntervalDays,
    };
  }, [changes, daysSinceInstall, fallbackIntervalDays]);

  // Bucket the change history for the small bar chart.
  const barData = useMemo(() => {
    const now = new Date();
    let slots = [];
    let bucketOf;

    if (range === "D") {
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now); d.setDate(d.getDate() - i);
        slots.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, key: d.toDateString(), value: 0 });
      }
      bucketOf = (c) => parseTs(c.changed_at).toDateString();
    } else if (range === "W") {
      for (let i = 7; i >= 0; i--) {
        const d = new Date(now); d.setDate(d.getDate() - i * 7);
        const wk = `W${getWeekNumber(d)}`;
        slots.push({ label: wk, key: wk, value: 0 });
      }
      bucketOf = (c) => `W${getWeekNumber(parseTs(c.changed_at))}`;
    } else if (range === "M") {
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        slots.push({
          label: d.toLocaleString("en-US", { month: "short" }),
          key: `${d.getFullYear()}-${d.getMonth()}`,
          value: 0,
        });
      }
      bucketOf = (c) => { const d = parseTs(c.changed_at); return `${d.getFullYear()}-${d.getMonth()}`; };
    } else {
      for (let i = 4; i >= 0; i--) {
        const yr = now.getFullYear() - i;
        slots.push({ label: `${yr}`, key: `${yr}`, value: 0 });
      }
      bucketOf = (c) => `${parseTs(c.changed_at).getFullYear()}`;
    }

    changes.forEach((c) => {
      const slot = slots.find((s) => s.key === bucketOf(c));
      if (slot) slot.value++;
    });
    return slots;
  }, [changes, range]);

  const predColor =
    predictedDaysLeft == null ? "#9ca3af"
      : predictedDaysLeft <= 7 ? "#ef4444"
      : predictedDaysLeft <= 30 ? "#f97316"
      : predictedDaysLeft <= 60 ? "#f59e0b"
      : "#22c55e";

  const predLabel =
    predictedDaysLeft == null ? "Unknown"
      : predictedDaysLeft <= 7 ? "Critical"
      : predictedDaysLeft <= 30 ? "Soon"
      : predictedDaysLeft <= 60 ? "Watch"
      : "Good";

  return (
    <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 15 }}>
      <div className="row">
        <div className="property-icon"><Icon name="clock" size={18} /></div>
        <div className="grow">
          <h3 className="section-title">Filter Status</h3>
          <p className="section-sub">Inferred from RFID tag changes</p>
        </div>
      </div>

      {predictedDaysLeft != null && (
        <div className="banner" style={{ background: `${predColor}14`, borderColor: `${predColor}44`, color: predColor }}>
          <Icon name={predictedDaysLeft <= 30 ? "warning" : "success"} size={17} />
          <span className="grow" style={{ color: "var(--text)" }}>
            <strong>
              {predictedDaysLeft === 0
                ? "Replace filter now"
                : `~${predictedDaysLeft} days until replacement`}
            </strong>
            <span className="hint" style={{ display: "block", fontWeight: 500 }}>
              Based on {changes.length} past filter{changes.length !== 1 ? "s" : ""} · avg lifespan {avgLifespan}d
            </span>
          </span>
          <span className="badge" style={{ background: predColor, color: "#fff" }}>{predLabel}</span>
        </div>
      )}

      {daysSinceInstall != null && daysSinceInstall > 60 && (
        <div
          className="banner"
          style={{
            background: daysSinceInstall > 180 ? "#ef44441a" : daysSinceInstall > 90 ? "#f973161a" : "#f59e0b1a",
            borderColor: daysSinceInstall > 180 ? "#ef444455" : daysSinceInstall > 90 ? "#f9731655" : "#f59e0b55",
            color: daysSinceInstall > 180 ? "#ef4444" : daysSinceInstall > 90 ? "#f97316" : "#f59e0b",
          }}
        >
          <Icon name="warning" size={16} />
          <span>
            Filter installed {daysSinceInstall} days ago —{" "}
            {daysSinceInstall > 180 ? "replace immediately" : daysSinceInstall > 90 ? "consider replacing soon" : "monitor closely"}
          </span>
        </div>
      )}

      <div style={{ background: "var(--inputBg)", borderRadius: 14, overflow: "hidden" }}>
        <div className="list-row">
          <div className="list-icon"><Icon name="calendar" size={16} /></div>
          <div className="grow">
            <div className="list-label">Current filter installed</div>
            <div className="list-value">
              {installedAt ? `${formatTimestamp(installedAt)} · ${daysSinceInstall}d ago` : "No filter detected yet"}
            </div>
          </div>
        </div>
        <div className="list-row">
          <div className="list-icon"><Icon name="swap" size={16} /></div>
          <div className="grow">
            <div className="list-label">Last filter change</div>
            <div className="list-value">{lastChange ? formatTimestamp(lastChange) : "No previous filter detected"}</div>
          </div>
        </div>
        {currentRfid && (
          <div className="list-row">
            <div className="list-icon"><Icon name="rfid" size={16} /></div>
            <div className="grow">
              <div className="list-label">Current RFID tag</div>
              <div className="list-value mono" style={{ fontSize: 13 }}>{currentRfid}</div>
            </div>
          </div>
        )}
      </div>

      <button className="btn btn-block" onClick={() => setShowHistory((s) => !s)}>
        <Icon name={showHistory ? "chevron-up" : "chevron-down"} size={15} />
        {showHistory ? "Hide" : "Show"} change history ({changes.length})
      </button>

      {showHistory && (
        <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
          <div className="pill-row">
            {RANGES.map((r) => (
              <button key={r} className={`pill${range === r ? " active" : ""}`} onClick={() => setRange(r)}>
                {r}
              </button>
            ))}
          </div>

          <ResponsiveContainer width="100%" height={130}>
            <BarChart data={barData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
              <XAxis
                dataKey="label" tickLine={false}
                axisLine={{ stroke: theme.divider }}
                tick={{ fill: theme.subtext, fontSize: 10, fontWeight: 600 }}
              />
              <Tooltip
                cursor={{ fill: theme.divider, opacity: 0.4 }}
                contentStyle={{
                  background: theme.card, border: `1px solid ${theme.border}`,
                  borderRadius: 10, fontSize: 12,
                }}
                formatter={(v) => [`${v} change${v === 1 ? "" : "s"}`, ""]}
              />
              <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={34} isAnimationActive={false}>
                {barData.map((d, i) => (
                  <Cell key={i} fill={d.value > 0 ? "#007BFF" : theme.divider} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>

          {changes.length > 0 ? (
            <div style={{ borderTop: `1px solid ${theme.divider}`, paddingTop: 13 }}>
              <div className="field-label" style={{ marginBottom: 10 }}>CHANGE HISTORY</div>
              {changes.map((c, i) => {
                const next = changes[i + 1];
                const daysUsed = next
                  ? Math.floor((parseTs(c.changed_at) - parseTs(next.changed_at)) / 86400000)
                  : null;
                return (
                  <div className="row" key={i} style={{ alignItems: "flex-start", marginBottom: 12 }}>
                    <span className="dot" style={{ background: "#007BFF", width: 8, height: 8, marginTop: 5 }} />
                    <div className="grow">
                      <div className="row">
                        <span style={{ fontSize: 13, fontWeight: 600 }} className="grow">
                          {formatTimestamp(c.changed_at)}
                        </span>
                        {daysUsed != null && (
                          <span className="badge" style={{ background: "#007BFF1f", color: "#007BFF" }}>
                            {daysUsed}d used
                          </span>
                        )}
                      </div>
                      {c.rfid && <div className="hint mono" style={{ fontSize: 11 }}>RFID: {c.rfid}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="hint" style={{ textAlign: "center", padding: "10px 0" }}>
              No filter changes detected yet
            </p>
          )}
        </div>
      )}
    </section>
  );
}
