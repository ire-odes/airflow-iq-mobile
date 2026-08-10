-- ============================================================================
-- AirFlow IQ — persist the classifier-override patience counter, and expose
-- the warmup target so the app can show real "Calibrating... N/M" progress
--
-- FilterHealthMonitor now requires `patience` consecutive WARM-state
-- readings where the classifier is confident-dirty against a calm drift
-- baseline before it overrides the decision (previously fired on a single
-- reading -- risky given the classifier is confirmed to misfire on new
-- environments). That counter has to survive across separate poller runs
-- (ML/service/poll_and_infer.py is a fresh process each time), same as
-- everything else in device_baselines.
--
-- min_baseline_samples is also stored per-row now (previously only a
-- hardcoded constant in the poller) purely so the app can compute and show
-- warmup progress (n_warmup_samples / min_baseline_samples) without needing
-- to know the poller's internals.
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- Safe to re-run: every statement is guarded.
-- ============================================================================

alter table public.device_baselines
  add column if not exists override_streak integer not null default 0;

alter table public.device_baselines
  add column if not exists min_baseline_samples integer not null default 120;
