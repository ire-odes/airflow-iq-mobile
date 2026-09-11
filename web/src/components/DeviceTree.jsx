import { useEffect, useMemo, useState } from "react";
import Icon from "./Icon";
import { groupPairs } from "../lib/devicePairs";

// ============================================================================
// Device tree — the Property -> Device hierarchy as a top-down org chart:
// root at the top, each level fanning out below its parent on a shared bus
// with rounded elbows.
//
// Deliberately shows ONLY a device's name and MAC. The card grid below
// already carries state — status, battery, filter life, intervals — and
// repeating it here made every node a dense little table, which buried the
// one thing a tree is for: the shape of the hierarchy. Structure is the
// content; everything else is a click away on the card.
//
// Node bodies are built from <span>s, not <div>s: the property and device
// nodes are <button>s, and a button legally takes only phrasing content.
// The block layout comes from CSS.
// ============================================================================

const COLLAPSE_KEY = "devices_tree_collapsed";
const ZOOM_KEY = "devices_tree_zoom";

const ZOOM_STEPS = [0.5, 0.6, 0.7, 0.85, 1];

export default function DeviceTree({ grouped, onEdit }) {
  // Collapsed rather than expanded ids: a newly claimed device or property
  // should appear without the user having to go and expand it.
  const [collapsed, setCollapsed] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "[]")); }
    catch { return new Set(); }
  });
  const [zoom, setZoom] = useState(() => {
    const saved = Number(localStorage.getItem(ZOOM_KEY));
    return ZOOM_STEPS.includes(saved) ? saved : 1;
  });

  useEffect(() => {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
  }, [collapsed]);
  useEffect(() => { localStorage.setItem(ZOOM_KEY, String(zoom)); }, [zoom]);

  const toggle = (id) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const stepZoom = (dir) => setZoom((z) => {
    const i = ZOOM_STEPS.indexOf(z);
    return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + dir))];
  });

  const totals = useMemo(() => {
    const n = grouped.reduce((sum, g) => sum + g.devices.length, 0);
    return { properties: grouped.length, devices: n };
  }, [grouped]);

  const collapseAll = () => setCollapsed(new Set(grouped.map((g) => g.property.id)));
  const expandAll = () => setCollapsed(new Set());

  if (grouped.length === 0) {
    return (
      <div className="tree-panel">
        <p className="hint" style={{ padding: "6px 2px" }}>
          Nothing to map yet — claim a device to see the hierarchy.
        </p>
      </div>
    );
  }

  return (
    <div className="tree-panel">
      <div className="tree-toolbar">
        <div className="row gap-sm">
          <Icon name="tree" size={15} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 13.5, fontWeight: 800 }}>Device tree</span>
          <span className="badge" style={{ background: "var(--inputBg)", color: "var(--subtext)" }}>
            {totals.properties} {totals.properties === 1 ? "property" : "properties"}
            {" · "}
            {totals.devices} {totals.devices === 1 ? "device" : "devices"}
          </span>
        </div>
        <div className="row gap-sm">
          {/* Zoom, not reflow: the chart's width is a property of the
              hierarchy itself, so the only honest way to fit a wide one on
              screen is to draw the whole thing smaller. */}
          <div className="tree-zoom">
            <button
              className="btn btn-sm btn-icon"
              onClick={() => stepZoom(-1)}
              disabled={zoom === ZOOM_STEPS[0]}
              title="Zoom out"
            >
              <Icon name="minus" size={13} />
            </button>
            <span className="tree-zoom-value">{Math.round(zoom * 100)}%</span>
            <button
              className="btn btn-sm btn-icon"
              onClick={() => stepZoom(1)}
              disabled={zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
              title="Zoom in"
            >
              <Icon name="plus" size={13} />
            </button>
          </div>
          <button className="btn btn-sm" onClick={expandAll}>Expand all</button>
          <button className="btn btn-sm" onClick={collapseAll}>Collapse all</button>
        </div>
      </div>

      {/* Scroll the chart, never the page: a wide hierarchy must not drag a
          horizontal scrollbar onto the whole layout. */}
      <div className="tree-scroll">
        <ul className="org" style={{ zoom }}>
          <li>
            <div className="org-node org-root">
              <span className="org-node-body">
                <span className="org-title">Portfolio</span>
              </span>
            </div>

            <ul>
              {grouped.map(({ property, devices: propDevices }) => (
                <PropertyBranch
                  key={property.id}
                  property={property}
                  propDevices={propDevices}
                  collapsed={collapsed.has(property.id)}
                  onToggle={() => toggle(property.id)}
                  onEdit={onEdit}
                />
              ))}
            </ul>
          </li>
        </ul>
      </div>
    </div>
  );
}

function PropertyBranch({ property, propDevices, collapsed, onToggle, onEdit }) {
  const entries = groupPairs(propDevices);

  return (
    <li>
      <button
        className="org-node org-property"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={collapsed ? "Expand" : "Collapse"}
      >
        <span className="org-node-body">
          <span className="org-node-head">
            <span className="org-title truncate">{property.name}</span>
            <Icon
              name={collapsed ? "chevron-down" : "chevron-up"}
              size={13}
              style={{ color: "var(--subtext)", flexShrink: 0, marginLeft: "auto" }}
            />
          </span>
        </span>
      </button>

      {!collapsed && propDevices.length > 0 && (
        <ul>
          {entries.map((entry) => {
            const node = (d) => <DeviceNode device={d} onEdit={() => onEdit(d)} />;

            if (entry.kind === "single") {
              return <li key={entry.device.id}>{node(entry.device)}</li>;
            }

            // A pair gets its own level. Nesting it rather than listing the
            // two nodes as siblings is what makes the link structural instead
            // of decorative -- the chart itself now says "these two are one
            // installation".
            return (
              <li key={`pair-${entry.blower.id}`}>
                <div className="org-node org-pair">
                  <div className="org-node-body">
                    <div className="org-node-head">
                      <Icon name="link" size={12} style={{ flexShrink: 0 }} />
                      <span className="org-title">Duct pair</span>
                    </div>
                  </div>
                </div>
                <ul className="org-pair-children">
                  <li>{node(entry.blower)}</li>
                  <li>{node(entry.filter)}</li>
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function DeviceNode({ device, onEdit }) {
  return (
    <button className="org-node org-device" onClick={onEdit} title="Edit this device">
      <span className="org-node-body">
        <span className="org-title truncate">{device.name || "Unnamed Device"}</span>
        <span className="org-sub mono truncate">{device.device_mac || "no MAC"}</span>
      </span>
    </button>
  );
}
