-- ============================================================================
-- AirFlow IQ — persist which decision-maker actually produced each verdict
--
-- FilterHealthMonitor.process() (ML/drift_detector.py) already computes
-- decided_by ("calibrating" | "classifier" | "drift" | "classifier_override")
-- for every reading, but ML/service/poll_and_infer.py never wrote it to
-- filter_ml_readings -- only the final decision, not who made it. That
-- distinction matters for judging real-world tests: a "dirty" verdict from
-- drift (the primary, calibrated-per-device signal) is a much stronger
-- result than one from classifier_override (a safety-net escalation).
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- Safe to re-run: every statement is guarded.
-- ============================================================================

alter table public.filter_ml_readings
  add column if not exists decided_by text;
