-- ============================================================================
-- AirFlow IQ -- one filter_ml_readings row per clip, enforced.
--
-- WHAT WENT WRONG. The ML poller runs as the scheduled task "Airflow IQ
-- inference poller". When a second copy was started by hand alongside it,
-- both processed every clip and both inserted a reading. Nothing in the
-- schema objected: filter_ml_readings had only a surrogate primary key, so
-- two rows for the same (device_mac, recorded_at) were perfectly legal.
--
-- Found 2026-09-18: 669 duplicate rows going back to 24 August, across nine
-- devices -- 541 of them on P3 alone, i.e. about half of P3's history.
--
-- WHAT IT DAMAGED, AND WHAT IT DID NOT.
--   * Baselines: intact. Every device's n_warmup_samples equals its count of
--     UNIQUE clips in the warmup window. Both pollers read the same prior
--     state and wrote identical results, so the Welford state is correct.
--   * Readings: doubled. That matters beyond tidiness, because two decision
--     rules count rows rather than clips -- the 30-reading recent-window
--     rule and the adaptive threshold's history. A doubled history halves
--     the window's real span and double-weights every reading in it.
--   * 30 of the 665 pairs disagree on the result. Those are the true race:
--     the second poller read state the first had already advanced, and so
--     applied the same clip twice. The EARLIER insert was computed from the
--     correct prior state, which is why it is the one kept below.
--
-- WHY FAIL LOUDLY. After this, a second poller's insert raises a unique
-- violation. The poller's per-device handler logs it as an ERROR and, because
-- the insert precedes save_monitor(), the losing process never persists its
-- state. A silent month of corruption becomes one obvious log line.
--
-- The 669 deleted rows were exported before this ran:
--   ML/backups/duplicate_readings_2026-09-18.json
-- ============================================================================

-- 1. Keep the earliest insert of each (device_mac, recorded_at), drop the rest.
delete from public.filter_ml_readings r
 using (
   select id
     from (select id,
                  row_number() over (partition by device_mac, recorded_at
                                     order by created_at, id) as rn
             from public.filter_ml_readings) ranked
    where rn > 1
 ) dup
 where r.id = dup.id;

-- 2. Replace the plain lookup index with a unique one on the same columns.
--    Same (device_mac, recorded_at DESC) shape, so every existing query --
--    the app's latest-reading lookup, the poller's recent-window scan --
--    keeps using it exactly as before.
drop index if exists public.filter_ml_readings_device_recorded_idx;

create unique index if not exists filter_ml_readings_one_per_clip
  on public.filter_ml_readings (device_mac, recorded_at desc);

comment on index public.filter_ml_readings_one_per_clip is
  'One reading per clip. A violation means two ML pollers are running at once '
  '-- stop the extra one; see 20260918000000_one_reading_per_clip.sql.';
