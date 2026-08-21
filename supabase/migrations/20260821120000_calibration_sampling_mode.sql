-- ============================================================================
-- AirFlow IQ -- "sampling mode": fast 1-minute wakes right after a
-- recalibration, so a device collects its 120 warmup samples in hours
-- instead of days.
--
-- Background: drift_detector.py's BaselineProfile needs
-- min_baseline_samples (120) readings before it can freeze a baseline and
-- start detecting drift. At the default 600s wake interval that's ~20h of
-- perfect uptime, and longer in practice since readings taken while the
-- HVAC is off get dropped (extract_features_v2.SILENCE_RMS_THRESHOLD).
-- Sampling every 60s instead gets a device warm in ~2h of runtime.
--
-- WHY A COMPUTED COLUMN INSTEAD OF A TIMESTAMP THE DEVICE READS:
-- the ESP32 firmware has no wall clock -- no NTP sync, no RTC, and
-- millis() resets on every deep sleep -- so it cannot evaluate "has it
-- been less than N hours since calibration started?" on its own. Postgres
-- can, and the firmware already fetches wake_interval_seconds from this
-- table, so it just fetches this computed value in the same request
-- instead and keeps treating the answer as an opaque number of seconds.
--
-- WHY IT ENDS ON state='warm' RATHER THAN A FIXED 2-HOUR TIMER:
-- readings taken while the HVAC is off never reach the baseline, so a
-- fixed timer would routinely expire with well under 120 samples banked.
-- Ending when the baseline actually freezes tracks real progress. The
-- 6-hour cap is a battery backstop for a device that never warms up
-- (mic failure, HVAC off for the whole window) -- at 60s that's ~360
-- wake cycles, far more than the 120 needed, so it only bites in the
-- genuinely-stuck case.
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- Safe to re-run: every statement is guarded or CREATE OR REPLACE.
-- ============================================================================

alter table public.devices
  add column if not exists calibration_started_at timestamptz;

-- Exposed to PostgREST as a computed ("virtual") column on devices, so
-- the firmware can request it with ?select=effective_wake_seconds exactly
-- the way it currently requests wake_interval_seconds. Must be STABLE
-- (not VOLATILE) for PostgREST to allow it; now() is stable.
create or replace function public.effective_wake_seconds(d public.devices)
returns integer
language sql
stable
as $$
  select case
    when d.calibration_started_at is not null
     and d.calibration_started_at > now() - interval '6 hours'
     and coalesce(
           (select b.state from public.device_baselines b
             where b.device_mac = d.device_mac),
           'cold_start'
         ) <> 'warm'
    then 60
    else coalesce(d.wake_interval_seconds, 600)
  end;
$$;

grant execute on function public.effective_wake_seconds(public.devices) to anon, authenticated, service_role;
