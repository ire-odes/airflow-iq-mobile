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
  const [allDevices, setAllDevices] = useState([]);

  // Deployed devices only, unless the user asks to see stock.
  //
  // WHY THIS IS THE DEFAULT. On 2026-10-12 this account held 27 device rows
  // and 2 installed units. The other 25 -- spares, bench rigs, unassigned
  // stock -- each still carry whatever they last reported, so the fleet read
  // as 27 devices with verdicts, several of them weeks stale (P1's was from
  // 4 September). Averaging a dashboard across stock, or counting it as
  // "offline", describes a fleet that does not exist.
  //
  // FAILS OPEN. A row whose status is null or undefined counts as deployed,
  // so an environment where 20261012000000_device_status.sql has not been
  // applied behaves exactly as before rather than showing an empty app.
  const [showSpares, setShowSpares] = useState(() => {
    try { return localStorage.getItem("afiq.showSpares") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("afiq.showSpares", showSpares ? "1" : "0"); } catch { /* private window */ }
  }, [showSpares]);

  const devices = useMemo(
    () => (showSpares ? allDevices : allDevices.filter((d) => (d.status ?? "deployed") === "deployed")),
    [allDevices, showSpares]
  );
  const spareCount = useMemo(
    () => allDevices.filter((d) => (d.status ?? "deployed") !== "deployed").length,
    [allDevices]
  );
  const [loading, setLoading] = useState(true);
  const [schemaReady, setSchemaReady] = useState(true);

  // null = "All properties" / "All devices"
  const [selectedPropertyId, setSelectedPropertyId] = useState(null);

  // Remembered across navigation. Without this the effect below re-resolves an
  // empty selection to devicesInScope[0] -- and devices load newest-created
  // first -- so leaving a device and coming back silently landed you on a
  // DIFFERENT one. That reads as "my readings disappeared" when in fact you
  // are looking at another device's (often empty) history.
  const [selectedDeviceId, setSelectedDeviceId] = useState(() => {
    try { return localStorage.getItem("afiq.selectedDeviceId") || null; } catch { return null; }
  });
  useEffect(() => {
    try {
      if (selectedDeviceId) localStorage.setItem("afiq.selectedDeviceId", selectedDeviceId);
      else localStorage.removeItem("afiq.selectedDeviceId");
    } catch { /* private window */ }
  }, [selectedDeviceId]);

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
    setAllDevices(
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

  // Spares sitting in the current property. The device PICKER lists these
  // even while the grid hides them: hiding a device from the one control whose
  // job is "choose a device" is what makes it look deleted. Counts and
  // averages still exclude them -- that is where stock would distort a number.
  const spareDevicesInScope = useMemo(() => {
    const isSpare = (d) => (d.status ?? "deployed") !== "deployed";
    const spares = allDevices.filter(isSpare);
    if (!selectedPropertyId) return spares;
    if (selectedPropertyId === UNASSIGNED) return spares.filter((d) => !d.property_id);
    return spares.filter((d) => d.property_id === selectedPropertyId);
  }, [allDevices, selectedPropertyId]);

  // Device ids the dashboard should actually query.
  const scopedDeviceIds = useMemo(() => {
    if (selectedDeviceId) return [selectedDeviceId];
    return devicesInScope.map((d) => d.id);
  }, [selectedDeviceId, devicesInScope]);

  // Drop a stale device selection when the property filter changes under it.
  //
  // GUARDED ON `loading`. A remembered selection is restored from
  // localStorage before the device list has been fetched, so without this
  // guard devicesInScope is still [] on the first pass and the selection is
  // wiped every single load -- which is exactly the "it forgets which device
  // I was on" behaviour the persistence is meant to fix.
  useEffect(() => {
    if (loading || !selectedDeviceId) return;
    if (devicesInScope.some((d) => d.id === selectedDeviceId)) return;
    // The device exists but is filtered out for being a spare: follow the
    // user's intent and reveal stock, rather than silently moving them to a
    // different device. This is what made the LoRaWAN units vanish when you
    // navigated away and came back.
    if (allDevices.some((d) => d.id === selectedDeviceId)) {
      setShowSpares(true);
      return;
    }
    setSelectedDeviceId(null);
  }, [loading, devicesInScope, allDevices, selectedDeviceId]);

  // Always resolve to one real device when at least one is in scope — never
  // leave it on the "All devices" aggregate. Charting raw readings from
  // several devices interleaved in one series doesn't represent anything
  // real (different devices, different wake schedules), so there's no
  // legitimate case for showing it; the picker only ever narrows further
  // from here.
  useEffect(() => {
    if (loading) return;
    if (!selectedDeviceId && devicesInScope.length >= 1) {
      setSelectedDeviceId(devicesInScope[0].id);
    }
  }, [loading, devicesInScope, selectedDeviceId]);

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
        properties, devices, allDevices, grouped, loading, schemaReady, reload: load,
        showSpares, setShowSpares, spareCount,
        selectedPropertyId, setSelectedPropertyId,
        selectedDeviceId, setSelectedDeviceId,
        selectedProperty, selectedDevice,
        devicesInScope, scopedDeviceIds, spareDevicesInScope,
      }}
    >
      {children}
    </ScopeContext.Provider>
  );
}

export function useScope() {
  return useContext(ScopeContext);
}
