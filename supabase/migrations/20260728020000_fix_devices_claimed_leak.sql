-- Fixes a pre-existing data leak: the original "Users can view own devices
-- and unclaimed devices" SELECT policy included `OR (claimed = false)`.
-- No claim path (mobile or web) ever sets `claimed = true` on claim — only
-- `owner_id` is set — so every already-claimed device with the column still
-- at its default `false` was visible to every authenticated user, not just
-- its owner. Confirmed live: 5 owned devices matched this pattern.
--
-- This was invisible in the UI only because ScopeContext.jsx additionally
-- filtered client-side by owner_id; removing that redundant filter (to
-- support property-level technician grants) surfaced the underlying leak.
--
-- Fix: drop the `claimed = false` clause. `owner_id IS NULL` already and
-- correctly covers "visible so it can be claimed" — `claimed` isn't
-- referenced anywhere else in the app and needs no backfill.

drop policy if exists "Users can view own devices and unclaimed devices" on public.devices;
create policy "Users can view own devices and unclaimed devices"
  on public.devices for select
  using ((auth.uid() = owner_id) OR (owner_id IS NULL));
