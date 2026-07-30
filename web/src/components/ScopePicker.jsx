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
  const { devicesInScope, selectedDeviceId, setSelectedDeviceId, selectedDevice, selectedProperty } = useScope();

  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false), open);

  const pickDevice = (id) => {
    setSelectedDeviceId(id);
    setOpen(false);
  };

  const label = selectedDevice ? (selectedDevice.name || "Device") : "All devices";
  const sublabel = selectedDevice
    ? (selectedDevice.hvac_location || selectedDevice.device_mac || "Single device")
    : `${devicesInScope.length} device${devicesInScope.length === 1 ? "" : "s"}${selectedProperty ? ` in ${selectedProperty.name}` : ""}`;

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
          <div className="truncate" style={{ fontSize: 13.5, fontWeight: 700, color: "#0b2f66" }}>{label}</div>
          <div className="truncate" style={{ fontSize: 11, color: "#6b7a99", fontWeight: 600 }}>
            {sublabel}
          </div>
        </div>
        <Icon name="chevron-down" size={15} style={{ color: "#6b7a99" }} />
      </button>

      {open && (
        <div className="dropdown-menu">
          <button
            className={`dropdown-item${!selectedDeviceId ? " selected" : ""}`}
            onClick={() => pickDevice(null)}
          >
            <Icon name="chart" size={15} />
            <span className="grow">All devices</span>
            {!selectedDeviceId && <Icon name="check" size={15} />}
          </button>

          {devicesInScope.length === 0 ? (
            <div className="hint" style={{ padding: "14px 12px" }}>
              No devices in this property yet.
            </div>
          ) : (
            <>
              <div className="dropdown-sep" />
              {devicesInScope.map((d) => (
                <button
                  key={d.id}
                  className={`dropdown-item${selectedDeviceId === d.id ? " selected" : ""}`}
                  onClick={() => pickDevice(d.id)}
                >
                  <Icon name="device" size={15} />
                  <span className="grow truncate">{d.name || "Unnamed device"}</span>
                  {selectedDeviceId === d.id && <Icon name="check" size={15} />}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
