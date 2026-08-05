-- ============================================================================
-- AirFlow IQ — Acoustic ML inference (filter clean/clogged classification +
-- per-device drift baseline)
--
-- audio_logs already exists (see 20260728030000_audio_logs_rls.sql) but has
-- no history -- one row per device_id (= device MAC), overwritten on every
-- upload. Drift detection needs a *sequence* of readings, so per-device
-- baseline state and a reading history live in their own tables here rather
-- than being bolted onto audio_logs.
--
-- Writes to these two new tables and to audio_logs.latest_verdict /
-- latest_confidence come ONLY from the external inference poller
-- (ML/service/poll_and_infer.py), authenticated with the service role key,
-- which bypasses RLS -- exactly like the existing device ingestion pipeline
-- writes to audio_logs. There is deliberately no insert/update/delete policy
-- here for `authenticated`; these tables are read-only from the app's point
-- of view, mirroring audio_logs' own access model.
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- Safe to re-run: every statement is guarded.
-- ============================================================================

-- ── Per-device baseline state (one row per device, keyed by MAC) ────────────
create table if not exists public.device_baselines (
  device_mac          text primary key,
  baseline_mean       double precision[],
  baseline_m2         double precision[],   -- flattened 5x5 running sum-of-squares
                                             -- (Welford's algorithm), needed to
                                             -- resume warmup accumulation across
                                             -- separate poller runs pre-freeze
  baseline_cov_inv    double precision[],   -- flattened 5x5, reshape client-side
  threshold           double precision,
  ewma                double precision,
  exceedance_count    integer not null default 0,
  state               text not null default 'cold_start'
                        check (state in ('cold_start', 'warming', 'warm')),
  n_warmup_samples    integer not null default 0,
  last_processed_at   timestamptz,
  updated_at          timestamptz not null default now()
);

comment on table public.device_baselines is
  'Per-device Mahalanobis baseline + EWMA drift-detector state for acoustic '
  'filter monitoring. Written only by the inference poller (service role).';

-- ── Reading history (append-only, one row per processed audio clip) ────────
create table if not exists public.filter_ml_readings (
  id                    uuid primary key default gen_random_uuid(),
  device_mac            text not null,
  recorded_at           timestamptz not null,
  classifier_label      text,
  classifier_confidence double precision,
  mahalanobis_distance  double precision,
  ewma_value            double precision,
  decision              text,
  disagreement_flag     text,
  created_at            timestamptz not null default now()
);

comment on table public.filter_ml_readings is
  'History of acoustic ML decisions per device. Written only by the '
  'inference poller (service role).';

create index if not exists filter_ml_readings_device_recorded_idx
  on public.filter_ml_readings (device_mac, recorded_at desc);

-- ── Denormalized latest-verdict columns on audio_logs ───────────────────────
-- Lets the existing getLatestRecording() query (web/src/lib/audioRecordings.js)
-- show a verdict next to the playable recording without a second query.
alter table public.audio_logs
  add column if not exists latest_verdict text;

alter table public.audio_logs
  add column if not exists latest_confidence double precision;

-- ── Row level security ───────────────────────────────────────────────────────
-- Same read-access shape as audio_logs' own policy: owner, landlord-wide
-- technician, or property-level technician. Writes are untouched (service
-- role only) -- no insert/update/delete policy for `authenticated`.

alter table public.device_baselines enable row level security;

drop policy if exists "users read baseline for accessible devices" on public.device_baselines;
create policy "users read baseline for accessible devices"
  on public.device_baselines for select
  using (
    exists (
      select 1 from public.devices d
      where d.device_mac = device_baselines.device_mac
        and (
          d.owner_id = auth.uid()
          or d.owner_id in (
            select landlord_id from public.technician_assignments
            where lower(technician_email) = lower(auth.jwt() ->> 'email')
          )
          or exists (
            select 1 from public.property_technician_assignments pta
            where pta.property_id = d.property_id
              and lower(pta.technician_email) = lower(auth.jwt() ->> 'email')
          )
        )
    )
  );

alter table public.filter_ml_readings enable row level security;

drop policy if exists "users read ml readings for accessible devices" on public.filter_ml_readings;
create policy "users read ml readings for accessible devices"
  on public.filter_ml_readings for select
  using (
    exists (
      select 1 from public.devices d
      where d.device_mac = filter_ml_readings.device_mac
        and (
          d.owner_id = auth.uid()
          or d.owner_id in (
            select landlord_id from public.technician_assignments
            where lower(technician_email) = lower(auth.jwt() ->> 'email')
          )
          or exists (
            select 1 from public.property_technician_assignments pta
            where pta.property_id = d.property_id
              and lower(pta.technician_email) = lower(auth.jwt() ->> 'email')
          )
        )
    )
  );
