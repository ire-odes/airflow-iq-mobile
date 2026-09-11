import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { ScopeProvider } from "./context/ScopeContext";
import Sidebar from "./components/Sidebar";
import TabBar from "./components/TabBar";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Devices from "./pages/Devices";
import Properties from "./pages/Properties";
import Orders from "./pages/Orders";
import Account from "./pages/Account";
import Ack from "./pages/Ack";

export default function App() {
  const { session, loading } = useAuth();
  const { pathname } = useLocation();

  // The filter-change acknowledgement page is reached from an email, usually
  // with no session. It authorises by its one-time token, so it renders the
  // same whether or not anyone is signed in -- and outside the app shell.
  if (pathname === "/ack") return <Ack />;

  if (loading) {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100vh" }}>
        <div className="spinner" style={{ width: 28, height: 28, color: "var(--accent)" }} />
      </div>
    );
  }

  if (!session) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  return (
    <ScopeProvider>
      <div className="shell">
        {/* Sidebar above 900px, bottom tab bar below it -- CSS decides which
            is visible, so both stay mounted and there is no JS layout branch
            to drift out of sync with the stylesheet. */}
        <Sidebar />
        <main className="main">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/devices" element={<Devices />} />
            <Route path="/properties" element={<Properties />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/account" element={<Account />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </main>
        <TabBar />
      </div>
    </ScopeProvider>
  );
}
