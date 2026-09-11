-- Fix the wake interval fleet-wide at 4 hours and stop clients setting it.
--
-- WHY IT IS NOT A PREFERENCE. Measured on 2026-09-10: a wake cycle is 7.3s of
-- active time (consistent across P1/P3/P6/P12, taken from sampling-mode
-- cadence where RTC drift is small relative to the active window). Against the
-- firmware's own sequence -- 1.5s RFID wait, 1.2s audio capture, WiFi
-- association with setSleep(false), then four separate TLS handshakes -- that
-- is ~0.243 mAh per cycle. So:
--
--     10-minute wakes : 144 cycles/day = ~35.0 mAh/day
--     4-hour wakes    :   6 cycles/day =  ~1.5 mAh/day
--
-- a 24x difference in the one term anyone controls. Leaving the field editable
-- meant a single edit could cut a device's field life by an order of
-- magnitude, and the battery ADC cannot be trusted to reveal it: the firmware
-- itself documents that BATTERY_PIN is clamped by the 5V rail and "will NOT
-- make this pin track real battery charge level."
--
-- WHAT THIS COSTS. Detection gets slower, and that is a deliberate trade:
--   * PATIENCE=3 consecutive exceedances now takes >=12h rather than ~30min
--   * RECENT_WINDOW_MIN=12 readings takes 2 days to fill
--   * the 30-reading count window spans 5 days
--   * adaptive thresholding needs 50 post-freeze readings -- 8+ days
-- Calibration is unaffected: calibration_started_at already drops
-- effective_wake_seconds to 60s, and that path is untouched here.

-- Existing devices move to the new cadence. Devices mid-calibration are
-- included deliberately: effective_wake_seconds overrides this to 60s while
-- calibration_started_at is set, so the stored value only takes effect once
-- they finish -- which is exactly when it should.
update public.devices
   set wake_interval_seconds = 14400
 where wake_interval_seconds is distinct from 14400;

alter table public.devices
  alter column wake_interval_seconds set default 14400;

-- Enforced in the database, not just hidden in the UI. A disabled input is a
-- hint; the anon key can still PATCH the column directly, and this table is
-- writable by device owners under RLS.
alter table public.devices
  drop constraint if exists devices_wake_interval_fixed;

alter table public.devices
  add constraint devices_wake_interval_fixed
  check (wake_interval_seconds = 14400);

comment on column public.devices.wake_interval_seconds is
  'Seconds between device wakes. Fixed at 14400 (4h) fleet-wide by CHECK '
  'constraint -- a battery-life decision, not a user preference. See '
  'migration 20260910000000. Calibration still samples at 60s via '
  'effective_wake_seconds, which is unaffected.';
