import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink } from "react-router-dom";
import Icon from "../components/Icon";
import Modal, { ConfirmModal } from "../components/Modal";
import { supabase } from "../lib/supabase";
import { useAuth } from "../context/AuthContext";
import { useScope, UNASSIGNED_ID } from "../context/ScopeContext";
import { getFilterProgress, getOnlineStatus } from "../lib/metrics";
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
          .eq("device_id", dev.id).not("rfid", "is", null)
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
  }, [devices]);

  useEffect(() => { loadStats(); }, [loadStats]);

  const refresh = async () => { await reload(); await loadStats(); };

  // ── Mutations ──────────────────────────────────────────────────────────────
  const saveDevice = async (form) => {
    setBusy(true);
    const { error } = await supabase.from("devices").update(form).eq("id", editingDevice.id);
    setBusy(false);
    if (error) return alert(`Failed to update device: ${error.message}`);
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
  const recalibrateDevice = (device) => setConfirm({
    title: "Recalibrate microphone",
    message: `Reset the acoustic baseline for "${device.name || device.device_mac}"? It will start relearning "normal" from scratch, so acoustic verdicts go quiet for a while until it warms back up.`,
    confirmLabel: "Recalibrate",
    danger: true,
    action: async () => {
      // .select() makes RLS-blocked deletes visible: 0 rows back = not reset
      const { data, error } = await supabase
        .from("device_baselines").delete().eq("device_mac", device.device_mac).select("device_mac");
      if (error) return alert(`Failed to recalibrate: ${error.message}`);
      if (!data || data.length === 0) {
        return alert("This device has no existing baseline yet, or you don't have permission to reset it.");
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
          {propDevices.map((d) => (
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
          ))}
        </div>
      )}
    </div>
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

  // Battery is reported as a raw cell voltage; 2.8–3.2V maps to 0–100%.
  const volts = latest?.battery;
  const battPct = volts != null
    ? Math.min(100, Math.max(0, Math.round(((volts - 2.8) / 0.4) * 100)))
    : null;
  const battColor = battPct == null ? "#9ca3af"
    : battPct <= 10 ? "#ef4444" : battPct <= 25 ? "#f97316" : battPct <= 50 ? "#f59e0b" : "#22c55e";

  return (
    <article className="card device-card">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="list-icon" style={{ width: 42, height: 42, borderRadius: 13 }}>
          <Icon name="device" size={20} />
        </div>
        <div className="grow">
          <div className="row gap-sm">
            <span className="device-name truncate">{device.name || "Unnamed Device"}</span>
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
          {battPct != null && (
            <span className="row" style={{ gap: 4, fontSize: 11.5, fontWeight: 700, color: battColor }}>
              <Icon name="battery" size={13} /> {battPct}%
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

function EditDeviceModal({ device, properties, onClose, onSave, busy, schemaReady }) {
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
          wake_interval_seconds: wake,
          tenant_email: form.tenantEnabled ? form.tenant_email.trim().toLowerCase() : null,
          tenant_phone: form.tenantEnabled ? form.tenant_phone.trim() : null,
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

          <div className="field">
            <label className="field-label">WAKE INTERVAL</label>
            <p className="hint">How often the device wakes up to collect data.</p>
            <div className="row gap-sm">
              <input
                className="input input-sm" style={{ width: 96, textAlign: "center", fontWeight: 700 }}
                value={form.wake_interval_seconds} inputMode="numeric"
                onChange={(e) => set({ wake_interval_seconds: e.target.value.replace(/\D/g, "") })}
              />
              <span className="hint">seconds</span>
              <span className="grow" />
              {WAKE_PRESETS.map((p) => (
                <button
                  key={p.value}
                  className={`pill${String(form.wake_interval_seconds) === String(p.value) ? " active" : ""}`}
                  onClick={() => set({ wake_interval_seconds: p.value })}
                >
                  {p.label}
                </button>
              ))}
            </div>
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
