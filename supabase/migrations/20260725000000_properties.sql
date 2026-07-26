-- ============================================================================
-- AirFlow IQ — Property hierarchy
--
-- Adds a `properties` table so an owner (e.g. a landlord) can group devices
-- by the building/site they are installed in, and links devices to it via
-- devices.property_id.
--
-- Run this once in the Supabase Dashboard → SQL Editor.
-- Safe to re-run: every statement is guarded.
-- ============================================================================

-- ── Table ────────────────────────────────────────────────────────────────────
create table if not exists public.properties (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  address     text,
  city        text,
  region      text,
  created_at  timestamptz not null default now()
);

comment on table public.properties is
  'A building/site owned by a user. Devices are grouped under a property.';

create index if not exists properties_owner_id_idx on public.properties (owner_id);

-- Two properties belonging to the same owner may not share a name.
create unique index if not exists properties_owner_name_key
  on public.properties (owner_id, lower(name));

-- ── Link devices to a property ───────────────────────────────────────────────
alter table public.devices
  add column if not exists property_id uuid
  references public.properties (id) on delete set null;

create index if not exists devices_property_id_idx on public.devices (property_id);

-- Devices with a null property_id are treated by the app as "Unassigned",
-- so existing rows keep working without a backfill.

-- ── Row level security ───────────────────────────────────────────────────────
alter table public.properties enable row level security;

-- Owners have full control over their own properties.
drop policy if exists "owners manage own properties" on public.properties;
create policy "owners manage own properties"
  on public.properties
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- Technicians can read (but not modify) the properties of any landlord who
-- has assigned them, mirroring how they already get read access to devices.
drop policy if exists "technicians read assigned properties" on public.properties;
create policy "technicians read assigned properties"
  on public.properties
  for select
  using (
    exists (
      select 1
      from public.technician_assignments ta
      where ta.landlord_id = properties.owner_id
        and lower(ta.technician_email) = lower(auth.jwt() ->> 'email')
    )
  );
