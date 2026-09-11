import { Navigate, Route, Routes } from "react-router-dom";
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

export default function App() {
  const { session, loading } = useAuth();

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
