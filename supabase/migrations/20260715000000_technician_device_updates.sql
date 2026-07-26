-- Applied 2026-07-15 (via MCP). Technicians may update devices belonging to
-- landlords they're assigned to. A BEFORE UPDATE trigger restricts non-owners
-- to name/hvac_location only (same pattern as lock_order_totals): all other
-- fields are forced back to their old values.

create policy "technician updates landlord devices"
  on public.devices for update
  to authenticated
  using (owner_id in (
    select landlord_id from public.technician_assignments
    where technician_email = auth.email()))
  with check (owner_id in (
    select landlord_id from public.technician_assignments
    where technician_email = auth.email()));

create or replace function public.restrict_technician_device_updates()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_name text := new.name;
  v_location text := new.hvac_location;
begin
  -- Owners, claims of unclaimed devices, and service-role calls pass through.
  -- Only a signed-in non-owner (i.e. a technician) is restricted.
  if auth.uid() is not null
     and old.owner_id is not null
     and old.owner_id <> auth.uid() then
    new := old;
    new.name := v_name;
    new.hvac_location := v_location;
  end if;
  return new;
end $$;

drop trigger if exists trg_restrict_technician_device_updates on public.devices;
create trigger trg_restrict_technician_device_updates
  before update on public.devices
  for each row execute function public.restrict_technician_device_updates();
