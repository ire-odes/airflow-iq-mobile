import { useRef, useState } from "react";
import Icon from "./Icon";
import useClickOutside from "./useClickOutside";
import { useScope, UNASSIGNED_ID } from "../context/ScopeContext";

// ============================================================================
// Hierarchical Property → Device selector.
//
// Selecting a property scopes the dashboard to every device in that property;
// selecting a device inside it narrows further. "All properties" aggregates
// across the entire portfolio.
// ============================================================================

export default function ScopePicker() {
  const {
    grouped, devices,
    selectedPropertyId, setSelectedPropertyId,
    selectedDeviceId, setSelectedDeviceId,
    selectedProperty, selectedDevice,
  } = useScope();

  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);

  const pickProperty = (id) => {
    setSelectedPropertyId(id);
    setSelectedDeviceId(null);
    setOpen(false);
  };

  const pickDevice = (device) => {
    setSelectedPropertyId(device.property_id || UNASSIGNED_ID);
    setSelectedDeviceId(device.id);
    setOpen(false);
  };

  // Label reads "Property · Device" so the current scope is unambiguous.
  const label = selectedDevice
    ? `${selectedProperty?.name || "Unassigned"} · ${selectedDevice.name || "Device"}`
    : selectedProperty
      ? selectedProperty.name
      : "All properties";

  const sublabel = selectedDevice
    ? selectedDevice.hvac_location || selectedDevice.device_mac || "Single device"
    : selectedProperty
      ? `${grouped.find((g) => g.property.id === selectedPropertyId)?.devices.length ?? 0} devices`
      : `${devices.length} devices across ${grouped.length} ${grouped.length === 1 ? "group" : "groups"}`;

  return (
    <div className="dropdown" ref={ref}>
      <button
        className="btn"
        onClick={() => setOpen((o) => !o)}
        style={{ padding: "8px 13px", gap: 10, maxWidth: 340 }}
      >
        <div className="property-icon" style={{ width: 28, height: 28, borderRadius: 9 }}>
          <Icon name={selectedDevice ? "device" : "building"} size={15} />
        </div>
        <div className="grow" style={{ textAlign: "left", minWidth: 0 }}>
          <div className="truncate" style={{ fontSize: 13.5, fontWeight: 700 }}>{label}</div>
          <div className="truncate" style={{ fontSize: 11, color: "var(--subtext)", fontWeight: 600 }}>
            {sublabel}
          </div>
        </div>
        <Icon name="chevron-down" size={15} style={{ color: "var(--subtext)" }} />
      </button>

      {open && (
        <div className="dropdown-menu">
          <button
            className={`dropdown-item${!selectedPropertyId && !selectedDeviceId ? " selected" : ""}`}
            onClick={() => pickProperty(null)}
          >
            <Icon name="home" size={15} />
            <span className="grow">All properties</span>
            {!selectedPropertyId && !selectedDeviceId && <Icon name="check" size={15} />}
          </button>

          {grouped.length === 0 && (
            <div className="hint" style={{ padding: "14px 12px" }}>
              No devices yet. Claim one from the Devices page.
            </div>
          )}

          {grouped.map(({ property, devices: propDevices }) => (
            <div key={property.id}>
              <div className="dropdown-sep" />
              <div className="dropdown-group-label">
                <Icon name={property._virtual ? "device" : "building"} size={12} />
                <span className="grow truncate">{property.name}</span>
                {[property.city, property.region].filter(Boolean).length > 0 && (
                  <span style={{ fontWeight: 600, textTransform: "none", letterSpacing: 0 }}>
                    {[property.city, property.region].filter(Boolean).join(", ")}
                  </span>
                )}
              </div>

              <button
                className={`dropdown-item${selectedPropertyId === property.id && !selectedDeviceId ? " selected" : ""}`}
                onClick={() => pickProperty(property.id)}
              >
                <Icon name="chart" size={15} />
                <span className="grow">All devices here ({propDevices.length})</span>
                {selectedPropertyId === property.id && !selectedDeviceId && <Icon name="check" size={15} />}
              </button>

              {propDevices.map((d) => (
                <button
                  key={d.id}
                  className={`dropdown-item indent${selectedDeviceId === d.id ? " selected" : ""}`}
                  onClick={() => pickDevice(d)}
                >
                  <Icon name="device" size={14} />
                  <span className="grow truncate">{d.name || "Unnamed device"}</span>
                  {selectedDeviceId === d.id && <Icon name="check" size={15} />}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
