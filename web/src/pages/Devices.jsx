import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import Icon from "../components/Icon";
import Modal, { ConfirmModal } from "../components/Modal";
import { supabase } from "../lib/supabase";
import { useAuth } from "../context/AuthContext";
import { useScope, UNASSIGNED_ID } from "../context/ScopeContext";
import { getFilterProgress, getOnlineStatus, getBatteryStage } from "../lib/metrics";
import { timeAgo, wakeLabel } from "../lib/format";
import {
  DEFAULT_FILTER_INTERVAL_DAYS, DEFAULT_WAKE_INTERVAL_SECONDS,
  FILTER_INTERVAL_MIN_DAYS, FILTER_INTERVAL_MAX_DAYS,
  WAKE_INTERVAL_MIN_SECONDS, WAKE_INTERVAL_MAX_SECONDS,
} from "../lib/config";

export default function Devices() {
  const { grouped, devices, properties, schemaReady, reload, loading } = useScope();

  // Split so a technician's serviced properties render as their own section,
  // never mixed in with the properties/devices you actually own.
  const ownedGroups = grouped.filter((g) => g.property._isOwner);
  const technicianGroups = grouped.filter((g) => !g.property._isOwner);

  const [stats, setStats] = useState({});
  const [installDates, setInstallDates] = useState({});
  // device_mac -> device_baselines.state. A device is "calibrating" until its
  // baseline freezes (state === "warm"); until then the wake interval must not
  // be edited, because changing it mid-warmup changes the spacing of the very
  // samples the baseline is being fitted from.
  const [baselineStates, setBaselineStates] = useState({});

  const [claimOpen, setClaimOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  // Per-device last-seen, battery, and current filter install date.
  const loadStats = useCallback(async () => {
    if (!devices.length) return;

    const nextStats = {};
    const nextInstall = {};

    await Promise.all(devices.map(async (dev) => {
      const [{ data: logs }, { data: rfidLogs }] = await Promise.all([
        supabase.from("sensor_logs").select("recorded_at, battery")
          .eq("device_id", dev.id).order("recorded_at", { ascending: false }).limit(1),
        supabase.from("sensor_logs").select("recorded_at, rfid")
          .eq("device_id", dev.id).not("rfid", "is", null).neq("rfid", "")
          .order("recorded_at", { ascending: false }).limit(100),
      ]);

      if (logs?.length) nextStats[dev.id] = { lastSeen: logs[0].recorded_at, latest: logs[0] };

      if (rfidLogs?.length) {
        // The oldest log still carrying the current tag is when it was fitted.
        const current = rfidLogs[0].rfid;
        const withCurrent = rfidLogs.filter((r) => r.rfid === current);
        const firstSeen = withCurrent[withCurrent.length - 1]?.recorded_at;
        if (firstSeen) nextInstall[dev.id] = firstSeen;
      }
    }));

    setStats(nextStats);
    setInstallDates(nextInstall);

    const { data: bl } = await supabase
      .from("device_baselines").select("device_mac, state");
    setBaselineStates(Object.fromEntries((bl || []).map((b) => [b.device_mac, b.state])));
  }, [devices]);

  useEffect(() => { loadStats(); }, [loadStats]);

  const refresh = async () => { await reload(); await loadStats(); };

  // ── Mutations ──────────────────────────────────────────────────────────────
  const saveDevice = async (form) => {
    setBusy(true);

    // Pairing lives on both rows (devices.paired_device_id is a plain
    // self-reference, not a join table), so writing only this device's side
    // would leave a half-pair: the partner wouldn't know it was paired, and
    // lora_slot_seconds resolves across the pair from whichever row is being
    // read. Both sides are written here, and the old partner is released
    // first so a device can be re-paired without stranding its previous one.
    const { pairedWith, ...deviceFields } = form;
    const previousPartner = editingDevice.paired_device_id;

    const { error } = await supabase
      .from("devices").update(deviceFields).eq("id", editingDevice.id);
    if (error) { setBusy(false); return alert(`Failed to update device: ${error.message}`); }

    if (pairedWith !== undefined && pairedWith !== previousPartner) {
      if (previousPartner) {
        await supabase.from("devices")
          .update({ paired_device_id: null }).eq("id", previousPartner);
      }
      const { error: pairError } = await supabase.from("devices")
        .update({ paired_device_id: pairedWith || null }).eq("id", editingDevice.id);
      if (pairError) { setBusy(false); return alert(`Failed to pair: ${pairError.message}`); }

      if (pairedWith) {
        // The partner points back, and inherits the opposite role so a pair
        // can't end up with two blowers -- which would silently give both
        // units the same transmit offset and collide them at the gateway.
        const opposite = deviceFields.duct_role === "blower" ? "filter" : "blower";
        const { error: backError } = await supabase.from("devices")
          .update({ paired_device_id: editingDevice.id, duct_role: opposite })
          .eq("id", pairedWith);
        if (backError) { setBusy(false); return alert(`Failed to pair partner: ${backError.message}`); }
      }
    }

    // A paired blower/filter set is one logical installation on one duct, so
    // the settings that describe the installation are mirrored onto the
    // partner: property and the two intervals. Editing either half updates
    // both, which stops the pair drifting into contradictory settings --
    // particularly wake_interval, where a mismatch feeds lora_slot_seconds()
    // and would silently pull both nodes onto the faster value anyway.
    //
    // Deliberately NOT shared:
    //   name           - each node keeps its own. Sharing it made both cards
    //                    read "P9 (LoRaWAN)" and destroyed P4's name on save,
    //                    which is a lossy write: the old value is simply gone.
    //                    The blower/filter badge already shows they are a set.
    //   duct_role      - has to differ, that is the whole point of the pair
    //   device_mac     - identity
    //   hvac_location  - the two nodes sit at physically different points in
    //                    the duct
    //   tenant_*       - left per-device
    const partnerId = pairedWith !== undefined ? pairedWith : previousPartner;
    if (partnerId) {
      const shared = {};
      for (const k of ["property_id", "filter_interval_days", "wake_interval_seconds"]) {
        if (k in deviceFields) shared[k] = deviceFields[k];
      }
      if (Object.keys(shared).length) {
        const { error: shareError } = await supabase
          .from("devices").update(shared).eq("id", partnerId);
        if (shareError) {
          setBusy(false);
          return alert(`Saved this device, but failed to apply shared settings to its pair: ${shareError.message}`);
        }
      }
    }

    setBusy(false);
    setEditingDevice(null);
    refresh();
  };

  const removeDevice = (device) => setConfirm({
    title: "Remove device",
    message: `Remove "${device.name || device.device_mac}" from your account? Its recorded data is kept, and the device can be claimed again later.`,
    confirmLabel: "Remove",
    danger: true,
    action: async () => {
      await supabase.from("devices").update({ owner_id: null }).eq("id", device.id);
      refresh();
    },
  });

  // Resets the acoustic baseline (device_baselines row) so the ML pipeline
  // (ML/service/poll_and_infer.py) treats the next reading as a fresh
  // cold_start instead of comparing against a stale baseline -- for after
  // moving the sensor, cleaning/replacing the mic, or installing a filter
  // known to be genuinely clean. filter_ml_readings history is untouched.
  //
  // Also stamps calibration_started_at, which puts the device into
  // "sampling mode": effective_wake_seconds (a computed column read by
  // the firmware) drops to 60s while the baseline builds. See
  // supabase/migrations/20260821120000_calibration_sampling_mode.sql.
  //
  // Note this no longer shortens warmup to ~2h, as it originally did. A
  // baseline built from 120 samples inside a 2-hour window encodes one
  // narrow set of operating conditions, then reads ordinary overnight
  // variation as drift -- three devices flipped to "dirty" on filters
  // nobody had touched. The baseline now also requires its samples to
  // span ~20h before it can freeze (MIN_BASELINE_SPAN_SECONDS in
  // ML/service/poll_and_infer.py), so fast sampling makes the baseline
  // denser rather than ready sooner.
  const recalibrateDevice = (device) => setConfirm({
    title: "Recalibrate microphone",
    message: `Reset the acoustic baseline for "${device.name || device.device_mac}"? It samples every minute at first, but needs to listen across a full day and night before it can judge anything — acoustic verdicts stay quiet for about 20 hours. Only do this right after fitting a filter you know is clean.`,
    confirmLabel: "Recalibrate",
    danger: true,
    action: async () => {
      // Stamped first: a device with no baseline row yet (never warmed up,
      // or mid-warmup) still needs sampling mode, so this must not depend
      // on the delete below finding anything.
      const { error: stampError } = await supabase
        .from("devices")
        .update({ calibration_started_at: new Date().toISOString() })
        .eq("id", device.id);
      if (stampError) return alert(`Failed to recalibrate: ${stampError.message}`);

      // .select() so an RLS-blocked or no-op delete is visible: an error-free
      // delete that matched 0 rows is otherwise indistinguishable from
      // success. Verified again below because the delete succeeding is not
      // the same as the baseline staying gone -- see the note there.
      const { data, error } = await supabase
        .from("device_baselines").delete().eq("device_mac", device.device_mac).select("device_mac");
      if (error) return alert(`Failed to clear the old baseline: ${error.message}`);

      // The ML poller (ML/service/poll_and_infer.py) reads a device's
      // baseline at the start of a cycle and writes it back at the end. A
      // delete landing between those two points gets undone when the poller
      // upserts the state it already had in memory, which silently restores
      // the exact baseline this action was meant to clear. The poller has a
      // guard for this, but re-reading here catches the case where it's
      // running an older build.
      const { data: still } = await supabase
        .from("device_baselines").select("device_mac").eq("device_mac", device.device_mac);
      if (still && still.length > 0) {
        return alert(
          "The baseline was cleared but immediately came back, which means the " +
          "ML poller rewrote it. Stop the poller, then recalibrate this device again."
        );
      }
      if (!data || data.length === 0) {
        // Not an error: a device that never warmed up has no row to clear.
        // calibration_started_at is already stamped above either way, so
        // sampling mode still applies.
      }
    },
  });

  const runConfirm = async () => {
    setBusy(true);
    await confirm.action();
    setBusy(false);
    setConfirm(null);
  };

  // ── Portfolio counters ─────────────────────────────────────────────────────
  const counts = useMemo(() => {
    const online = devices.filter((d) => getOnlineStatus(stats[d.id]?.lastSeen) === "online").length;
    const dueSoon = devices.filter((d) => {
      const fp = getFilterProgress(installDates[d.id], d.filter_interval_days || DEFAULT_FILTER_INTERVAL_DAYS);
      return fp && fp.pct >= 90;
    }).length;
    return { total: devices.length, online, offline: devices.length - online, dueSoon };
  }, [devices, stats, installDates]);

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
          <div className="topbar-eyebrow">Manage</div>
          <h1 className="topbar-title">Devices &amp; Properties</h1>
        </div>
        <div className="topbar-actions">
          <NavLink to="/properties" className="btn">
            <Icon name="building" size={15} /> Manage Properties
          </NavLink>
          <button className="btn btn-primary" onClick={() => setClaimOpen(true)}>
            <Icon name="plus" size={15} /> Claim Device
          </button>
          <button className="btn btn-icon" onClick={refresh} title="Refresh">
            <Icon name="refresh" size={16} />
          </button>
        </div>
      </header>

      <div className="page">
        {!schemaReady && (
          <div className="banner" style={{ background: "#f59e0b1a", borderColor: "#f59e0b55", color: "#f59e0b", marginBottom: 18 }}>
            <Icon name="warning" size={17} />
            <span className="grow" style={{ color: "var(--text)" }}>
              The <strong>properties</strong> table isn't in your database yet. Run{" "}
              <code className="mono">supabase/migrations/20260725000000_properties.sql</code> in the
              Supabase SQL editor to enable the property hierarchy. Devices still work without it.
            </span>
          </div>
        )}

        <div className="stat-strip" style={{ marginBottom: 22 }}>
          <div className="stat-cell">
            <div className="stat-num">{counts.total}</div><div className="stat-lbl">Total devices</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">{counts.online}</div><div className="stat-lbl">Online</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">{counts.offline}</div><div className="stat-lbl">Offline</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num" style={{ color: counts.dueSoon ? "#f97316" : undefined }}>{counts.dueSoon}</div>
            <div className="stat-lbl">Filter due</div>
          </div>
          <div className="stat-cell">
            <div className="stat-num">{properties.length}</div><div className="stat-lbl">Properties</div>
          </div>
        </div>

        {counts.dueSoon > 0 && (
          <div className="banner" style={{ background: "#f973161a", borderColor: "#f9731655", color: "#f97316", marginBottom: 20 }}>
            <Icon name="warning" size={16} />
            <span>
              {counts.dueSoon} device{counts.dueSoon > 1 ? "s need" : " needs"} a filter replacement soon
            </span>
          </div>
        )}

        {loading ? (
          <div className="device-grid">
            {[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 210, borderRadius: 18 }} />)}
          </div>
        ) : grouped.length === 0 ? (
          <div className="card empty">
            <div className="empty-icon"><Icon name="device" size={26} /></div>
            <h3 style={{ fontSize: 19, fontWeight: 800, color: "var(--text)" }}>No devices yet</h3>
            <p className="hint">Claim your first device using the MAC address printed on it.</p>
            <button className="btn btn-primary" onClick={() => setClaimOpen(true)} style={{ marginTop: 6 }}>
              Claim Your First Device
            </button>
          </div>
        ) : (
          <>
            {ownedGroups.map(({ property, devices: propDevices }) => (
              <PropertyGroupCard
                key={property.id}
                property={property}
                propDevices={propDevices}
                stats={stats}
                installDates={installDates}
                onEdit={setEditingDevice}
                onRemove={removeDevice}
                onRecalibrate={recalibrateDevice}
              />
            ))}

            {technicianGroups.length > 0 && (
              <>
                <div className="section-head">
                  <div>
                    <h2 className="section-title">Technician Devices</h2>
                    <p className="section-sub">You can edit the name and location of these devices.</p>
                  </div>
                </div>
                {technicianGroups.map(({ property, devices: propDevices }) => (
                  <PropertyGroupCard
                    key={property.id}
                    property={property}
                    propDevices={propDevices}
                    stats={stats}
                    installDates={installDates}
                    onEdit={setEditingDevice}
                    onRemove={removeDevice}
                    onRecalibrate={recalibrateDevice}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>

      <ClaimDeviceModal open={claimOpen} onClose={() => setClaimOpen(false)} onClaimed={() => { setClaimOpen(false); refresh(); }} />

      <EditDeviceModal
        device={editingDevice}
        properties={properties}
        allDevices={devices}
        calibrating={editingDevice
          ? (baselineStates[editingDevice.device_mac] || "cold_start") !== "warm"
          : false}
        onClose={() => setEditingDevice(null)}
        onSave={saveDevice}
        busy={busy}
        schemaReady={schemaReady}
      />

      <ConfirmModal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={runConfirm}
        busy={busy}
        title={confirm?.title}
        message={confirm?.message}
        confirmLabel={confirm?.confirmLabel}
        danger={confirm?.danger}
      />
    </>
  );
}

// Collapses a property's devices into render entries, so a paired
// blower/filter set can be drawn as one linked unit rather than two cards
// that happen to sit near each other.
//
// Only pairs when BOTH halves are in this property's list -- paired devices
// should share a property now that saveDevice mirrors property_id, but a pair
// created before that, or mid-edit, can still straddle two properties. Those
// fall back to rendering individually rather than vanishing from one list.
//
// Blower is placed first so the pair always reads upstream-to-downstream,
// matching airflow, regardless of insertion order.
function groupPairs(devices) {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const used = new Set();
  const out = [];

  for (const d of devices) {
    if (used.has(d.id)) continue;
    const partner = d.paired_device_id ? byId.get(d.paired_device_id) : null;
    // Require the link to point back, so a stale one-sided paired_device_id
    // cannot swallow an unrelated device into a pair.
    if (partner && partner.paired_device_id === d.id && !used.has(partner.id)) {
      used.add(d.id); used.add(partner.id);
      const blower = d.duct_role === "blower" ? d : partner;
      const filter = blower === d ? partner : d;
      out.push({ kind: "pair", blower, filter });
    } else {
      used.add(d.id);
      out.push({ kind: "single", device: d });
    }
  }
  return out;
}

// ── One property and its devices ─────────────────────────────────────────────
function PropertyGroupCard({ property, propDevices, stats, installDates, onEdit, onRemove, onRecalibrate }) {
  return (
    <div className="property-group">
      <div className="property-head">
        <div className="property-icon">
          <Icon name={property._virtual ? "device" : "building"} size={17} />
        </div>
        <div className="grow">
          <div className="row gap-sm">
            <h3 style={{ fontSize: 15.5, fontWeight: 800 }}>{property.name}</h3>
            <span className="badge" style={{ background: "var(--inputBg)", color: "var(--subtext)" }}>
              {propDevices.length} {propDevices.length === 1 ? "device" : "devices"}
            </span>
          </div>
          {[property.address, property.city, property.region].filter(Boolean).length > 0 && (
            <div className="meta-row" style={{ marginTop: 3 }}>
              <Icon name="location" size={12} />
              {[property.address, property.city, property.region].filter(Boolean).join(", ")}
            </div>
          )}
          {property._virtual && property._isOwner && (
            <p className="hint" style={{ marginTop: 3 }}>
              Devices not yet assigned to a property. Edit a device to place it.
            </p>
          )}
        </div>
      </div>

      {propDevices.length === 0 ? (
        <p className="hint" style={{ padding: "4px 6px 10px" }}>No devices in this property yet.</p>
      ) : (
        <div className="device-grid">
          {groupPairs(propDevices).map((entry) => {
            const card = (d) => (
              <DeviceCard
                key={d.id}
                device={d}
                lastSeen={stats[d.id]?.lastSeen}
                latest={stats[d.id]?.latest}
                installedAt={installDates[d.id]}
                onEdit={() => onEdit(d)}
                onRemove={() => onRemove(d)}
                onRecalibrate={() => onRecalibrate(d)}
              />
            );
            if (entry.kind === "single") return card(entry.device);
            return (
              <div className="device-pair" key={`pair-${entry.blower.id}`}>
                <div className="device-pair-label">
                  <Icon name="link" size={12} />
                  Linked duct pair
                </div>
                {card(entry.blower)}
                <div className="device-pair-link" aria-hidden="true">
                  <span><Icon name="link" size={13} /></span>
                </div>
                {card(entry.filter)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Stepped battery graphic: a body of 4 segments, `stage.bars` of them
// filled -- see getBatteryStage in lib/metrics.js for the voltage bands.
function BatteryStageIcon({ stage }) {
  if (!stage) return null;
  return (
    <span className="row" style={{ gap: 1.5 }}>
      <span
        className="row"
        style={{ gap: 1.5, width: 22, height: 12, border: `1.3px solid ${stage.color}66`, borderRadius: 3, padding: 1.5, boxSizing: "border-box" }}
      >
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            style={{ flex: 1, height: "100%", borderRadius: 1, background: i <= stage.bars ? stage.color : "transparent" }}
          />
        ))}
      </span>
      <span style={{ width: 2, height: 6, borderRadius: 1, background: `${stage.color}66` }} />
    </span>
  );
}

// ── Device card ──────────────────────────────────────────────────────────────
function DeviceCard({ device, lastSeen, latest, installedAt, onEdit, onRemove, onRecalibrate }) {
  const status = getOnlineStatus(lastSeen);
  const statusColor = status === "online" ? "#22c55e" : status === "idle" ? "#f59e0b" : "#9ca3af";
  const statusLabel = status === "online" ? "Online" : status === "idle" ? "Idle" : "Offline";

  const fp = getFilterProgress(installedAt, device.filter_interval_days || DEFAULT_FILTER_INTERVAL_DAYS);
  const fpColor = !fp ? "#9ca3af" : fp.pct >= 100 ? "#ef4444" : fp.pct >= 75 ? "#f59e0b" : "#22c55e";
  const fpLabel = !fp ? "" : fp.pct >= 100 ? "Replace now" : fp.pct >= 90 ? "Replace soon" : fp.pct >= 75 ? "Watch closely" : `${fp.daysLeft}d left`;

  const battStage = getBatteryStage(latest?.battery);

  return (
    <article className="card device-card">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="list-icon" style={{ width: 42, height: 42, borderRadius: 13 }}>
          <Icon name="device" size={20} />
        </div>
        <div className="grow">
          <div className="row gap-sm">
            <span className="device-name truncate">{device.name || "Unnamed Device"}</span>
            {/* A paired set shares its name, so without this the two cards are
                indistinguishable. Role is the disambiguator, not location,
                because location is free text and may be blank. */}
            {device.duct_role && (
              <span className="badge" style={{ background: "#6366f11f", color: "#6366f1" }}>
                <Icon name={device.duct_role === "blower" ? "wind" : "layers"} size={10} />
                {device.duct_role === "blower" ? "Blower" : "Filter"}
              </span>
            )}
            {!device._isOwner && (
              <span className="badge" style={{ background: "#0284c71f", color: "#0284c7" }}>
                <Icon name="wrench" size={10} /> Technician
              </span>
            )}
          </div>
          {device.hvac_location && (
            <div className="meta-row"><Icon name="location" size={12} /> {device.hvac_location}</div>
          )}
          {device.device_mac && (
            <div className="meta-row mono"><Icon name="barcode" size={12} /> {device.device_mac}</div>
          )}
        </div>
        <div className="col" style={{ alignItems: "flex-end", gap: 6 }}>
          <span className="badge" style={{ background: `${statusColor}22`, color: statusColor }}>
            <span className="dot" style={{ background: statusColor }} /> {statusLabel}
          </span>
          {battStage && (
            <span title={`Battery: ${battStage.label}`}>
              <BatteryStageIcon stage={battStage} />
            </span>
          )}
        </div>
      </div>

      {lastSeen && <div className="hint" style={{ fontSize: 11.5 }}>Last seen {timeAgo(lastSeen)}</div>}

      {fp && (
        <div>
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
            <span className="hint" style={{ fontSize: 11.5, fontWeight: 600 }}>Filter life</span>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: fpColor }}>{fpLabel}</span>
          </div>
          <div className="progress-track" style={{ background: `${fpColor}26` }}>
            <div className="progress-fill" style={{ width: `${fp.pct}%`, background: fpColor }} />
          </div>
          <div className="hint" style={{ fontSize: 10.5, marginTop: 3 }}>{fp.pct}% used</div>
        </div>
      )}

      <div className="row wrap" style={{ background: "var(--inputBg)", borderRadius: 11, padding: 10, gap: 14 }}>
        <span className="meta-row"><Icon name="clock" size={13} /> Filter every {device.filter_interval_days || DEFAULT_FILTER_INTERVAL_DAYS}d</span>
        <span className="meta-row"><Icon name="pulse" size={13} /> Wake {wakeLabel(device.wake_interval_seconds)}</span>
        <span className="meta-row truncate">
          <Icon name="user" size={13} /> {device.tenant_email || "No tenant"}
        </span>
      </div>

      <div className="row gap-sm wrap">
        <button className="btn btn-sm" onClick={onEdit}><Icon name="pencil" size={13} /> Edit</button>
        {device._isOwner && (
          <button className="btn btn-sm" onClick={onRecalibrate} title="Reset the acoustic baseline">
            <Icon name="refresh" size={13} /> Recalibrate
          </button>
        )}
        {device._isOwner && (
          <button className="btn btn-sm btn-danger" onClick={onRemove}>
            <Icon name="trash" size={13} /> Remove
          </button>
        )}
      </div>
    </article>
  );
}

// ── Claim a device by MAC ────────────────────────────────────────────────────
function ClaimDeviceModal({ open, onClose, onClaimed }) {
  const { session } = useAuth();
  const { selectedPropertyId, selectedProperty } = useScope();
  const [mac, setMac] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // The property currently scoped in the sidebar switcher — a claim made
  // while a specific property is selected joins that property automatically.
  const targetPropertyId = selectedPropertyId && selectedPropertyId !== UNASSIGNED_ID
    ? selectedPropertyId
    : null;

  useEffect(() => { if (open) { setMac(""); setError(null); } }, [open]);

  // Accept any input, normalise to AA:BB:CC:DD:EE:FF as the user types.
  const format = (text) => {
    const clean = text.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
    return (clean.match(/.{1,2}/g) || []).join(":").slice(0, 17);
  };

  const claim = async () => {
    const clean = mac.replace(/[^a-fA-F0-9]/gi, "").toUpperCase();
    if (clean.length !== 12) return setError("Enter a full 12-character MAC address.");

    setBusy(true); setError(null);

    const { data } = await supabase
      .from("devices").select("*").eq("device_mac", clean).is("owner_id", null).maybeSingle();

    if (!data) {
      // Distinguish "already claimed" from "doesn't exist" for a useful message.
      const { data: existing } = await supabase
        .from("devices").select("id, owner_id").eq("device_mac", clean).maybeSingle();
      setBusy(false);
      if (existing?.owner_id === session?.user?.id) setError("This device is already registered to your account.");
      else if (existing?.owner_id) setError("This device is registered to another account.");
      else setError("No device found with that MAC address.");
      return;
    }

    const { error } = await supabase
      .from("devices")
      .update({ owner_id: session?.user?.id, property_id: targetPropertyId })
      .eq("id", data.id);
    setBusy(false);
    if (error) return setError(error.message);
    onClaimed();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Claim Device"
      subtitle="Enter the MAC address printed on the device or its QR label"
      icon="barcode"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={claim} disabled={busy}>
            {busy ? <span className="spinner" /> : "Claim Device"}
          </button>
        </>
      }
    >
      {error && <div className="auth-error">{error}</div>}

      <div className="field">
        <label className="field-label">MAC ADDRESS</label>
        <input
          className="input mono"
          style={{ fontSize: 17, letterSpacing: 1.5, textAlign: "center", fontWeight: 700 }}
          placeholder="AA:BB:CC:DD:EE:FF"
          value={mac}
          maxLength={17}
          autoFocus
          onChange={(e) => setMac(format(e.target.value))}
          onKeyDown={(e) => { if (e.key === "Enter") claim(); }}
        />
      </div>

      <div className="banner" style={{ background: "var(--inputBg)", borderColor: "var(--border)" }}>
        <Icon name="building" size={15} style={{ color: "var(--subtext)" }} />
        <span>
          {targetPropertyId
            ? <>Will be added to <strong>{selectedProperty?.name}</strong></>
            : <>Will be <strong>unassigned</strong> — pick a property in the sidebar first to auto-assign</>}
        </span>
      </div>

      <p className="hint">
        On mobile you can scan the QR code instead — the desktop app uses manual entry.
      </p>
    </Modal>
  );
}

// ── Edit a device ────────────────────────────────────────────────────────────
// Presets must stay inside the DB CHECK constraints: wake ≥ 10 min, filter ≤ 30 days.
const WAKE_PRESETS = [
  { label: "10m", value: 600 }, { label: "30m", value: 1800 },
  { label: "1h", value: 3600 }, { label: "6h", value: 21600 },
  { label: "24h", value: 86400 },
];
const INTERVAL_PRESETS = [7, 14, 21, 30];

function EditDeviceModal({ device, properties, allDevices, onClose, onSave, busy, schemaReady, calibrating }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!device) return setForm(null);
    setError(null);
    setForm({
      name: device.name || "",
      hvac_location: device.hvac_location || "",
      property_id: device.property_id || "",
      filter_interval_days: device.filter_interval_days || DEFAULT_FILTER_INTERVAL_DAYS,
      wake_interval_seconds: device.wake_interval_seconds || DEFAULT_WAKE_INTERVAL_SECONDS,
      tenant_email: device.tenant_email || "",
      tenant_phone: device.tenant_phone || "",
      tenantEnabled: !!(device.tenant_email || device.tenant_phone),
      duct_role: device.duct_role || "",
      pairedWith: device.paired_device_id || "",
    });
  }, [device]);

  if (!device || !form) return null;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const isOwner = device._isOwner;

  const submit = () => {
    if (!form.name.trim()) return setError("Device name is required");

    const interval = parseInt(form.filter_interval_days, 10) || DEFAULT_FILTER_INTERVAL_DAYS;
    if (interval < FILTER_INTERVAL_MIN_DAYS || interval > FILTER_INTERVAL_MAX_DAYS) {
      return setError(`Filter interval must be between ${FILTER_INTERVAL_MIN_DAYS} and ${FILTER_INTERVAL_MAX_DAYS} days`);
    }

    const wake = parseInt(form.wake_interval_seconds, 10) || DEFAULT_WAKE_INTERVAL_SECONDS;
    if (wake < WAKE_INTERVAL_MIN_SECONDS || wake > WAKE_INTERVAL_MAX_SECONDS) {
      return setError(
        `Wake interval must be between ${WAKE_INTERVAL_MIN_SECONDS / 60} minutes and ${WAKE_INTERVAL_MAX_SECONDS / 3600} hours`
      );
    }

    if (form.tenantEnabled && form.tenant_email && !form.tenant_email.includes("@")) {
      return setError("Enter a valid tenant email");
    }

    // Technicians may only rename/relocate; owner-only fields are left alone.
    const payload = isOwner
      ? {
          name: form.name.trim(),
          hvac_location: form.hvac_location.trim(),
          property_id: form.property_id || null,
          filter_interval_days: interval,
          // Omitted entirely while calibrating rather than merely disabled in
          // the UI: a disabled input is a hint, not a guarantee, and this
          // value reaches the firmware.
          ...(calibrating ? {} : { wake_interval_seconds: wake }),
          tenant_email: form.tenantEnabled ? form.tenant_email.trim().toLowerCase() : null,
          tenant_phone: form.tenantEnabled ? form.tenant_phone.trim() : null,
          // Only meaningful for LoRaWAN units; null on everything else so a
          // WiFi device can't accidentally carry a duct role.
          ...(device.is_lorawan
            ? { duct_role: form.duct_role || null, pairedWith: form.pairedWith || null }
            : {}),
        }
      : { name: form.name.trim(), hvac_location: form.hvac_location.trim() };

    onSave(payload);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit Device"
      subtitle={device.device_mac || "Update device settings"}
      icon="device"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? <span className="spinner" /> : "Save Changes"}
          </button>
        </>
      }
    >
      {error && <div className="auth-error">{error}</div>}

      <div className="field">
        <label className="field-label">DEVICE NAME</label>
        <input className="input" value={form.name} placeholder="e.g. Living Room Unit"
          onChange={(e) => set({ name: e.target.value })} autoFocus />
      </div>

      <div className="field">
        <label className="field-label">HVAC LOCATION</label>
        <input className="input" value={form.hvac_location} placeholder="e.g. Upstairs Hallway"
          onChange={(e) => set({ hvac_location: e.target.value })} />
      </div>

      {isOwner && (
        <>
          <div className="field">
            <label className="field-label">PROPERTY</label>
            <select
              className="input"
              value={form.property_id}
              disabled={!schemaReady}
              onChange={(e) => set({ property_id: e.target.value })}
            >
              <option value="">Unassigned Property</option>
              {properties.filter((p) => p._isOwner).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <p className="hint">
              {schemaReady
                ? "Group this device under one of your properties."
                : "Run the properties migration to enable this."}
            </p>
          </div>

          {device.is_lorawan && (
            <div className="field">
              <label className="field-label">DUCT PAIRING (LORAWAN)</label>
              <div className="row gap-sm" style={{ marginTop: 8 }}>
                {["blower", "filter"].map((role) => (
                  <button
                    key={role}
                    className={`pill${form.duct_role === role ? " active" : ""}`}
                    onClick={() => set({ duct_role: form.duct_role === role ? "" : role })}
                  >
                    {role === "blower" ? "Blower side" : "Filter side"}
                  </button>
                ))}
              </div>

              <select
                className="input"
                style={{ marginTop: 8 }}
                value={form.pairedWith}
                onChange={(e) => set({ pairedWith: e.target.value })}
              >
                <option value="">Not paired</option>
                {(allDevices || [])
                  /* Only other LoRaWAN units, and only ones that are free or
                     already paired to this device -- offering a node that is
                     half of another pair would silently break that pair. */
                  .filter((d) => d.is_lorawan && d.id !== device.id
                    && (!d.paired_device_id || d.paired_device_id === device.id))
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name || d.device_mac}{d.duct_role ? ` — ${d.duct_role} side` : ""}
                    </option>
                  ))}
              </select>
            </div>
          )}

          <div className="field">
            <label className="field-label">FILTER REPLACEMENT INTERVAL</label>
            <div className="row gap-sm">
              <input
                className="input input-sm" style={{ width: 84, textAlign: "center", fontWeight: 700 }}
                value={form.filter_interval_days} inputMode="numeric"
                onChange={(e) => set({ filter_interval_days: e.target.value.replace(/\D/g, "") })}
              />
              <span className="hint">days</span>
              <span className="grow" />
              {INTERVAL_PRESETS.map((d) => (
                <button
                  key={d}
                  className={`pill${String(form.filter_interval_days) === String(d) ? " active" : ""}`}
                  onClick={() => set({ filter_interval_days: d })}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>

          {/* Locked while the baseline is still being fitted. The warmup
              samples ARE spaced by this interval, so changing it mid-fit
              changes the spacing of the data the covariance is computed
              from -- half the baseline at one cadence and half at another,
              which is exactly the narrow/mismatched-window problem the 20h
              span requirement exists to prevent. Editable again the moment
              the baseline freezes. */}
          <div className="field">
            <label className="field-label">WAKE INTERVAL</label>
            <p className="hint">
              {calibrating
                ? "Locked while this device is calibrating — the warmup samples are spaced by this interval, so changing it now would corrupt the baseline being fitted."
                : "How often the device wakes up to collect data."}
            </p>
            <div className="row gap-sm" style={calibrating ? { opacity: 0.55 } : undefined}>
              <input
                className="input input-sm" style={{ width: 96, textAlign: "center", fontWeight: 700 }}
                value={form.wake_interval_seconds} inputMode="numeric"
                disabled={calibrating}
                onChange={(e) => set({ wake_interval_seconds: e.target.value.replace(/\D/g, "") })}
              />
              <span className="hint">seconds</span>
              <span className="grow" />
              {WAKE_PRESETS.map((p) => (
                <button
                  key={p.value}
                  className={`pill${String(form.wake_interval_seconds) === String(p.value) ? " active" : ""}`}
                  disabled={calibrating}
                  onClick={() => { if (!calibrating) set({ wake_interval_seconds: p.value }); }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {calibrating && (
              <p className="hint" style={{ marginTop: 6 }}>
                <Icon name="pulse" size={12} /> Calibrating — unlocks once the baseline finishes.
              </p>
            )}
          </div>

          <div className="field">
            <label className="field-label">TENANT NOTIFICATIONS</label>
            <div className="row" style={{ background: "var(--inputBg)", borderRadius: 12, padding: "12px 14px" }}>
              <div className="grow">
                <div style={{ fontSize: 14, fontWeight: 600 }}>Notify tenant</div>
                <p className="hint">Tenant is emailed and/or texted when the filter needs changing.</p>
              </div>
              <button
                className={`switch${form.tenantEnabled ? " on" : ""}`}
                onClick={() => set({ tenantEnabled: !form.tenantEnabled })}
                aria-label="Toggle tenant notifications"
              />
            </div>
            {form.tenantEnabled && (
              <>
                <input
                  className="input" type="email" placeholder="tenant@example.com"
                  value={form.tenant_email} style={{ marginTop: 8 }}
                  onChange={(e) => set({ tenant_email: e.target.value })}
                />
                <input
                  className="input" type="tel" placeholder="+1 555 123 4567 (optional, for SMS)"
                  value={form.tenant_phone} style={{ marginTop: 8 }}
                  onChange={(e) => set({ tenant_phone: e.target.value })}
                />
              </>
            )}
          </div>
        </>
      )}

      {!isOwner && (
        <p className="hint">
          You have technician access to this device — you can update its name and location only.
        </p>
      )}
    </Modal>
  );
}
