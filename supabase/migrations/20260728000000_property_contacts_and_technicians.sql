-- ============================================================================
-- Property contact info + per-property technician assignments.
--
-- Landlords previously could only grant a technician account-wide access
-- (technician_assignments, landlord-scoped). This adds a second, narrower
-- grant: a technician assigned to one specific property sees only that
-- property and its devices — the two mechanisms coexist; a technician can
-- have either, both, or neither kind of grant.
-- ============================================================================

-- ── Contact info on the property itself (informational, no RLS impact) ──────
alter table public.properties
  add column if not exists contact_name  text,
  add column if not exists contact_phone text;

-- ── Per-property technician grants ──────────────────────────────────────────
create table if not exists public.property_technician_assignments (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references public.properties (id) on delete cascade,
  technician_email text not null,
  created_at      timestamptz not null default now(),
  unique (property_id, technician_email)
);

comment on table public.property_technician_assignments is
  'Grants a technician read/limited-write access to one specific property, narrower than the landlord-wide technician_assignments table.';

create index if not exists property_technician_assignments_property_id_idx
  on public.property_technician_assignments (property_id);
create index if not exists property_technician_assignments_email_idx
  on public.property_technician_assignments (lower(technician_email));

alter table public.property_technician_assignments enable row level security;

drop policy if exists "owners manage property technician assignments" on public.property_technician_assignments;
create policy "owners manage property technician assignments"
  on public.property_technician_assignments for all
  using (exists (
    select 1 from public.properties p
    where p.id = property_id and p.owner_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.properties p
    where p.id = property_id and p.owner_id = auth.uid()
  ));

drop policy if exists "technicians read own property assignments" on public.property_technician_assignments;
create policy "technicians read own property assignments"
  on public.property_technician_assignments for select
  using (lower(technician_email) = lower(auth.jwt() ->> 'email'));

-- ── Extend properties/devices visibility to property-level technicians ─────
drop policy if exists "property technicians read assigned properties" on public.properties;
create policy "property technicians read assigned properties"
  on public.properties for select
  using (exists (
    select 1 from public.property_technician_assignments pta
    where pta.property_id = properties.id
      and lower(pta.technician_email) = lower(auth.jwt() ->> 'email')
  ));

drop policy if exists "property technicians read assigned devices" on public.devices;
create policy "property technicians read assigned devices"
  on public.devices for select
  using (exists (
    select 1 from public.property_technician_assignments pta
    where pta.property_id = devices.property_id
      and lower(pta.technician_email) = lower(auth.jwt() ->> 'email')
  ));

-- Update, not just select — same name/location-only restriction already
-- enforced by trg_restrict_technician_device_updates (it checks
-- old.owner_id <> auth.uid(), independent of which policy granted access).
drop policy if exists "property technicians update assigned devices" on public.devices;
create policy "property technicians update assigned devices"
  on public.devices for update
  using (exists (
    select 1 from public.property_technician_assignments pta
    where pta.property_id = devices.property_id
      and lower(pta.technician_email) = lower(auth.jwt() ->> 'email')
  ))
  with check (exists (
    select 1 from public.property_technician_assignments pta
    where pta.property_id = devices.property_id
      and lower(pta.technician_email) = lower(auth.jwt() ->> 'email')
  ));
