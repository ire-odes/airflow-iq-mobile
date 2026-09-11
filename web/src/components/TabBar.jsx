import { NavLink, useLocation } from "react-router-dom";
import Icon from "./Icon";

// ============================================================================
// Bottom tab bar for phones and tablets -- the web counterpart of the Expo
// app's tab navigator (app/(tabs)/_layout.js): same four tabs, same order,
// same active colour. Shown below 900px only; the sidebar owns navigation
// above that (see the "Mobile / tablet" block in styles.css).
//
// Properties has no tab, matching the Expo app. It is reached from Devices
// ("Manage Properties") and the property switcher, so the Devices tab stays
// lit while you are on it -- otherwise the bar would show no active tab and
// read as though you had left the app's navigation entirely.
// ============================================================================

const TABS = [
  { to: "/dashboard", icon: "chart", label: "Dashboard", match: ["/dashboard"] },
  { to: "/devices",   icon: "chip",  label: "Devices",   match: ["/devices", "/properties"] },
  { to: "/orders",    icon: "cart",  label: "Orders",    match: ["/orders"] },
  { to: "/account",   icon: "user",  label: "Account",   match: ["/account"] },
];

export default function TabBar() {
  const { pathname } = useLocation();

  return (
    <nav className="tabbar" aria-label="Primary">
      {TABS.map((t) => {
        const active = t.match.some((p) => pathname.startsWith(p));
        return (
          <NavLink
            key={t.to}
            to={t.to}
            className={`tabbar-item${active ? " active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <Icon name={t.icon} size={22} />
            <span>{t.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
