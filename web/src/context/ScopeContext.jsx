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
  const { session } = useAuth();
  const userId = session?.user?.id;

  const [properties, setProperties] = useState([]);
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [schemaReady, setSchemaReady] = useState(true);

  // null = "All properties" / "All devices"
  const [selectedPropertyId, setSelectedPropertyId] = useState(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);

  // No owner_id filtering here — RLS alone decides what comes back, which is
  // what lets a property-level technician grant (property_technician_assignments)
  // surface a landlord's property without needing a landlord-wide grant too.
  const load = useCallback(async () => {
    if (!userId) { setLoading(false); return; }

    const [propRes, devRes] = await Promise.all([
      supabase.from("properties").select("*").order("name"),
      supabase.from("devices").select("*").order("created_at", { ascending: false }),
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

    // Unclaimed devices (owner_id null) are legitimately visible via RLS so
    // the "claim by MAC" flow can find them, but they don't belong in anyone's
    // portfolio — without this filter every unclaimed device in the system
    // shows up here tagged as if it were a technician assignment.
    setDevices(
      (devRes.data || [])
        .filter((d) => d.owner_id != null)
        .map((d) => ({ ...d, _isOwner: d.owner_id === userId }))
    );
    setLoading(false);
  }, [userId]);

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

  // When exactly one device is in scope, select it automatically — avoids an
  // ambiguous "All devices" label (and an aggregate-of-one chart) when
  // there's really only one thing to show.
  useEffect(() => {
    if (!selectedDeviceId && devicesInScope.length === 1) {
      setSelectedDeviceId(devicesInScope[0].id);
    }
  }, [devicesInScope, selectedDeviceId]);

  // Devices grouped by property, for list rendering. Always includes an
  // "Unassigned" group when there are devices without a property — split by
  // ownership, since a technician-accessible orphan device isn't "yours"
  // just because it has no property.
  const grouped = useMemo(() => {
    const groups = properties.map((p) => ({
      property: p,
      devices: devices.filter((d) => d.property_id === p.id),
    }));

    const orphans = devices.filter((d) => !d.property_id);
    const ownedOrphans = orphans.filter((d) => d._isOwner);
    const servicedOrphans = orphans.filter((d) => !d._isOwner);

    if (ownedOrphans.length > 0) {
      groups.push({
        property: { id: UNASSIGNED, name: "Unassigned Property", _isOwner: true, _virtual: true },
        devices: ownedOrphans,
      });
    }
    if (servicedOrphans.length > 0) {
      groups.push({
        property: { id: `${UNASSIGNED}_serviced`, name: "Unassigned Property", _isOwner: false, _virtual: true },
        devices: servicedOrphans,
      });
    }
    return groups;
  }, [properties, devices]);

  const selectedDevice = devices.find((d) => d.id === selectedDeviceId) || null;
  const selectedProperty =
    selectedPropertyId === UNASSIGNED
      ? { id: UNASSIGNED, name: "Unassigned Property", _virtual: true }
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
