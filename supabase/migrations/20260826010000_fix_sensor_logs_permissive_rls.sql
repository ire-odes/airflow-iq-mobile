-- ============================================================================
-- Fix: sensor_logs had two SELECT policies -- the real one ("Users can read
-- logs for their devices", scoped to device ownership) and a leftover
-- "Enable read access for all users" with USING (true). Postgres RLS ORs
-- multiple permissive policies together for the same command, so the
-- `true` policy silently made the ownership check meaningless: any
-- authenticated user could read every device's sensor data, not just
-- their own. This looks like a default policy left over from early
-- development, from before per-device RLS was built out.
--
-- INSERT was already correctly scoped (with_check requires device
-- ownership) -- this only affected reads. The real device-ingestion path
-- (ingest_ttn) uses the service role key and bypasses RLS entirely, so
-- it's unaffected either way.
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- ============================================================================

drop policy if exists "Enable read access for all users" on public.sensor_logs;
