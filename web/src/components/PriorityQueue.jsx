import { useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import Icon from "./Icon";
import { supabase } from "../lib/supabase";
import { useScope } from "../context/ScopeContext";
import { getOnlineStatus, getFilterProgress, getRfidAvgLifespanDays } from "../lib/metrics";

// ============================================================================
// "Needs Attention" — a portfolio-wide count, independent of whatever
// property/device the Dashboard's own scope picker is currently viewing.
// Deliberately just a banner + count + "View all" — the actual device list
// lives on the Devices page, not duplicated here.
// ============================================================================

export default function PriorityQueue() {
  const { devices, loading: scopeLoading } = useScope();

  const [health, setHealth] = useState({}); // { [deviceId]: { lastSeen, installedAt } }
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!devices.length) { setHealth({}); setLoading(false); return; }
      setLoading(true);

      const next = {};
      await Promise.all(devices.map(async (dev) => {
        const [{ data: logs }, { data: rfidLogs }] = await Promise.all([
          supabase.from("sensor_logs").select("recorded_at")
            .eq("device_id", dev.id).order("recorded_at", { ascending: false }).limit(1),
          supabase.from("sensor_logs").select("recorded_at, rfid")
            .eq("device_id", dev.id).not("rfid", "is", null)
            .order("recorded_at", { ascending: false }).limit(100),
        ]);

        let installedAt = null;
        let avgLifespanDays = null;
        if (rfidLogs?.length) {
          const current = rfidLogs[0].rfid;
          const withCurrent = rfidLogs.filter((r) => r.rfid === current);
          installedAt = withCurrent[withCurrent.length - 1]?.recorded_at || null;
          avgLifespanDays = getRfidAvgLifespanDays(rfidLogs);
        }

        next[dev.id] = { lastSeen: logs?.[0]?.recorded_at || null, installedAt, avgLifespanDays };
      }));

      if (!cancelled) { setHealth(next); setLoading(false); }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices.map((d) => d.id).join(",")]);

  // A device "needs attention" if its filter is overdue, due soon, or it's
  // offline — same triage rule as before, just counted rather than listed.
  const attentionCount = useMemo(() => {
    return devices.filter((d) => {
      const h = health[d.id] || {};
      const status = getOnlineStatus(h.lastSeen);
      // For now, filter life is determined ONLY by observed RFID tag
      // changes, not the configured filter_interval_days.
      const fp = getFilterProgress(h.installedAt, h.avgLifespanDays);
      return (fp && fp.pct >= 90) || status === "offline";
    }).length;
  }, [devices, health]);

  const ownedCount = devices.filter((d) => d._isOwner).length;
  const servicedCount = devices.length - ownedCount;
  const isTechOnly = servicedCount > 0 && ownedCount === 0;
  const isMixed = servicedCount > 0 && ownedCount > 0;

  const subtitle = devices.length === 0
    ? "Claim a device to get started"
    : attentionCount === 0
      ? "Every device is online and within its filter life"
      : isTechOnly
        ? `${attentionCount} of ${devices.length} devices need a visit`
        : isMixed
          ? `${attentionCount} device${attentionCount === 1 ? "" : "s"} need attention — yours and properties you service`
          : `${attentionCount} of ${devices.length} device${devices.length === 1 ? "" : "s"} need attention`;

  const busy = loading || scopeLoading;

  return (
    <div className="needs-attention-banner">
      <div className="needs-attention-icon">
        <Icon name={busy ? "waveform" : attentionCount ? "warning" : "success"} size={13} />
      </div>
      <span className="truncate">
        <strong>Needs Attention</strong> — {busy ? "Checking your devices…" : subtitle}
      </span>
      <NavLink to="/devices" className="needs-attention-viewall">
        View all <Icon name="chevron-right" size={12} />
      </NavLink>
    </div>
  );
}
