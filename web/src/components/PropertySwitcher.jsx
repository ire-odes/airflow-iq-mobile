import { useRef, useState } from "react";
import Icon from "./Icon";
import useClickOutside from "./useClickOutside";
import { useScope } from "../context/ScopeContext";

// ============================================================================
// Property switcher — sits next to the Dashboard page title. The coarse
// counterpart to ScopePicker (which picks a single device within whatever
// property is selected here). Both read/write the same ScopeContext state,
// so a choice made here is instantly reflected there and vice versa.
//
// Selecting a property here is also what "Claim Device" on the Devices page
// reads to auto-assign a newly claimed device to that property.
// ============================================================================

export default function PropertySwitcher() {
  const { properties, selectedPropertyId, setSelectedPropertyId, setSelectedDeviceId, devices } = useScope();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);

  const pick = (id) => {
    setSelectedPropertyId(id);
    setSelectedDeviceId(null);
    setOpen(false);
  };

  const current = properties.find((p) => p.id === selectedPropertyId);
  const label = current ? current.name : "All Properties";
  const deviceCount = current
    ? devices.filter((d) => d.property_id === current.id).length
    : devices.length;

  return (
    <div className="dropdown" ref={ref}>
      <button className="property-switcher" onClick={() => setOpen((o) => !o)} title="Switch property">
        <Icon name={current ? "building" : "home"} size={14} />
        <span className="truncate" style={{ maxWidth: 200 }}>{label}</span>
        <span style={{ opacity: 0.8, fontWeight: 600 }}>· {deviceCount}</span>
        <Icon name="chevron-down" size={13} />
      </button>

      {open && (
        <div className="dropdown-menu" style={{ minWidth: 216 }}>
          <button
            className={`dropdown-item${!selectedPropertyId ? " selected" : ""}`}
            onClick={() => pick(null)}
          >
            <Icon name="home" size={15} />
            <span className="grow">All Properties</span>
            {!selectedPropertyId && <Icon name="check" size={15} />}
          </button>

          {properties.length === 0 ? (
            <div className="hint" style={{ padding: "12px 11px" }}>No properties yet.</div>
          ) : (
            <>
              <div className="dropdown-sep" />
              {properties.map((p) => (
                <button
                  key={p.id}
                  className={`dropdown-item${selectedPropertyId === p.id ? " selected" : ""}`}
                  onClick={() => pick(p.id)}
                >
                  <Icon name="building" size={15} />
                  <span className="grow truncate">{p.name}</span>
                  {selectedPropertyId === p.id && <Icon name="check" size={15} />}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
