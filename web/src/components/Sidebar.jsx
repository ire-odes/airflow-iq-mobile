import { NavLink } from "react-router-dom";
import Icon from "./Icon";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { useScope } from "../context/ScopeContext";

const NAV = [
  { to: "/dashboard", icon: "dashboard", label: "Dashboard" },
  { to: "/devices",   icon: "device",    label: "Devices" },
  { to: "/orders",    icon: "cart",      label: "Orders" },
  { to: "/account",   icon: "settings",  label: "Account" },
];

export default function Sidebar() {
  const { session, signOut } = useAuth();
  const { isDark, toggleTheme } = useTheme();
  const { properties, devices } = useScope();

  const email = session?.user?.email || "";
  const initial = (email[0] || "?").toUpperCase();

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-logo"><Icon name="wind" size={19} /></div>
        <div className="grow">
          <div className="sidebar-brand-name">AirFlow IQ</div>
          <div className="sidebar-brand-sub">Desktop</div>
        </div>
      </div>

      <div className="sidebar-label">Menu</div>
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
        >
          <Icon name={n.icon} size={17} />
          <span className="grow">{n.label}</span>
          {n.to === "/devices" && devices.length > 0 && (
            <span style={{ fontSize: 11, fontWeight: 800, opacity: 0.75 }}>{devices.length}</span>
          )}
        </NavLink>
      ))}

      {properties.length > 0 && (
        <>
          <div className="sidebar-label">Portfolio</div>
          <div style={{ padding: "2px 12px 0", display: "flex", flexDirection: "column", gap: 9 }}>
            <div className="row" style={{ fontSize: 12.5, color: "var(--subtext)", fontWeight: 600 }}>
              <Icon name="building" size={14} />
              <span>{properties.length} {properties.length === 1 ? "property" : "properties"}</span>
            </div>
            <div className="row" style={{ fontSize: 12.5, color: "var(--subtext)", fontWeight: 600 }}>
              <Icon name="device" size={14} />
              <span>{devices.length} {devices.length === 1 ? "device" : "devices"}</span>
            </div>
          </div>
        </>
      )}

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <div className="avatar">{initial}</div>
          <div className="grow">
            <div className="sidebar-user-name truncate">Signed in</div>
            <div className="sidebar-user-mail truncate" title={email}>{email}</div>
          </div>
        </div>

        <button className="nav-item" onClick={toggleTheme}>
          <Icon name={isDark ? "sun" : "moon"} size={17} />
          <span className="grow">{isDark ? "Light mode" : "Dark mode"}</span>
        </button>

        <button className="nav-item" onClick={signOut} style={{ color: "#ef4444" }}>
          <Icon name="logout" size={17} />
          <span className="grow">Sign out</span>
        </button>
      </div>
    </aside>
  );
}
