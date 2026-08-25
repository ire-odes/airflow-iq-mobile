-- ============================================================================
-- Reconcile technician email matching to be case-insensitive everywhere
--
-- Technician access is granted by matching the caller's JWT email against
-- an email stored in technician_assignments / property_technician_assignments.
-- Three policies compared those raw:
--
--   devices                / "technician views landlord devices"   (SELECT)
--   devices                / "technician updates landlord devices" (UPDATE)
--   technician_assignments / "technician reads own"                (SELECT)
--
-- while audio_logs' "users read audio for accessible devices" and
-- sensor_logs' "technicians read logs for accessible devices" (added in
-- 20260828000000) both lower() each side. Email local-parts are technically
-- case-sensitive per RFC 5321, but no real provider treats them that way,
-- and an address typed as "Tech@Example.com" into an assignment form is the
-- same person as "tech@example.com".
--
-- The split caused a genuinely confusing failure mode: a technician whose
-- stored assignment differed in case from their login would pass the
-- lower()ed checks and fail the raw ones -- so they'd see the device in the
-- list but none of its sensor data, or could read a device they couldn't
-- edit. Partial access is harder to diagnose than no access.
--
-- No rows currently differ in case (checked at time of writing: 0 in
-- technician_assignments, 0 in property_technician_assignments, 0 in
-- auth.users), so this changes no one's access today -- it's preventive,
-- and makes the rule uniform so the next reader doesn't have to work out
-- which form applies where.
--
-- auth.email() is just auth.jwt() ->> 'email'; the two forms already in use
-- are equivalent, so each policy keeps whichever it had and only gains the
-- lower() wrapping. Predicates are otherwise unchanged -- same tables, same
-- join keys, same commands, same roles (the UPDATE policy keeps both its
-- USING and WITH CHECK expressions, and stays scoped to `authenticated`).
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- Safe to re-run.
-- ============================================================================

-- devices: technician can see their landlord's devices
drop policy if exists "technician views landlord devices" on public.devices;
create policy "technician views landlord devices"
  on public.devices
  for select
  using (
    owner_id in (
      select ta.landlord_id
      from public.technician_assignments ta
      where lower(ta.technician_email) = lower(auth.email())
    )
  );

-- devices: technician can edit name/location on their landlord's devices
drop policy if exists "technician updates landlord devices" on public.devices;
create policy "technician updates landlord devices"
  on public.devices
  for update
  to authenticated
  using (
    owner_id in (
      select ta.landlord_id
      from public.technician_assignments ta
      where lower(ta.technician_email) = lower(auth.email())
    )
  )
  with check (
    owner_id in (
      select ta.landlord_id
      from public.technician_assignments ta
      where lower(ta.technician_email) = lower(auth.email())
    )
  );

-- technician_assignments: a technician can read their own assignment rows
drop policy if exists "technician reads own" on public.technician_assignments;
create policy "technician reads own"
  on public.technician_assignments
  for select
  using (lower(technician_email) = lower(auth.email()));
