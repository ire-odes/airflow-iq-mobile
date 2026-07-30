import { useEffect, useState } from "react";
import Icon from "../components/Icon";
import Modal, { ConfirmModal } from "../components/Modal";
import { supabase } from "../lib/supabase";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { APP_VERSION } from "../lib/config";
import {
  SUBSCRIPTION_PLANS, fetchSubscription, isSubscriptionActive,
  openBillingPortal, startSubscriptionCheckout, deleteAccount,
} from "../lib/billing";

// Same storage key and value shape the mobile app's notifications module uses,
// so a threshold set here reads back the same way conceptually.
const THRESHOLDS_KEY = "notif_thresholds";

const THRESHOLDS = [
  { key: "temp_c",      label: "Temperature", unit: "°F",   icon: "thermometer", color: "#FF6B6B", defaultMin: 59,  defaultMax: 86 },
  { key: "humidity",    label: "Humidity",    unit: "%",    icon: "droplet",     color: "#45B7D1", defaultMin: 25,  defaultMax: 65 },
  { key: "pressure_pa", label: "Pressure",    unit: " hPa", icon: "gauge",       color: "#4ECDC4", defaultMin: 950, defaultMax: 1050 },
  { key: "windspeed",   label: "Wind Speed",  unit: " m/s", icon: "wind",        color: "#96CEB4", defaultMin: 0,   defaultMax: 8 },
];

const loadThresholds = () => {
  try { return JSON.parse(localStorage.getItem(THRESHOLDS_KEY) || "{}"); }
  catch { return {}; }
};

export default function Account() {
  const { session, signOut, technicianAssignments, refreshTechnicianAssignments } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const userId = session?.user?.id;
  const email = session?.user?.email || "";

  const [displayName, setDisplayName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [savingName, setSavingName] = useState(false);

  const [thresholds, setThresholds] = useState(loadThresholds);

  const [myTechnician, setMyTechnician] = useState(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState(null);
  const [landlordNames, setLandlordNames] = useState({});

  const [subscription, setSubscription] = useState(null);
  const [subBusy, setSubBusy] = useState(false);
  const [subError, setSubError] = useState(null);

  const [passwordOpen, setPasswordOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2600); };

  useEffect(() => {
    if (!userId) return;

    supabase.from("profiles").select("full_name").eq("id", userId).maybeSingle()
      .then(({ data }) => setDisplayName(data?.full_name || ""));

    supabase.from("technician_assignments").select("id, technician_email")
      .eq("landlord_id", userId).maybeSingle()
      .then(({ data }) => setMyTechnician(data || null));

    // Absent subscriptions table / no row both mean "free plan" — not an error.
    fetchSubscription(userId)
      .then(setSubscription)
      .catch((e) => console.warn("loadSubscription:", e.message));
  }, [userId]);

  // Resolve the display names of landlords this user works for.
  useEffect(() => {
    if (!technicianAssignments.length) return;
    supabase.from("profiles").select("id, full_name")
      .in("id", technicianAssignments.map((a) => a.landlord_id))
      .then(({ data }) => {
        const map = {};
        (data || []).forEach((p) => { map[p.id] = p.full_name || "Your landlord"; });
        setLandlordNames(map);
      });
  }, [technicianAssignments]);

  const saveName = async () => {
    if (!displayName.trim()) return flash("Display name cannot be empty");
    setSavingName(true);
    const { error } = await supabase.from("profiles")
      .update({ full_name: displayName.trim() }).eq("id", userId);
    setSavingName(false);
    if (error) return flash("Failed to update profile");
    setEditingName(false);
    flash("Profile updated");
  };

  const persistThreshold = (key, patch) => {
    setThresholds((prev) => {
      const next = { ...prev, [key]: { ...prev[key], ...patch } };
      localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(next));
      return next;
    });
  };

  const inviteTechnician = async () => {
    const clean = inviteEmail.toLowerCase().trim();
    if (!clean.includes("@")) return setInviteError("Enter a valid email address");

    setInviteBusy(true); setInviteError(null);
    const { error } = await supabase.from("technician_assignments")
      .insert({ landlord_id: userId, technician_email: clean });
    setInviteBusy(false);

    if (error) {
      // 23505 = unique violation, i.e. this email is already the technician.
      return setInviteError(error.code === "23505"
        ? "That email is already your technician."
        : error.message);
    }

    setInviteEmail("");
    const { data } = await supabase.from("technician_assignments")
      .select("id, technician_email").eq("landlord_id", userId).maybeSingle();
    setMyTechnician(data || null);
    refreshTechnicianAssignments();
    flash("Technician invited");
  };

  const removeTechnician = () => setConfirm({
    title: "Remove technician",
    message: `Remove ${myTechnician.technician_email} as your technician? They will lose access to your devices.`,
    confirmLabel: "Remove",
    danger: true,
    action: async () => {
      await supabase.from("technician_assignments").delete().eq("id", myTechnician.id);
      setMyTechnician(null);
      refreshTechnicianAssignments();
    },
  });

  const confirmSignOut = () => setConfirm({
    title: "Sign out",
    message: "Are you sure you want to sign out?",
    confirmLabel: "Sign Out",
    danger: true,
    action: signOut,
  });

  const runConfirm = async () => {
    setBusy(true);
    await confirm.action();
    setBusy(false);
    setConfirm(null);
  };

  const initial = (displayName || email || "?")[0].toUpperCase();

  return (
    <>
      <header className="topbar topbar-gradient">
        <div className="topbar-titles">
          <div className="topbar-eyebrow">Settings</div>
          <h1 className="topbar-title">Account</h1>
        </div>
        <div className="topbar-actions">
          {toast && <span className="badge" style={{ background: "#22c55e22", color: "#16a34a" }}>{toast}</span>}
          <button className="btn btn-danger" onClick={confirmSignOut}>
            <Icon name="logout" size={15} /> Sign Out
          </button>
        </div>
      </header>

      <div className="page" style={{ maxWidth: 860 }}>
        {/* Identity banner */}
        <div
          className="row"
          style={{
            background: "linear-gradient(120deg, #0b2f66, #007BFF)",
            borderRadius: 20, padding: 24, color: "#fff", marginBottom: 26, gap: 18,
          }}
        >
          <div className="avatar" style={{ width: 62, height: 62, borderRadius: 20, fontSize: 26, background: "rgba(255,255,255,0.24)" }}>
            {initial}
          </div>
          <div className="grow">
            <h2 style={{ fontSize: 22, fontWeight: 800 }}>{displayName || "Your Account"}</h2>
            <p style={{ fontSize: 13.5, opacity: 0.82, marginTop: 2 }}>{email}</p>
          </div>
        </div>

        {/* Profile */}
        <div className="section-head"><h2 className="section-title">Profile</h2></div>
        <div className="card">
          <div className="list-row">
            <div className="list-icon"><Icon name="user" size={17} /></div>
            <div className="grow">
              <div className="list-label">DISPLAY NAME</div>
              {editingName ? (
                <input
                  className="input input-sm" style={{ marginTop: 4 }} value={displayName} autoFocus
                  onChange={(e) => setDisplayName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveName(); }}
                />
              ) : (
                <div className="list-value">{displayName || "Not set"}</div>
              )}
            </div>
            <button className="link-btn" onClick={() => (editingName ? saveName() : setEditingName(true))}>
              {savingName ? <span className="spinner" /> : editingName ? "Save" : "Edit"}
            </button>
          </div>

          <div className="list-row">
            <div className="list-icon"><Icon name="mail" size={17} /></div>
            <div className="grow">
              <div className="list-label">EMAIL</div>
              <div className="list-value truncate">{email}</div>
            </div>
          </div>

          <div className="list-row">
            <div className="list-icon"><Icon name="fingerprint" size={17} /></div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="list-label">USER ID</div>
              <div className="list-value mono truncate" style={{ fontSize: 12.5, color: "var(--subtext)" }}>{userId}</div>
            </div>
          </div>
        </div>

        {/* Subscription */}
        <div className="section-head"><h2 className="section-title">Subscription</h2></div>
        <SubscriptionCard
          subscription={subscription}
          busy={subBusy}
          error={subError}
          onUpgrade={async () => {
            setSubBusy(true); setSubError(null);
            try { await startSubscriptionCheckout(); }
            catch (e) { setSubError(e.message); setSubBusy(false); }
          }}
          onManage={async () => {
            setSubBusy(true); setSubError(null);
            try { await openBillingPortal(); }
            catch (e) { setSubError(e.message); setSubBusy(false); }
          }}
        />

        {/* Appearance */}
        <div className="section-head"><h2 className="section-title">Appearance</h2></div>
        <div className="card">
          <div className="list-row">
            <div className="list-icon"><Icon name={isDark ? "moon" : "sun"} size={17} /></div>
            <div className="grow">
              <div className="list-value">Dark mode</div>
              <div className="list-label" style={{ marginTop: 2 }}>{isDark ? "On" : "Off"}</div>
            </div>
            <button className={`switch${isDark ? " on" : ""}`} onClick={toggleTheme} aria-label="Toggle dark mode" />
          </div>
        </div>

        {/* Thresholds */}
        <div className="section-head">
          <div>
            <h2 className="section-title">Alert Thresholds</h2>
            <p className="section-sub">Flag readings that fall outside your set range.</p>
          </div>
        </div>
        <div className="card">
          {THRESHOLDS.map((t) => {
            const saved = thresholds[t.key] || {};
            const enabled = saved.enabled ?? false;
            const min = saved.min ?? t.defaultMin;
            const max = saved.max ?? t.defaultMax;
            return (
              <div className="list-row" key={t.key}>
                <div className="list-icon" style={{ background: `${t.color}22`, color: t.color }}>
                  <Icon name={t.icon} size={16} />
                </div>
                <div className="grow">
                  <div className="list-value">{t.label}</div>
                  {enabled && (
                    <div className="row gap-sm" style={{ marginTop: 7 }}>
                      <span className="hint">Min</span>
                      <input
                        className="input input-sm" style={{ width: 76, textAlign: "center" }}
                        value={min} inputMode="decimal"
                        onChange={(e) => persistThreshold(t.key, { enabled, min: e.target.value, max })}
                      />
                      <span className="hint">{t.unit}</span>
                      <span style={{ width: 8 }} />
                      <span className="hint">Max</span>
                      <input
                        className="input input-sm" style={{ width: 76, textAlign: "center" }}
                        value={max} inputMode="decimal"
                        onChange={(e) => persistThreshold(t.key, { enabled, min, max: e.target.value })}
                      />
                      <span className="hint">{t.unit}</span>
                    </div>
                  )}
                </div>
                <button
                  className={`switch${enabled ? " on" : ""}`}
                  onClick={() => persistThreshold(t.key, { enabled: !enabled, min, max })}
                  aria-label={`Toggle ${t.label} alerts`}
                />
              </div>
            );
          })}
        </div>

        {/* Security */}
        <div className="section-head"><h2 className="section-title">Security</h2></div>
        <div className="card">
          <button className="list-row" style={{ width: "100%", textAlign: "left" }} onClick={() => setPasswordOpen(true)}>
            <div className="list-icon"><Icon name="lock" size={17} /></div>
            <div className="grow"><div className="list-value">Change password</div></div>
            <Icon name="chevron-right" size={17} style={{ color: "var(--subtext)" }} />
          </button>
        </div>

        {/* Team */}
        <div className="section-head">
          <div>
            <h2 className="section-title">Team</h2>
            <p className="section-sub">
              {myTechnician
                ? "Your technician can view all devices and edit names and locations."
                : "Invite a technician to help manage your devices."}
            </p>
          </div>
        </div>
        <div className="card">
          {myTechnician ? (
            <div className="list-row">
              <div className="list-icon" style={{ background: "#0284c71f", color: "#0284c7" }}>
                <Icon name="wrench" size={17} />
              </div>
              <div className="grow">
                <div className="list-label">TECHNICIAN</div>
                <div className="list-value truncate">{myTechnician.technician_email}</div>
              </div>
              <button className="btn btn-sm btn-danger" onClick={removeTechnician}>Remove</button>
            </div>
          ) : (
            <div className="list-row">
              <div className="list-icon"><Icon name="users" size={17} /></div>
              <div className="grow">
                <div className="list-label">TECHNICIAN EMAIL</div>
                <input
                  className="input input-sm" style={{ marginTop: 4 }} type="email"
                  placeholder="technician@example.com" value={inviteEmail}
                  onChange={(e) => { setInviteEmail(e.target.value); setInviteError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") inviteTechnician(); }}
                />
                {inviteError && (
                  <p className="hint" style={{ color: "#ef4444", marginTop: 5 }}>{inviteError}</p>
                )}
              </div>
              <button className="btn btn-sm btn-primary" onClick={inviteTechnician} disabled={inviteBusy}>
                {inviteBusy ? <span className="spinner" /> : "Invite"}
              </button>
            </div>
          )}
        </div>

        {technicianAssignments.length > 0 && (
          <>
            <p className="hint" style={{ margin: "14px 2px 8px" }}>
              You have technician access to the following accounts:
            </p>
            <div className="card">
              {technicianAssignments.map((a) => (
                <div className="list-row" key={a.id}>
                  <div className="list-icon" style={{ background: "#0284c71f", color: "#0284c7" }}>
                    <Icon name="home" size={17} />
                  </div>
                  <div className="grow">
                    <div className="list-label">LANDLORD</div>
                    <div className="list-value">{landlordNames[a.landlord_id] || a.technician_email}</div>
                  </div>
                  <span className="badge" style={{ background: "#0284c71f", color: "#0284c7" }}>
                    <Icon name="wrench" size={11} /> Technician
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Danger zone */}
        <div className="section-head"><h2 className="section-title">Danger Zone</h2></div>
        <div className="card" style={{ borderColor: "#ef444455" }}>
          <button className="list-row" style={{ width: "100%", textAlign: "left" }} onClick={() => setDeleteOpen(true)}>
            <div className="list-icon" style={{ background: "#ef44441f", color: "#ef4444" }}>
              <Icon name="trash" size={17} />
            </div>
            <div className="grow">
              <div className="list-value" style={{ color: "#ef4444" }}>Delete account</div>
              <div className="list-label" style={{ marginTop: 2 }}>
                Permanently delete your account and cancel any subscription
              </div>
            </div>
            <Icon name="chevron-right" size={17} style={{ color: "var(--subtext)" }} />
          </button>
        </div>

        <p className="hint" style={{ textAlign: "center", marginTop: 30 }}>
          AirFlow IQ Desktop v{APP_VERSION}
        </p>
      </div>

      <ChangePasswordModal open={passwordOpen} onClose={() => setPasswordOpen(false)} onDone={() => flash("Password changed")} />

      <DeleteAccountModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onDeleted={signOut}
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

function SubscriptionCard({ subscription, busy, error, onUpgrade, onManage }) {
  const active = isSubscriptionActive(subscription);
  const plan = active ? SUBSCRIPTION_PLANS.pro : SUBSCRIPTION_PLANS.free;
  const accent = active ? "#7c3aed" : "var(--subtext)";

  const renewal = subscription?.current_period_end
    ? new Date(subscription.current_period_end).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      })
    : null;

  return (
    <div className="card card-pad">
      {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}

      <div className="row" style={{ alignItems: "flex-start", marginBottom: 15 }}>
        <div
          className="list-icon"
          style={{ width: 42, height: 42, borderRadius: 13, background: `${active ? "#7c3aed" : "#6b7280"}1f`, color: accent }}
        >
          <Icon name={active ? "crown" : "user"} size={19} />
        </div>
        <div className="grow">
          <div className="row gap-sm">
            <span style={{ fontSize: 16, fontWeight: 800 }}>{plan.name}</span>
            {plan.priceLabel && active && (
              <span className="badge" style={{ background: "#7c3aed1f", color: "#7c3aed" }}>
                {plan.priceLabel}
              </span>
            )}
            {subscription?.status && subscription.status !== "active" && (
              <span className="badge" style={{ background: "#f59e0b1f", color: "#f59e0b" }}>
                {subscription.status.replace(/_/g, " ")}
              </span>
            )}
          </div>
          <p className="hint" style={{ marginTop: 3 }}>
            {active
              ? subscription?.cancel_at_period_end
                ? `Cancels at the end of the current period${renewal ? ` — ${renewal}` : ""}.`
                : renewal ? `Renews ${renewal}.` : "Your Pro plan is active."
              : "You're on the free plan."}
          </p>
        </div>

        {active ? (
          <button className="btn" onClick={onManage} disabled={busy}>
            {busy ? <span className="spinner" /> : <><Icon name="card" size={15} /> Manage billing</>}
          </button>
        ) : (
          <button className="btn btn-primary" onClick={onUpgrade} disabled={busy}>
            {busy ? <span className="spinner" /> : <><Icon name="crown" size={15} /> Upgrade to Pro</>}
          </button>
        )}
      </div>

      {/* When on free, show what Pro adds rather than what they already have. */}
      <div style={{ borderTop: "1px solid var(--divider)", paddingTop: 14 }}>
        <div className="field-label" style={{ marginBottom: 9 }}>
          {active ? "INCLUDED IN PRO" : "PRO INCLUDES"}
        </div>
        <div className="feature-grid">
          {SUBSCRIPTION_PLANS.pro.features.map((f) => (
            <div className="row" key={f} style={{ gap: 8, fontSize: 13 }}>
              <Icon
                name={active ? "success" : "check"}
                size={14}
                style={{ color: active ? "#22c55e" : "var(--subtext)", flexShrink: 0 }}
              />
              <span>{f}</span>
            </div>
          ))}
        </div>
      </div>

      <p className="hint" style={{ marginTop: 12, fontSize: 11.5 }}>
        Billing is handled by Stripe. You'll be redirected to their hosted page — card details never touch this app.
      </p>
    </div>
  );
}

function ChangePasswordModal({ open, onClose, onDone }) {
  const [pass, setPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) { setPass(""); setConfirmPass(""); setError(null); }
  }, [open]);

  const submit = async () => {
    if (pass.length < 6) return setError("Password must be at least 6 characters");
    if (pass !== confirmPass) return setError("Passwords do not match");

    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pass });
    setBusy(false);
    if (error) return setError(error.message);
    onDone();
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change Password"
      subtitle="Must be at least 6 characters"
      icon="lock"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? <span className="spinner" /> : "Change Password"}
          </button>
        </>
      }
    >
      {error && <div className="auth-error">{error}</div>}
      <div className="field">
        <label className="field-label">NEW PASSWORD</label>
        <input className="input" type="password" value={pass} autoFocus autoComplete="new-password"
          onChange={(e) => setPass(e.target.value)} />
      </div>
      <div className="field">
        <label className="field-label">CONFIRM PASSWORD</label>
        <input className="input" type="password" value={confirmPass} autoComplete="new-password"
          onChange={(e) => setConfirmPass(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
      </div>
    </Modal>
  );
}

function DeleteAccountModal({ open, onClose, onDeleted }) {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { if (open) { setConfirmText(""); setError(null); } }, [open]);

  const canDelete = confirmText.trim().toUpperCase() === "DELETE";

  const submit = async () => {
    if (!canDelete) return;
    setBusy(true); setError(null);
    try {
      await deleteAccount();
      onDeleted();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Delete Account"
      subtitle="This cannot be undone"
      icon="warning"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-danger" onClick={submit} disabled={busy || !canDelete}>
            {busy ? <span className="spinner" /> : "Delete My Account"}
          </button>
        </>
      }
    >
      {error && <div className="auth-error">{error}</div>}
      <p className="hint" style={{ fontSize: 13.5 }}>
        This permanently deletes your login. Any devices you own are unclaimed (not
        destroyed — the hardware and its history stay put, and it can be claimed again
        later), any properties you own are deleted, and any active subscription is
        canceled immediately.
      </p>
      <div className="field">
        <label className="field-label">TYPE "DELETE" TO CONFIRM</label>
        <input
          className="input" value={confirmText} autoFocus
          onChange={(e) => setConfirmText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && canDelete) submit(); }}
          placeholder="DELETE"
        />
      </div>
    </Modal>
  );
}
