-- Publish HOW a device's blower gate decides, so readers stop guessing.
--
-- THE PROBLEM. Whether a clip counts as "blower running" is decided per
-- device, by one of several rules (ML/service/poll_and_infer.py,
-- blower_is_on). Nothing outside that function could tell which rule applied,
-- so every other reader hardcoded its own answer:
--
--   web/src/components/AcousticPanel.jsx  SILENCE_GATE_MEDIAN_DB = 2.5
--   Desktop/auto_download.py              SHAPE_GATE_DEVICES = {...}
--   ML/service/poll_and_infer.py          SHAPE_GATE_MACS = {...}
--
-- Three hand-synced copies of a safety-critical fact. The web app's copy is
-- measurably wrong today: 2.5 dB is a lab-rig constant, and P5's clips sit
-- around -20 to -35 dB, so the Acoustic panel labels EVERY P5 clip "Silent"
-- while the pipeline correctly scores the same audio as blower-on. That is
-- the same fleet-wide-constant error that discarded 82 of P3's wakes.
--
-- THE FIX. poll_and_infer writes the mode it actually used onto the baseline
-- row; everyone else reads it. 'median' means the clip's 72-bin median is
-- compared against gate_boundary_db (or, with no boundary yet, a fleet-wide
-- fallback). 'shape' means the decision needs the clip's spectral SHAPE
-- (ML/blower_signature.py) and CANNOT be reproduced from the 72-bin spectrum
-- a browser has -- so a reader seeing 'shape' must say it does not know,
-- rather than substituting a level test that is wrong for that device.
--
-- Default 'median' keeps every existing device behaving exactly as before.

alter table public.device_baselines
  add column if not exists gate_mode text not null default 'median';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'device_baselines_gate_mode_check'
  ) then
    alter table public.device_baselines
      add constraint device_baselines_gate_mode_check
      check (gate_mode in ('median', 'shape'));
  end if;
end $$;

comment on column public.device_baselines.gate_mode is
  'Which rule decides blower on/off for this device, written by '
  'ML/service/poll_and_infer.py. median = compare the 72-bin median against '
  'gate_boundary_db. shape = needs spectral shape (blower_signature.py); a '
  'client holding only the 72-bin spectrum cannot reproduce it and must not '
  'substitute a level threshold.';

-- P5 (Kannan House) is register-mounted: it hears airflow, not motor rumble,
-- so its blower moves the broadband median less than a television does.
update public.device_baselines
   set gate_mode = 'shape'
 where device_mac = 'E4B3238E6B10';

notify pgrst, 'reload schema';
