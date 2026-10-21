-- Device lifecycle state: is this unit actually in a building, or on a shelf?
--
-- WHY. As of 2026-10-12 the devices table holds 27 rows and exactly 2 of them
-- are deployed (P3 and P5 - 135 Shore). The other 25 are spares, bench rigs,
-- LoRaWAN units and unassigned stock. Nothing in the schema says which is
-- which, so every list in the app shows all 27 side by side, each carrying
-- whatever verdict it last produced -- P1's is from 2026-09-04. A device that
-- has been in a drawer for five weeks is not "a device reading dirty", but
-- that is how it renders, and it is how it read to a human reviewing the
-- fleet this morning.
--
-- `claimed` does not answer this: it is false on both deployed devices and
-- true only on two room-308 bench units. `property_id` does not either --
-- spares carry one. Hence an explicit column.
--
-- DEFAULT IS 'spare', NOT 'deployed'. A new row is stock until someone says
-- otherwise; defaulting the other way would silently re-create the current
-- situation for every device added from now on. The backfill below therefore
-- leaves all 27 existing rows as 'spare' and then names the two that are
-- live, rather than guessing from property_id or recent activity.

alter table public.devices
  add column if not exists status text not null default 'spare';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'devices_status_check'
  ) then
    alter table public.devices
      add constraint devices_status_check
      check (status in ('deployed', 'spare', 'retired'));
  end if;
end $$;

comment on column public.devices.status is
  'Lifecycle state: deployed (installed in a building and expected to report), '
  'spare (stock, bench rig, or awaiting install), retired (decommissioned). '
  'The app lists deployed devices by default. A device NOT deployed is not '
  'expected to report, so its stale readings must not be shown as current.';

-- The two units actually installed as of 2026-10-12.
update public.devices
   set status = 'deployed'
 where device_mac in ('58E6C5204B28',   -- P3,  Abraham House
                      'E4B3238E6B10');  -- P5 - 135 Shore (Kannan House)

create index if not exists devices_status_idx on public.devices (status);

notify pgrst, 'reload schema';
