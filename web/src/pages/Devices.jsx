import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import Icon from "../components/Icon";
import Modal, { ConfirmModal } from "../components/Modal";
import DeviceTree from "../components/DeviceTree";
import { supabase } from "../lib/supabase";
import { useAuth } from "../context/AuthContext";
import { useScope, UNASSIGNED_ID } from "../context/ScopeContext";
import { groupPairs } from "../lib/devicePairs";
import { getFilterProgress, getOnlineStatus, getBatteryStage } from "../lib/metrics";
import { timeAgo, wakeLabel } from "../lib/format";
import {
  DEFAULT_FILTER_INTERVAL_DAYS,
  FILTER_INTERVAL_MIN_DAYS, FILTER_INTERVAL_MAX_DAYS,
} from "../lib/config";

export default function Devices() {
  const { grouped, devices, properties, schemaReady, reload, loading } = useScope();
  const { session } = useAuth();

  // Interactive Landlord Acknowledgements (Account settings). Gates the
  // "Mark filter changed" button; the database checks it again server-side.
  const [acksEnabled, setAcksEnabled] = useState(false);
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    supabase.from("profiles").select("interactive_landlord_acks").eq("id", uid).maybeSingle()
      .then(({ data }) => setAcksEnabled(!!data?.interactive_landlord_acks));
  }, [session?.user?.id]);

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

  // Persisted so the tree survives navigating away and back. Someone who
  // works from the hierarchy shouldn't have to reopen it on every visit.
  const [treeOpen, setTreeOpen] = useState(
    () => localStorage.getItem("devices_tree_open") === "1"
  );
  useEffect(() => {
    localStorage.setItem("devices_tree_open", treeOpen ? "1" : "0");
  }, [treeOpen]);

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

    // An acknowledged filter change restarts the clock exactly as a new RFID
    // tag does, so the later of the two is the effective install date. Same
    // rule as device_filter_cycles() in the database, so the bar and the
    // emails agree on when a filter is due.
    const { data: acks } = await supabase.from("filter_acknowledgements")
      .select("device_id, acknowledged_at").in("device_id", devices.map((d) => d.id));
    for (const a of acks || []) {
      const prev = nextInstall[a.device_id];
      if (!prev || new Date(a.acknowledged_at) > new Date(prev)) nextInstall[a.device_id] = a.acknowledged_at;
    }

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
      for (const k of ["property_id", "filter_interval_days"]) {
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

  // Owner confirms the filter was replaced without waiting for a new RFID tag
  // to be read. Restarts the filter clock and stops any overdue reminders.
  const acknowledgeFilter = (device) => setConfirm({
    title: "Mark filter changed",
    message: `Confirm the HVAC filter for "${device.name || device.device_mac}" has been replaced? This stops any overdue reminders and restarts its filter life.`,
    confirmLabel: "Mark changed",
    action: async () => {
      const { error } = await supabase.rpc("acknowledge_filter_change", { p_device_id: device.id });
      if (error) return alert(`Could not record the change: ${error.message}`);
      await loadStats();
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
          <button
            className={`btn${treeOpen ? " btn-primary" : ""}`}
            onClick={() => setTreeOpen((o) => !o)}
            aria-expanded={treeOpen}
            title="Show the property and device hierarchy"
          >
            <Icon name="tree" size={15} /> Device Tree
            <Icon name={treeOpen ? "chevron-up" : "chevron-down"} size={14} />
          </button>
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

        {/* Sits above the card grid rather than replacing it: the tree answers
            "how is the fleet wired together", the cards answer "what state is
            each device in", and reading one usually prompts a look at the
            other. */}
        {treeOpen && !loading && (
          <DeviceTree grouped={grouped} onEdit={setEditingDevice} />
        )}

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
                onRecalibrate={recalibrateDevice} onAcknowledge={acksEnabled ? acknowledgeFilter : null}
              />
            ))}

            {technicianGroups.length > 0 && (
              <>
                <div className="section-head label-head">
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
                    onRecalibrate={recalibrateDevice} onAcknowledge={acksEnabled ? acknowledgeFilter : null}
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

// ── One property and its devices ─────────────────────────────────────────────
function PropertyGroupCard({ property, propDevices, stats, installDates, onEdit, onRemove, onRecalibrate, onAcknowledge }) {
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
                onAcknowledge={onAcknowledge ? () => onAcknowledge(d) : null}
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
// "a@x.com", "a@x.com +2", or "No tenant".
const tenantSummary = (d) => {
  const list = d.tenant_emails?.length ? d.tenant_emails : d.tenant_email ? [d.tenant_email] : [];
  if (!list.length) return "No tenant";
  return list.length === 1 ? list[0] : `${list[0]} +${list.length - 1}`;
};

function DeviceCard({ device, lastSeen, latest, installedAt, onEdit, onRemove, onRecalibrate, onAcknowledge }) {
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
          <div className="row gap-sm device-title-row">
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

      <div className="row wrap device-info-row" style={{ background: "var(--inputBg)", borderRadius: 11, padding: 10, gap: 14 }}>
        <span className="meta-row"><Icon name="clock" size={13} /> Filter every {device.filter_interval_days || DEFAULT_FILTER_INTERVAL_DAYS}d</span>
        <span className="meta-row"><Icon name="pulse" size={13} /> Wake {wakeLabel(device.wake_interval_seconds)}</span>
        <span className="meta-row truncate">
          <Icon name="user" size={13} /> {tenantSummary(device)}
        </span>
      </div>

      <div className="row gap-sm wrap">
        <button className="btn btn-sm" onClick={onEdit}><Icon name="pencil" size={13} /> Edit</button>
        {device._isOwner && (
          <button className="btn btn-sm" onClick={onRecalibrate} title="Reset the acoustic baseline">
            <Icon name="refresh" size={13} /> Recalibrate
          </button>
        )}
        {/* Offered once the filter is nearly due, which covers overdue too. */}
        {device._isOwner && onAcknowledge && fp && fp.pct >= 90 && (
          <button className="btn btn-sm" onClick={onAcknowledge} title="Confirm the filter was replaced">
            <Icon name="check" size={13} /> Mark filter changed
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
const INTERVAL_PRESETS = [7, 14, 21, 30];

// Matches devices_tenant_emails_max and the format check in sync_tenant_emails.
const MAX_TENANTS = 10;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const wakeText = (s) => {
  const h = (s || 14400) / 3600;
  if (h === 24) return "Once a day";
  return Number.isInteger(h) ? `Every ${h} hour${h === 1 ? "" : "s"}` : `Every ${wakeLabel(s)}`;
};

function EditDeviceModal({ device, properties, allDevices, onClose, onSave, busy, schemaReady, calibrating }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [testState, setTestState] = useState(null);   // null | "sending" | "sent"
  const [testMsg, setTestMsg] = useState(null);

  useEffect(() => {
    if (!device) return setForm(null);
    setError(null);
    setTestState(null);
    setTestMsg(null);
    setForm({
      name: device.name || "",
      hvac_location: device.hvac_location || "",
      property_id: device.property_id || "",
      filter_interval_days: device.filter_interval_days || DEFAULT_FILTER_INTERVAL_DAYS,
      tenant_emails: device.tenant_emails?.length
        ? [...device.tenant_emails]
        : device.tenant_email ? [device.tenant_email] : [],
      newTenant: "",
      tenant_phone: device.tenant_phone || "",
      tenantEnabled: !!(device.tenant_emails?.length || device.tenant_email || device.tenant_phone),
      duct_role: device.duct_role || "",
      pairedWith: device.paired_device_id || "",
    });
  }, [device]);

  if (!device || !form) return null;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const isOwner = device._isOwner;

  const addTenant = () => {
    const em = form.newTenant.trim().toLowerCase();
    if (!em) return;
    if (!EMAIL_RE.test(em)) return setError(`"${em}" isn't a valid email`);
    if (form.tenant_emails.includes(em)) return set({ newTenant: "" });
    if (form.tenant_emails.length >= MAX_TENANTS) return setError(`Up to ${MAX_TENANTS} tenant emails per unit`);
    setError(null);
    set({ tenant_emails: [...form.tenant_emails, em], newTenant: "" });
  };

  // Sends to the SAVED addresses -- the server reads the list from the device,
  // so a test can't be pointed at an address that was typed but never saved.
  const sendTest = async () => {
    setTestState("sending");
    setTestMsg(null);
    const { data, error: e } = await supabase.rpc("send_tenant_test_email", { p_device_id: device.id });
    if (e) { setTestState(null); setTestMsg(e.message); return; }
    setTestState("sent");
    setTestMsg(`Queued ${data} test email${data === 1 ? "" : "s"} to the saved tenant addresses. They should arrive within a couple of minutes.`);
  };

  const submit = () => {
    if (!form.name.trim()) return setError("Device name is required");

    const interval = parseInt(form.filter_interval_days, 10) || DEFAULT_FILTER_INTERVAL_DAYS;
    if (interval < FILTER_INTERVAL_MIN_DAYS || interval > FILTER_INTERVAL_MAX_DAYS) {
      return setError(`Filter interval must be between ${FILTER_INTERVAL_MIN_DAYS} and ${FILTER_INTERVAL_MAX_DAYS} days`);
    }

    // An address typed but not yet added still counts, so someone who types it
    // and presses Save doesn't silently lose it.
    const pending = form.newTenant.trim().toLowerCase();
    if (form.tenantEnabled && pending && !EMAIL_RE.test(pending)) {
      return setError(`"${pending}" isn't a valid email`);
    }
    const tenantEmails = form.tenantEnabled
      ? [...new Set([...form.tenant_emails, ...(pending ? [pending] : [])])]
      : [];
    if (tenantEmails.length > MAX_TENANTS) return setError(`Up to ${MAX_TENANTS} tenant emails per unit`);

    // Technicians may only rename/relocate; owner-only fields are left alone.
    const payload = isOwner
      ? {
          name: form.name.trim(),
          hvac_location: form.hvac_location.trim(),
          property_id: form.property_id || null,
          filter_interval_days: interval,
          // wake_interval_seconds is deliberately NOT written here. It is set
          // by AirFlow IQ, and trg_guard_wake_interval (20260911000000)
          // rejects changes from anyone who isn't an admin.
          //
          // tenant_email is derived from this list by trg_sync_tenant_emails
          // (it stays the first address, for the Expo app, which reads one).
          tenant_emails: tenantEmails,
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

          {/* Wake interval is set by AirFlow IQ (4 hours unless an admin sets an
              exception for the unit) and is no longer
              user-editable. It is a battery decision, not a preference: at
              the measured 7.3s active cycle a device burns ~35 mAh a day at
              10-minute wakes against ~1.5 mAh at 4 hours -- a 24x difference
              in the one term anyone controls. Leaving it adjustable meant a
              single edit could cut field life by an order of magnitude, and
              the battery ADC is not trustworthy enough (see the calibration
              warning in the firmware) for anyone to notice before the device
              went quiet.
              Shown read-only rather than hidden, so the cadence behind the
              readings stays discoverable. */}
          <div className="field">
            <label className="field-label">WAKE INTERVAL</label>
            <div className="row" style={{ background: "var(--inputBg)", borderRadius: 12, padding: "12px 14px" }}>
              <Icon name="pulse" size={15} style={{ color: "var(--subtext)" }} />
              <div className="grow">
                <div style={{ fontWeight: 700 }}>{wakeText(device.wake_interval_seconds)}</div>
                <p className="hint" style={{ marginTop: 2 }}>
                  Set by AirFlow IQ to protect battery life. While
                  calibrating, a device samples every minute automatically and
                  then returns to this schedule.
                </p>
              </div>
              <Icon name="lock" size={15} style={{ color: "var(--subtext)" }} />
            </div>
          </div>

          <div className="field">
            <label className="field-label">TENANT NOTIFICATIONS</label>
            <div className="row" style={{ background: "var(--inputBg)", borderRadius: 12, padding: "12px 14px" }}>
              <div className="grow">
                <div style={{ fontSize: 14, fontWeight: 600 }}>Notify tenant</div>
                <p className="hint">Tenants are emailed when the filter is due, then daily for 5 days if it goes overdue.</p>
              </div>
              <button
                className={`switch${form.tenantEnabled ? " on" : ""}`}
                onClick={() => set({ tenantEnabled: !form.tenantEnabled })}
                aria-label="Toggle tenant notifications"
              />
            </div>
            {form.tenantEnabled && (
              <>
                <div className="tenant-list">
                  {form.tenant_emails.map((em) => (
                    <span key={em} className="tenant-chip">
                      <span className="truncate">{em}</span>
                      <button
                        type="button" aria-label={`Remove ${em}`}
                        onClick={() => set({ tenant_emails: form.tenant_emails.filter((x) => x !== em) })}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="row gap-sm" style={{ marginTop: 8 }}>
                  <input
                    className="input grow" type="email" placeholder="tenant@example.com"
                    value={form.newTenant}
                    onChange={(e) => set({ newTenant: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTenant(); } }}
                  />
                  <button type="button" className="btn" onClick={addTenant}
                    disabled={form.tenant_emails.length >= MAX_TENANTS}>
                    <Icon name="plus" size={14} /> Add
                  </button>
                </div>
                <p className="hint" style={{ marginTop: 6 }}>
                  Up to {MAX_TENANTS} addresses. Each one gets the due-date reminder and the daily overdue notices.
                </p>
                <input
                  className="input" type="tel" placeholder="+1 555 123 4567 (optional, for SMS)"
                  value={form.tenant_phone} style={{ marginTop: 8 }}
                  onChange={(e) => set({ tenant_phone: e.target.value })}
                />
                {device.tenant_emails?.length > 0 && (
                  <button type="button" className="btn btn-sm" style={{ marginTop: 10 }}
                    onClick={sendTest} disabled={testState === "sending"}>
                    <Icon name="mail" size={13} />
                    {testState === "sending" ? "Sending…" : testState === "sent" ? "Test sent" : "Send test email"}
                  </button>
                )}
                {testMsg && <p className="hint" style={{ marginTop: 6 }}>{testMsg}</p>}
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
