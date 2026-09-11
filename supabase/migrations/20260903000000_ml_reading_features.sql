-- Store the drift feature vector on every ML reading.
--
-- Until now filter_ml_readings kept only the OUTPUT of the drift maths --
-- mahalanobis_distance and ewma_value -- and threw the 5-number input away.
-- device_baselines keeps only Welford's running mean and M2, never the
-- individual samples. So the moment a baseline froze, the readings that
-- produced it were gone.
--
-- Two things that cost us:
--
--  1. A frozen baseline could not be audited. On 2026-09-03 a real FPR12
--     swap registered at only the 94th percentile of P3's own baseline while
--     P6's *clean* readings sat at the 100th percentile of its own -- P3's
--     covariance is 3.6x wider than the tightest unit in the fleet. Whether
--     that is genuine environmental variation or a handful of outlier warmup
--     samples inflating it is unanswerable without the samples themselves.
--
--  2. A threshold could not be derived empirically. A Mahalanobis cut needs
--     no post-calibration clean data -- it follows from the baseline the
--     instant it freezes -- but doing it from the device's own measured
--     warmup distances, rather than from a Gaussian assumption, requires the
--     warmup vectors to still exist. See threshold_from_baseline() in
--     ML/drift_detector.py.
--
-- Nullable, so every existing row stays valid; already-frozen baselines
-- simply keep using the closed-form route.
--
-- Ordering matches DEFAULT_DRIFT_FEATURES in ML/drift_detector.py:
--   [low_freq_energy_ratio, centroid_mean, rolloff_mean,
--    flatness_mean, bandwidth_mean]
-- Positional rather than a jsonb object: these are read back as a matrix for
-- distance maths, the order is already pinned by the baseline's covariance,
-- and a per-row key repetition would triple the storage for no gain.

alter table public.filter_ml_readings
  add column if not exists features double precision[];

comment on column public.filter_ml_readings.features is
  'Drift feature vector for this reading, ordered as DEFAULT_DRIFT_FEATURES '
  'in ML/drift_detector.py: [low_freq_energy_ratio, centroid_mean, '
  'rolloff_mean, flatness_mean, bandwidth_mean]. Written for calibrating '
  'readings too -- those are the warmup samples a frozen baseline was fitted '
  'from, and they are what makes it auditable and empirically calibratable '
  'after the fact. Null on rows written before 2026-09-03.';

-- The freeze-time threshold derivation reads a device's calibrating rows in
-- one shot. Partial, because that query only ever wants rows that have a
-- vector, and this keeps the index off the majority that do not.
create index if not exists filter_ml_readings_features_idx
  on public.filter_ml_readings (device_mac, recorded_at)
  where features is not null;

-- No RLS change. filter_ml_readings' existing policies are read-only for
-- authenticated users and unrestricted for the service role, which is what
-- writes this column; a new column inherits both.
