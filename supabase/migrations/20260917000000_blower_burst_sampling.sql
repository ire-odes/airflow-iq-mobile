-- ============================================================================
-- AirFlow IQ -- "blower burst": sample once a minute while the blower is
-- actually running, and drop back to the normal interval when it stops.
--
-- WHY THIS EXISTS. A filter is only audible while air is moving through it.
-- P6 proved the point the hard way: it sat at 23 of 120 warmup samples for
-- thirteen hours because its blower was off, and every clip it did upload in
-- that window was correctly discarded by the spectral silence gate. Sampling
-- on a fixed timer spends battery uniformly across a day that is mostly
-- silence, and collects almost nothing usable.
--
-- Inverting it: stay on the slow interval while quiet, and burst to 60s the
-- moment a clip clears the gate. The device then banks samples densely for
-- exactly as long as the blower runs.
--
-- WHY THE ML DECIDES AND NOT THE DEVICE. The firmware has no FFT and no
-- baseline; the "is the blower running" test is the median of a 72-bin log
-- spectrum against a -2.5 dB cut (SPECTRAL_GATE_MIN_MEDIAN_DB in
-- ML/service/poll_and_infer.py). That already runs on every clip. Rather
-- than port it to the ESP32, the poller writes its answer here and the
-- firmware keeps treating effective_wake_seconds as an opaque number of
-- seconds -- the same contract it already has.
--
-- WHY A DEADLINE AND NOT A BOOLEAN. If the poller stops (desktop asleep, as
-- happened overnight on 16 Sep), a boolean would strand the device at 60s
-- wakes forever and flatten the battery. A timestamp expires on its own, so
-- the failure mode is "returns to the normal interval", not "never sleeps".
-- ============================================================================

alter table public.devices
  add column if not exists blower_burst_until timestamptz;

comment on column public.devices.blower_burst_until is
  'Set by the ML poller when a clip clears the spectral silence gate: burst to '
  '60s sampling until this moment passes. Self-expiring so a stalled poller '
  'cannot pin a device awake. Null or past = normal wake interval.';

-- Same contract as before, with one new branch. Order matters: calibration
-- still wins, so a recalibration is never slowed down by a quiet blower.
create or replace function public.effective_wake_seconds(d public.devices)
returns integer
language sql
stable
as $$
  select case
    -- 1. Calibration sampling mode (unchanged).
    when d.calibration_started_at is not null
     and d.calibration_started_at > now() - interval '6 hours'
     and coalesce(
           (select b.state from public.device_baselines b
             where b.device_mac = d.device_mac),
           'cold_start'
         ) <> 'warm'
    then 60

    -- 2. Blower burst: the ML heard air moving on this device's last clip.
    when d.blower_burst_until is not null
     and d.blower_burst_until > now()
    then 60

    -- 3. Normal.
    else coalesce(d.wake_interval_seconds, 600)
  end;
$$;

grant execute on function public.effective_wake_seconds(public.devices)
  to anon, authenticated, service_role;

-- The device reads this column back while deciding how long to sleep, using
-- the anon key, so the same read access the rest of the row already has.
-- No new write grant: only the service-role poller sets it.
