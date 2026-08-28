-- ============================================================================
-- AirFlow IQ -- LoRaWAN device pairing (blower side / filter side)
--
-- LoRaWAN nodes deploy in pairs: one upstream of the filter (blower side),
-- one downstream (filter side). Comparing the two is the point -- a rising
-- difference between them is filter restriction, and because both sides see
-- the same ambient conditions, the comparison cancels out drift that would
-- otherwise be mistaken for clogging.
--
-- That only works if the two units sample the SAME MOMENT. Readings taken
-- minutes apart during different blower states aren't comparable at all, so
-- the pair must share one slot: firmware sleeps to the next absolute
-- multiple of it (see lora_slot_seconds below and the firmware's
-- sleepUntilNextSlot), which puts both nodes on identical wall-clock
-- boundaries no matter when either booted.
--
-- WHAT THIS ADDS
--   is_lorawan        -- so the UI can offer pairing only where it applies,
--                        without joining audio_logs (which has no row until
--                        a device has actually uplinked)
--   duct_role         -- 'blower' or 'filter'; also fixes the transmit order
--                        within a pair, see below
--   paired_device_id  -- the other half, self-referencing
--   lora_slot_seconds -- the shared slot, resolved across the pair
--
-- WHY ROLE DECIDES TRANSMIT ORDER
-- LoRaWAN is ALOHA: no carrier sense, no collision avoidance. Two co-located
-- nodes transmitting at once collide at the gateway and BOTH packets are
-- lost -- so synchronising the radio would destroy the very data this is
-- meant to make comparable. Sampling is synchronised; transmission is
-- deliberately offset, blower first and filter a few seconds later. Deriving
-- that from the role rather than hashing the DevEUI makes an intra-pair
-- collision structurally impossible instead of merely unlikely.
--
-- Pairing is stored on both rows rather than in a join table. It's strictly
-- 1:1 and the UI always writes both sides together, so a join table would
-- add a hop without adding anything -- but it does mean a half-written pair
-- is possible, which is why the app writes both sides and the UI reads the
-- pair back to confirm.
--
-- Run this once in the Supabase Dashboard -> SQL Editor. Safe to re-run.
-- ============================================================================

alter table public.devices
  add column if not exists is_lorawan boolean not null default false;

alter table public.devices
  add column if not exists duct_role text;

alter table public.devices
  add column if not exists paired_device_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'devices_duct_role_check') then
    alter table public.devices
      add constraint devices_duct_role_check
      check (duct_role is null or duct_role in ('blower', 'filter'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'devices_paired_device_fk') then
    -- set null, not cascade: unpairing must never delete the other unit.
    alter table public.devices
      add constraint devices_paired_device_fk
      foreign key (paired_device_id) references public.devices(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'devices_no_self_pair') then
    alter table public.devices
      add constraint devices_no_self_pair
      check (paired_device_id is distinct from id);
  end if;
end $$;

-- Backfill: devices that have already uplinked over LoRa are known from
-- audio_logs.is_lora, which the ingest_ttn function sets.
update public.devices d
   set is_lorawan = true
  from public.audio_logs a
 where a.device_id = d.device_mac
   and a.is_lora = true
   and d.is_lorawan = false;

-- The slot both halves of a pair must agree on, in seconds.
--
-- LEAST across the pair rather than picking one side's value: if the two are
-- ever configured differently, the faster one wins and BOTH move to it. Any
-- other rule (blower wins, most-recently-set wins) can leave them on values
-- that don't share boundaries -- 900 and 1800 only coincide every 30 min,
-- which silently halves the paired sample rate.
--
-- Floored at 300s. LoRaWAN nodes can't sample as fast as WiFi ones: TTN's
-- fair use policy is roughly 30s of airtime per device per day, and at
-- SF8 a 55-byte uplink is far too expensive to send every minute. The
-- calibration sampling mode that drops WiFi devices to 60s must not apply
-- here, which is why this is a separate function from
-- effective_wake_seconds rather than an extension of it.
create or replace function public.lora_slot_seconds(d public.devices)
returns integer
language sql
stable
as $$
  select greatest(300, least(
    coalesce(d.sample_slot_seconds, d.wake_interval_seconds, 900),
    coalesce(
      (select coalesce(p.sample_slot_seconds, p.wake_interval_seconds, 900)
         from public.devices p
        where p.id = d.paired_device_id),
      2147483647   -- unpaired: LEAST collapses to this device's own value
    )
  ));
$$;

grant execute on function public.lora_slot_seconds(public.devices) to anon, authenticated, service_role;

-- Seconds this device waits after the slot boundary before transmitting.
-- Blower goes first, filter follows; an unpaired or unroled node keeps 0.
create or replace function public.lora_tx_offset_seconds(d public.devices)
returns integer
language sql
immutable
as $$
  select case when d.duct_role = 'filter' then 4 else 0 end;
$$;

grant execute on function public.lora_tx_offset_seconds(public.devices) to anon, authenticated, service_role;

comment on column public.devices.duct_role is
  'For paired LoRaWAN units: which side of the filter this node sits on. '
  'Also fixes transmit order within the pair (blower first) so the two '
  'never collide at the gateway.';
comment on column public.devices.paired_device_id is
  'The other half of a blower/filter pair. Written on both rows by the app.';
