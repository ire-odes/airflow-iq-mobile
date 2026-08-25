-- ============================================================================
-- Fix: technicians can't see online status, battery, or filter life
--
-- web/src/pages/Devices.jsx's loadStats() reads all three of those from
-- sensor_logs (last recorded_at -> online status, battery -> the battery
-- icon, and the rfid history -> the filter-life bar). A technician can see
-- the device row itself -- public.devices has both "technician views
-- landlord devices" and "property technicians read assigned devices" --
-- but sensor_logs only ever had an owner-scoped SELECT policy, so those
-- queries came back empty and all three indicators rendered blank.
--
-- This was latent until 20260826010000_fix_sensor_logs_permissive_rls.sql
-- dropped a leftover "Enable read access for all users" USING (true)
-- policy. Postgres ORs permissive policies together, so that blanket
-- policy had been masking the missing technician path (while also letting
-- any authenticated user read every device's sensor data -- which is why
-- dropping it was right). The fix is to grant technicians the access they
-- should have had all along, not to restore a blanket read.
--
-- The predicate mirrors audio_logs' "users read audio for accessible
-- devices" policy exactly -- owner, landlord-wide technician, or
-- property-level technician -- so "a device I can see" means the same
-- thing across both tables. Only the join key differs: audio_logs is
-- MAC-keyed (d.device_mac = audio_logs.device_id) while sensor_logs is
-- UUID-keyed (d.id = sensor_logs.device_id).
--
-- Email comparisons are lower()ed on both sides, matching audio_logs.
-- (public.devices' own "technician views landlord devices" policy compares
-- raw auth.email() instead -- worth reconciling separately, but this
-- follows the more defensive form rather than copying that.)
--
-- SELECT only: technicians have no reason to write sensor readings, and
-- the ingestion path uses the service role key and bypasses RLS anyway.
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- Safe to re-run.
-- ============================================================================

drop policy if exists "technicians read logs for accessible devices" on public.sensor_logs;

create policy "technicians read logs for accessible devices"
  on public.sensor_logs
  for select
  using (
    exists (
      select 1
      from public.devices d
      where d.id = sensor_logs.device_id
        and (
          d.owner_id in (
            select ta.landlord_id
            from public.technician_assignments ta
            where lower(ta.technician_email) = lower(auth.jwt() ->> 'email')
          )
          or exists (
            select 1
            from public.property_technician_assignments pta
            where pta.property_id = d.property_id
              and lower(pta.technician_email) = lower(auth.jwt() ->> 'email')
          )
        )
    )
  );
