import { useCallback, useEffect, useState } from "react";
import Icon from "../components/Icon";
import Modal, { ConfirmModal } from "../components/Modal";
import { supabase } from "../lib/supabase";
import { useAuth } from "../context/AuthContext";
import { useScope } from "../context/ScopeContext";

// ============================================================================
// Properties — contact info per building/site, and per-property technician
// assignments (narrower than the account-wide grant on Account → Team: a
// technician assigned here sees only this one property, not the landlord's
// whole portfolio).
// ============================================================================

export default function Properties() {
  const { session } = useAuth();
  const { properties, devices, schemaReady, reload, loading } = useScope();
  const userId = session?.user?.id;

  const [assignments, setAssignments] = useState({}); // { [propertyId]: [{id, technician_email}] }
  const [propertyModalOpen, setPropertyModalOpen] = useState(false);
  const [editingProperty, setEditingProperty] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadAssignments = useCallback(async () => {
    const { data } = await supabase.from("property_technician_assignments").select("*");
    const grouped = {};
    (data || []).forEach((a) => {
      (grouped[a.property_id] ||= []).push(a);
    });
    setAssignments(grouped);
  }, []);

  useEffect(() => { loadAssignments(); }, [loadAssignments]);

  const refresh = async () => { await reload(); await loadAssignments(); };

  const saveProperty = async (form) => {
    setBusy(true);
    const { error } = editingProperty?.id
      ? await supabase.from("properties").update(form).eq("id", editingProperty.id)
      : await supabase.from("properties").insert({ ...form, owner_id: userId });
    setBusy(false);
    if (error) return alert(`Failed to save property: ${error.message}`);
    setPropertyModalOpen(false);
    setEditingProperty(null);
    refresh();
  };

  const deleteProperty = (property) => setConfirm({
    title: "Delete property",
    message: `Delete "${property.name}"? Its devices are kept and moved to an Unassigned Property.`,
    confirmLabel: "Delete",
    danger: true,
    action: async () => {
      await supabase.from("properties").delete().eq("id", property.id);
      refresh();
    },
  });

  const addTechnician = async (property, email) => {
    const clean = email.trim().toLowerCase();
    if (!clean || !clean.includes("@")) return alert("Enter a valid email address");
    const { error } = await supabase.from("property_technician_assignments")
      .insert({ property_id: property.id, technician_email: clean });
    if (error) {
      if (error.code === "23505") alert("That technician is already assigned to this property.");
      else alert(`Failed to add technician: ${error.message}`);
      return;
    }
    loadAssignments();
  };

  const removeTechnician = async (assignment) => {
    await supabase.from("property_technician_assignments").delete().eq("id", assignment.id);
    loadAssignments();
  };

  const runConfirm = async () => {
    setBusy(true);
    await confirm.action();
    setBusy(false);
    setConfirm(null);
  };

  const owned = properties.filter((p) => p._isOwner);
  const serviced = properties.filter((p) => !p._isOwner);

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
          <h1 className="topbar-title">Properties</h1>
        </div>
        <div className="topbar-actions">
          <button
            className="btn btn-primary"
            onClick={() => { setEditingProperty(null); setPropertyModalOpen(true); }}
            disabled={!schemaReady}
          >
            <Icon name="plus" size={15} /> Add Property
          </button>
        </div>
      </header>

      <div className="page">
        {!schemaReady && (
          <div className="banner" style={{ background: "#f59e0b1a", borderColor: "#f59e0b55", color: "#f59e0b", marginBottom: 18 }}>
            <Icon name="warning" size={17} />
            <span className="grow" style={{ color: "var(--text)" }}>
              The <strong>properties</strong> table isn't set up yet. Run the migrations in{" "}
              <code className="mono">supabase/migrations/</code> in the Supabase SQL editor.
            </span>
          </div>
        )}

        {loading ? (
          <div className="col" style={{ gap: 14 }}>
            {[0, 1].map((i) => <div key={i} className="skel" style={{ height: 180, borderRadius: 18 }} />)}
          </div>
        ) : owned.length === 0 && serviced.length === 0 ? (
          <div className="card empty">
            <div className="empty-icon"><Icon name="building" size={26} /></div>
            <h3 style={{ fontSize: 19, fontWeight: 800, color: "var(--text)" }}>No properties yet</h3>
            <p className="hint">Add a property to group devices and assign technicians to it.</p>
            <button className="btn btn-primary" onClick={() => setPropertyModalOpen(true)} style={{ marginTop: 6 }}>
              Add Your First Property
            </button>
          </div>
        ) : (
          <div className="col" style={{ gap: 14 }}>
            {owned.map((p) => (
              <PropertyCard
                key={p.id}
                property={p}
                deviceCount={devices.filter((d) => d.property_id === p.id).length}
                technicians={assignments[p.id] || []}
                onEdit={() => { setEditingProperty(p); setPropertyModalOpen(true); }}
                onDelete={() => deleteProperty(p)}
                onAddTechnician={(email) => addTechnician(p, email)}
                onRemoveTechnician={removeTechnician}
              />
            ))}

            {serviced.length > 0 && (
              <>
                <div className="section-head" style={{ marginTop: 6 }}>
                  <div>
                    <h2 className="section-title">Properties You Service</h2>
                    <p className="section-sub">Read-only — you have technician access here</p>
                  </div>
                </div>
                {serviced.map((p) => (
                  <div className="card card-pad row" key={p.id}>
                    <div className="property-icon"><Icon name="building" size={17} /></div>
                    <div className="grow">
                      <div className="row gap-sm">
                        <span style={{ fontSize: 15, fontWeight: 700 }}>{p.name}</span>
                        <span className="badge" style={{ background: "#0284c71f", color: "#0284c7" }}>
                          <Icon name="wrench" size={10} /> Servicing
                        </span>
                      </div>
                      {[p.address, p.city, p.region].filter(Boolean).length > 0 && (
                        <div className="meta-row" style={{ marginTop: 3 }}>
                          <Icon name="location" size={12} />
                          {[p.address, p.city, p.region].filter(Boolean).join(", ")}
                        </div>
                      )}
                    </div>
                    <span className="badge" style={{ background: "var(--inputBg)", color: "var(--subtext)" }}>
                      {devices.filter((d) => d.property_id === p.id).length} devices
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <PropertyModal
        open={propertyModalOpen}
        property={editingProperty}
        onClose={() => { setPropertyModalOpen(false); setEditingProperty(null); }}
        onSave={saveProperty}
        busy={busy}
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

// ── One owned property: contact info + technician assignments ──────────────
function PropertyCard({ property, deviceCount, technicians, onEdit, onDelete, onAddTechnician, onRemoveTechnician }) {
  const [emailInput, setEmailInput] = useState("");
  const [adding, setAdding] = useState(false);

  const submitAdd = async () => {
    if (!emailInput.trim()) return;
    setAdding(true);
    await onAddTechnician(emailInput);
    setAdding(false);
    setEmailInput("");
  };

  return (
    <section className="card card-pad" style={{ display: "flex", flexDirection: "column", gap: 15 }}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="property-icon"><Icon name="building" size={17} /></div>
        <div className="grow">
          <div className="row gap-sm">
            <h3 style={{ fontSize: 16, fontWeight: 800 }}>{property.name}</h3>
            <span className="badge" style={{ background: "var(--inputBg)", color: "var(--subtext)" }}>
              {deviceCount} device{deviceCount === 1 ? "" : "s"}
            </span>
          </div>
          {[property.address, property.city, property.region].filter(Boolean).length > 0 && (
            <div className="meta-row" style={{ marginTop: 3 }}>
              <Icon name="location" size={12} />
              {[property.address, property.city, property.region].filter(Boolean).join(", ")}
            </div>
          )}
        </div>
        <div className="row gap-sm">
          <button className="btn btn-sm" onClick={onEdit}><Icon name="pencil" size={13} /> Edit</button>
          <button className="btn btn-sm btn-danger" onClick={onDelete}><Icon name="trash" size={13} /></button>
        </div>
      </div>

      {(property.contact_name || property.contact_phone) && (
        <div className="row wrap" style={{ background: "var(--inputBg)", borderRadius: 11, padding: 10, gap: 14 }}>
          {property.contact_name && (
            <span className="meta-row"><Icon name="user" size={13} /> {property.contact_name}</span>
          )}
          {property.contact_phone && (
            <span className="meta-row"><Icon name="phone" size={13} /> {property.contact_phone}</span>
          )}
        </div>
      )}

      <div>
        <div className="field-label" style={{ marginBottom: 8 }}>ASSIGNED TECHNICIANS</div>
        <p className="hint" style={{ marginBottom: 10 }}>
          Grants access to this property only — different from Account → Team, which grants
          access to everything you own.
        </p>

        {technicians.length > 0 && (
          <div className="col gap-sm" style={{ marginBottom: 10 }}>
            {technicians.map((t) => (
              <div key={t.id} className="row" style={{ background: "var(--inputBg)", borderRadius: 10, padding: "8px 12px" }}>
                <Icon name="wrench" size={14} style={{ color: "#0284c7" }} />
                <span className="grow" style={{ fontSize: 13.5, fontWeight: 600 }}>{t.technician_email}</span>
                <button className="btn btn-icon btn-sm btn-danger" onClick={() => onRemoveTechnician(t)} aria-label="Remove">
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="row gap-sm">
          <input
            className="input input-sm grow" type="email" placeholder="technician@example.com"
            value={emailInput} onChange={(e) => setEmailInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitAdd(); }}
          />
          <button className="btn btn-sm" onClick={submitAdd} disabled={adding}>
            {adding ? <span className="spinner" /> : <><Icon name="plus" size={13} /> Assign</>}
          </button>
        </div>
      </div>
    </section>
  );
}

// ── Create / edit a property ─────────────────────────────────────────────────
function PropertyModal({ open, property, onClose, onSave, busy }) {
  const [form, setForm] = useState({
    name: "", address: "", city: "", region: "", contact_name: "", contact_phone: "",
  });
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm({
      name: property?.name || "",
      address: property?.address || "",
      city: property?.city || "",
      region: property?.region || "",
      contact_name: property?.contact_name || "",
      contact_phone: property?.contact_phone || "",
    });
  }, [open, property]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const submit = () => {
    if (!form.name.trim()) return setError("Property name is required");
    onSave({
      name: form.name.trim(),
      address: form.address.trim() || null,
      city: form.city.trim() || null,
      region: form.region.trim() || null,
      contact_name: form.contact_name.trim() || null,
      contact_phone: form.contact_phone.trim() || null,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={property ? "Edit Property" : "Add Property"}
      subtitle="A building or site that groups your devices"
      icon="building"
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? <span className="spinner" /> : property ? "Save Changes" : "Create Property"}
          </button>
        </>
      }
    >
      {error && <div className="auth-error">{error}</div>}

      <div className="field">
        <label className="field-label">PROPERTY NAME</label>
        <input className="input" value={form.name} autoFocus placeholder="e.g. Maple Court Apartments"
          onChange={(e) => set({ name: e.target.value })} />
      </div>

      <div className="field">
        <label className="field-label">STREET ADDRESS</label>
        <input className="input" value={form.address} placeholder="e.g. 128 Maple Street"
          onChange={(e) => set({ address: e.target.value })} />
      </div>

      <div className="row gap-sm">
        <div className="field grow">
          <label className="field-label">CITY</label>
          <input className="input" value={form.city} placeholder="e.g. Austin"
            onChange={(e) => set({ city: e.target.value })} />
        </div>
        <div className="field grow">
          <label className="field-label">STATE / REGION</label>
          <input className="input" value={form.region} placeholder="e.g. TX"
            onChange={(e) => set({ region: e.target.value })} />
        </div>
      </div>

      <div className="field">
        <label className="field-label">ON-SITE CONTACT</label>
        <p className="hint" style={{ marginBottom: 6 }}>
          Building manager or main point of contact — for reference, not login access.
        </p>
        <input className="input" value={form.contact_name} placeholder="Contact name"
          onChange={(e) => set({ contact_name: e.target.value })} style={{ marginBottom: 8 }} />
        <input className="input" value={form.contact_phone} placeholder="Phone number"
          onChange={(e) => set({ contact_phone: e.target.value })} />
      </div>
    </Modal>
  );
}
