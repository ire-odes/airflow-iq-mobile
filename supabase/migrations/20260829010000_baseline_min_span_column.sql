-- ============================================================================
-- AirFlow IQ -- record the span requirement alongside the sample requirement
--
-- device_baselines already stores min_baseline_samples, so a reader can
-- tell how far along a warmup is without knowing what the poller was
-- configured with. 20260829000000 added a second freeze condition (the
-- warmup must span a minimum wall-clock window, not just reach a sample
-- count) but left that threshold only in Python, so anything reading the
-- table -- service/check_baseline.py, ad-hoc SQL -- had to hardcode a
-- matching 20h or report progress against the wrong gate.
--
-- Storing it mirrors min_baseline_samples: the row says what it was
-- actually judged against, so changing MIN_BASELINE_SPAN_SECONDS later
-- doesn't silently invalidate how existing rows are interpreted.
--
-- Nullable: rows written before this have no recorded requirement, and
-- readers should treat null as "unknown, assume the current default".
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- Safe to re-run.
-- ============================================================================

alter table public.device_baselines
  add column if not exists min_baseline_span_seconds integer;
