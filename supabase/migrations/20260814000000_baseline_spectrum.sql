-- ============================================================================
-- AirFlow IQ — persist a per-device baseline frequency spectrum
--
-- web/src/components/AcousticPanel.jsx already shows the *current*
-- reading's spectrum (web/src/lib/audioRecordings.js's computeSpectrum(),
-- computed client-side from the downloaded wav) but has nothing to compare
-- it against -- there's a literal "baseline not available yet" tooltip on
-- the chart today.
--
-- This adds a baseline_spectrum_db column: a running average (in dB, same
-- 72 log-spaced bins as computeSpectrum(), same order) accumulated by
-- ML/service/poll_and_infer.py across a device's warmup readings, using
-- the exact same poisoning-guard gate and freeze point as the 5-feature
-- drift baseline already in this table -- so "baseline" means the same
-- thing everywhere in this system, not two different concepts with the
-- same name. spectrum_n tracks how many readings have been averaged in,
-- the same role n_warmup_samples plays for the 5-feature baseline.
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- Safe to re-run: every statement is guarded.
-- ============================================================================

alter table public.device_baselines
  add column if not exists baseline_spectrum_db double precision[];

alter table public.device_baselines
  add column if not exists spectrum_n integer not null default 0;
