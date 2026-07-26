import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";

// ============================================================================
// Owns the Property → Device hierarchy for the whole app.
//
//   Property "Maple Court"        <- properties table
//     ├── Device "Unit 1A"        <- devices.property_id
//     └── Device "Unit 1B"
//   Unassigned                    <- devices with property_id = null
//
// Loading it once here keeps the Dashboard and Devices pages in sync and
// avoids each page refetching the same rows.
// ============================================================================

const UNASSIGNED = "__unassigned__";
export const UNASSIGNED_ID = UNASSIGNED;

const ScopeContext = createContext(null);

export function ScopeProvider({ children }) {
  const { session, technicianAssignments } = useAuth();
  const userId = session?.user?.id;

  const [properties, setProperties] = useState([]);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [schemaReady, setSchemaReady] = useState(true);

  // null = "All properties" / "All devices"
  const [selectedPropertyId, setSelectedPropertyId] = useState(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);

  const landlordIds = useMemo(
    () => technicianAssignments.map((a) => a.landlord_id),
    [technicianAssignments]
  );

  const load = useCallback(async () => {
    if (!userId) { setLoading(false); return; }

    const ownerIds = [userId, ...landlordIds];

    const [propRes, devRes] = await Promise.all([
      supabase.from("properties").select("*").in("owner_id", ownerIds).order("name"),
      supabase.from("devices").select("*").in("owner_id", ownerIds).order("created_at", { ascending: false }),
    ]);

    // The properties table only exists after the migration has been run.
    // Degrade to a single "Unassigned" bucket rather than breaking the app.
    if (propRes.error) {
      setSchemaReady(false);
      setProperties([]);
    } else {
      setSchemaReady(true);
      setProperties((propRes.data || []).map((p) => ({ ...p, _isOwner: p.owner_id === userId })));
    }

    setDevices((devRes.data || []).map((d) => ({ ...d, _isOwner: d.owner_id === userId })));
    setLoading(false);
  }, [userId, landlordIds]);

  useEffect(() => { load(); }, [load]);

  // Devices visible under the current property selection.
  const devicesInScope = useMemo(() => {
    if (!selectedPropertyId) return devices;
    if (selectedPropertyId === UNASSIGNED) return devices.filter((d) => !d.property_id);
    return devices.filter((d) => d.property_id === selectedPropertyId);
  }, [devices, selectedPropertyId]);

  // Device ids the dashboard should actually query.
  const scopedDeviceIds = useMemo(() => {
    if (selectedDeviceId) return [selectedDeviceId];
    return devicesInScope.map((d) => d.id);
  }, [selectedDeviceId, devicesInScope]);

  // Drop a stale device selection when the property filter changes under it.
  useEffect(() => {
    if (selectedDeviceId && !devicesInScope.some((d) => d.id === selectedDeviceId)) {
      setSelectedDeviceId(null);
    }
  }, [devicesInScope, selectedDeviceId]);

  // Devices grouped by property, for list rendering. Always includes the
  // "Unassigned" group when there are devices without a property.
  const grouped = useMemo(() => {
    const groups = properties.map((p) => ({
      property: p,
      devices: devices.filter((d) => d.property_id === p.id),
    }));
    const orphans = devices.filter((d) => !d.property_id);
    if (orphans.length > 0) {
      groups.push({
        property: { id: UNASSIGNED, name: "Unassigned", _isOwner: true, _virtual: true },
        devices: orphans,
      });
    }
    return groups;
  }, [properties, devices]);

  const selectedDevice = devices.find((d) => d.id === selectedDeviceId) || null;
  const selectedProperty =
    selectedPropertyId === UNASSIGNED
      ? { id: UNASSIGNED, name: "Unassigned", _virtual: true }
      : properties.find((p) => p.id === selectedPropertyId) || null;

  return (
    <ScopeContext.Provider
      value={{
        properties, devices, grouped, loading, schemaReady, reload: load,
        selectedPropertyId, setSelectedPropertyId,
        selectedDeviceId, setSelectedDeviceId,
        selectedProperty, selectedDevice,
        devicesInScope, scopedDeviceIds,
      }}
    >
      {children}
    </ScopeContext.Provider>
  );
}

export function useScope() {
  return useContext(ScopeContext);
}
