-- Fix the query burning the project's Disk IO budget.
--
-- Both the Devices page (loadStats) and the Dashboard derive "when was the
-- current filter fitted" by reading a device's most recent sensor_logs rows
-- that carry an RFID tag:
--
--   select recorded_at, rfid from sensor_logs
--   where device_id = $1 and rfid is not null and rfid <> ''
--   order by recorded_at desc limit 100
--
-- Only 6.47% of sensor_logs rows have an RFID (3,786 of 58,517) -- the tag is
-- read on a filter change, not on every wake. idx_sensor_logs_device_time
-- covers (device_id, recorded_at desc), so the planner walks that device's
-- rows newest-first and discards ~15 out of every 16 as it goes. Measured on
-- one device:
--
--   Rows Removed by Filter: 3773
--   Buffers: shared hit=3671
--   Execution Time: 2979 ms
--
-- Three seconds and 3,671 block touches to return 100 rows, and pg_stat_
-- statements recorded 5,950 calls of it -- 24.1 million block hits and 53
-- minutes of database time, comfortably the largest IO consumer on the
-- project and the reason for Supabase's depletion warning.
--
-- A partial index over just the RFID-bearing rows removes the filter step
-- entirely: the scan visits only rows that already qualify. It indexes 6% of
-- the table, so it is small, and it costs nothing on insert for the 94% of
-- rows with no tag -- a partial index is only touched when its predicate
-- holds, which matters on a table taking a row per device per wake.
--
-- rfid is INCLUDEd so the query can be satisfied from the index alone
-- without heap fetches, which is where most of those 3,671 buffer hits went.

create index if not exists sensor_logs_device_rfid_idx
  on public.sensor_logs (device_id, recorded_at desc)
  include (rfid)
  where rfid is not null and rfid <> '';

comment on index public.sensor_logs_device_rfid_idx is
  'Serves the filter-install-date lookup (device_id + newest RFID rows) used '
  'by the Devices page and Dashboard. Partial: only ~6% of sensor_logs rows '
  'carry an RFID, and without this the query discards ~15 rows for every one '
  'it keeps. See migration 20260904000000.';
