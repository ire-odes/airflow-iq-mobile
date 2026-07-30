-- ============================================================================
-- Real acoustic data: audio_logs table and the hvac-recordings storage bucket
-- already exist and are being written to by an existing device ingestion
-- pipeline (outside this repo) — but RLS has zero policies, so nothing could
-- read them through the API. This adds read access only: a user may see the
-- audio log / recording for a device if they own it or have technician
-- access to it (landlord-wide or property-level), matching devices' own
-- access rules exactly. Writes are untouched — the ingestion pipeline uses
-- its own service-role credentials, not the app's.
--
-- audio_logs.device_id is the device's MAC address (text), not devices.id —
-- joins go through devices.device_mac.
-- ============================================================================

drop policy if exists "users read audio for accessible devices" on public.audio_logs;
create policy "users read audio for accessible devices"
  on public.audio_logs for select
  using (
    exists (
      select 1 from public.devices d
      where d.device_mac = audio_logs.device_id
        and (
          d.owner_id = auth.uid()
          or d.owner_id in (
            select landlord_id from public.technician_assignments
            where lower(technician_email) = lower(auth.jwt() ->> 'email')
          )
          or exists (
            select 1 from public.property_technician_assignments pta
            where pta.property_id = d.property_id
              and lower(pta.technician_email) = lower(auth.jwt() ->> 'email')
          )
        )
    )
  );

-- Storage RLS: needed for createSignedUrl to work at all — it checks this
-- same policy before minting a URL for an object.
drop policy if exists "users read own device audio files" on storage.objects;
create policy "users read own device audio files"
  on storage.objects for select
  using (
    bucket_id = 'hvac-recordings'
    and exists (
      select 1 from public.devices d
      where d.device_mac = split_part(storage.objects.name, '/', 1)
        and (
          d.owner_id = auth.uid()
          or d.owner_id in (
            select landlord_id from public.technician_assignments
            where lower(technician_email) = lower(auth.jwt() ->> 'email')
          )
          or exists (
            select 1 from public.property_technician_assignments pta
            where pta.property_id = d.property_id
              and lower(pta.technician_email) = lower(auth.jwt() ->> 'email')
          )
        )
    )
  );
