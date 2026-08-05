-- ============================================================================
-- AirFlow IQ — "Recalibrate" device action
--
-- Lets an owner reset their own device's acoustic baseline (e.g. after
-- moving the sensor, cleaning/replacing the mic, or installing a filter
-- known to be genuinely clean) so ML/service/poll_and_infer.py treats the
-- next reading as a fresh cold_start and rebuilds mean/covariance/EWMA
-- from scratch instead of comparing against stale "normal."
--
-- This is a straight row delete from the client (device_baselines has no
-- other owner-writable columns), gated by the same ownership check used
-- for filter settings elsewhere in the app -- owner only, not technicians,
-- since this is at least as consequential as changing filter_interval_days.
-- filter_ml_readings history is deliberately left untouched; recalibration
-- resets what "normal" means going forward, it isn't an audit-log wipe.
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- Safe to re-run: every statement is guarded.
-- ============================================================================

drop policy if exists "owners recalibrate own device baseline" on public.device_baselines;
create policy "owners recalibrate own device baseline"
  on public.device_baselines for delete
  using (
    exists (
      select 1 from public.devices d
      where d.device_mac = device_baselines.device_mac
        and d.owner_id = auth.uid()
    )
  );
