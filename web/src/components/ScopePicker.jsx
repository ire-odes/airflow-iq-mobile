import { useRef, useState } from "react";
import Icon from "./Icon";
import useClickOutside from "./useClickOutside";
import { useScope } from "../context/ScopeContext";

// ============================================================================
// Device picker — flat list of whatever's in the currently selected property
// (PropertySwitcher, next to the page title, owns that selection). This no
// longer groups by property; it only narrows further, from property down to
// one device.
// ============================================================================

export default function ScopePicker() {
  const { devicesInScope, selectedDeviceId, setSelectedDeviceId, selectedDevice,
          selectedProperty } = useScope();

  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);

  const pickDevice = (id) => {
    setSelectedDeviceId(id);
    setOpen(false);
  };

  // selectedDevice should always be set once at least one device is in
  // scope (ScopeContext auto-selects the first) — this fallback only shows
  // for the brief instant before that resolves, or a genuinely empty scope.
  // A paired node is useless to identify without its duct role: "P9" and "P4"
  // say nothing about which side of the filter you are looking at, and the
  // whole point of a pair is the difference between the two sides.
  const roleOf = (d) => (d.duct_role ? ` · ${d.duct_role}` : "");

  const row = (d) => (
    <button
      key={d.id}
      className={`dropdown-item${selectedDeviceId === d.id ? " selected" : ""}`}
      onClick={() => pickDevice(d.id)}
    >
      <Icon name="device" size={15} />
      <span className="grow truncate">
        {d.name || "Unnamed device"}
        <span className="hint" style={{ fontSize: 11, fontWeight: 600 }}>{roleOf(d)}</span>
      </span>
      {selectedDeviceId === d.id && <Icon name="check" size={15} />}
    </button>
  );

  const label = selectedDevice ? (selectedDevice.name || "Device") : "No device";
  const sublabel = selectedDevice
    ? [selectedDevice.duct_role ? `${selectedDevice.duct_role} side` : null,
       selectedDevice.hvac_location || selectedDevice.device_mac].filter(Boolean).join(" · ")
    : selectedProperty ? `No devices in ${selectedProperty.name}` : "No devices";

  return (
    <div className="dropdown" ref={ref}>
      <button
        className="gradient-pill-trigger"
        onClick={() => setOpen((o) => !o)}
        style={{ padding: "8px 13px", gap: 10, maxWidth: 300 }}
      >
        <div className="property-icon" style={{ width: 28, height: 28, borderRadius: 9, background: "#007BFF1f", color: "#007BFF" }}>
          <Icon name={selectedDevice ? "device" : "chart"} size={15} />
        </div>
        <div className="grow" style={{ textAlign: "left", minWidth: 0 }}>
          <div className="truncate pill-trigger-label" style={{ fontSize: 13.5, fontWeight: 700 }}>{label}</div>
          <div className="truncate pill-trigger-sub" style={{ fontSize: 11, fontWeight: 600 }}>
            {sublabel}
          </div>
        </div>
        <Icon name="chevron-down" size={15} className="pill-trigger-sub" />
      </button>

      {open && (
        <div className="dropdown-menu">
          {devicesInScope.length === 0 ? (
            <div className="hint" style={{ padding: "14px 12px" }}>
              No devices in this property yet.
            </div>
          ) : (
            devicesInScope.map((d) => row(d))
          )}
        </div>
      )}
    </div>
  );
}
