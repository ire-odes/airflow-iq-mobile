-- ============================================================================
-- AirFlow IQ -- track the wall-clock span a baseline's warmup covers
--
-- A baseline was allowed to freeze on sample count alone (120). With
-- sampling mode's 60s wakes that count is reached in ~2 hours, so the
-- covariance ends up describing a single narrow slice of operating
-- conditions -- one ambient temperature, one duty cycle, one household
-- noise floor -- rather than the device's normal range. Anything measured
-- outside that slice then scores as a large deviation.
--
-- This was observed directly, not theorised: on 2026-08-26 three devices
-- (P5, P7, P10) warmed over 2.25-2.66h afternoon windows with no filter
-- change, and overnight all three drifted upward -- P7 from ~3.5 to 6.15,
-- P5 from ~2.5 to 4.17, both crossing the 2.34 dirty threshold, while P10
-- sat at 2.37 (two exceedances short of also flipping). The distances were
-- correct; the baselines were just too narrow to compare against.
--
-- drift_detector.BaselineProfile now additionally requires the warmup to
-- span min_span_seconds of wall-clock time before freezing (see
-- MIN_BASELINE_SPAN_SECONDS in ML/service/poll_and_infer.py). These two
-- columns persist the window across poller restarts, since warmup now
-- outlives a single process run by design.
--
-- Nullable with no default: rows written before this existed have no
-- recorded window, and BaselineProfile.from_state() treats a missing
-- first_ts/last_ts as "span unknown" rather than assuming zero.
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- Safe to re-run.
-- ============================================================================

alter table public.device_baselines
  add column if not exists baseline_first_sample_at timestamptz;

alter table public.device_baselines
  add column if not exists baseline_last_sample_at timestamptz;
