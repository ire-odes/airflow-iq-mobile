-- ============================================================================
-- sensor_logs retention -- keeps the table from growing unbounded (it's
-- already the biggest, highest-write table: 12 devices posting every
-- ~10 minutes) without breaking filter-lifecycle tracking.
--
-- Naive "delete anything older than 30 days" is unsafe here:
-- filter_interval_days can be set up to 30 (FILTER_INTERVAL_MAX_DAYS in
-- web/src/lib/config.js), and the app finds a filter's install date by
-- looking at the OLDEST row still carrying its current RFID tag. A flat
-- 30-day purge could delete exactly that row right as a filter becomes
-- due, corrupting:
--   - check_tenant_filter_notifications() -- computes days-since-install
--     from that same oldest-row lookup, drives tenant due emails/SMS
--   - the "average lifespan" prediction (FilterStatus.jsx, dashboard.js)
--     -- needs several past RFID-change cycles to average across; a
--     30-day window can never hold more than one
--
-- So this keeps every row that marks the START of a new RFID tag forever
-- (one tiny row per filter change per device -- negligible size), and only
-- purges "routine" rows (readings between changes, and blank/no-tag
-- readings) once they're over a month old. Blank rfid ("" -- the firmware
-- writes this when no tag is detected, not null; see the RFID
-- empty-string fix) never counts as a transition, matching the same
-- change-detection logic already used client-side.
-- ============================================================================

create or replace function public.purge_old_sensor_logs()
returns integer
language sql
security definer
set search_path = public
as $$
  with rfid_rows as (
    select id, device_id, rfid, recorded_at,
           lag(rfid) over (partition by device_id order by recorded_at) as prev_rfid
    from public.sensor_logs
    where rfid is not null and rfid <> ''
  ),
  -- A transition = the first row of a new (non-blank) tag value for a
  -- device -- exactly "a filter was installed," never a routine re-read
  -- of the same tag.
  transitions as (
    select id from rfid_rows
    where prev_rfid is null or rfid is distinct from prev_rfid
  ),
  deleted as (
    delete from public.sensor_logs sl
    where sl.recorded_at < now() - interval '30 days'
      and sl.id not in (select id from transitions)
    returning 1
  )
  select count(*)::integer from deleted;
$$;

revoke execute on function public.purge_old_sensor_logs() from public, anon, authenticated;

-- Runs once a day, off-peak relative to the other cron jobs (outbox drain
-- every minute, tenant filter check at 13:00 UTC).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'purge-old-sensor-logs') then
    perform cron.unschedule('purge-old-sensor-logs');
  end if;
end $$;

select cron.schedule(
  'purge-old-sensor-logs',
  '0 8 * * *', -- 08:00 UTC daily
  $$ select public.purge_old_sensor_logs(); $$
);
