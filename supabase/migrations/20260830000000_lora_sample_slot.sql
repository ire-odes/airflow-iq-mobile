-- ============================================================================
-- AirFlow IQ -- slot-aligned sampling for LoRaWAN devices
--
-- WiFi devices poll devices.effective_wake_seconds over REST each cycle.
-- LoRaWAN devices have no IP and can't, so their cadence is compiled in --
-- P9 was observed uplinking every 74.4s while its wake_interval_seconds
-- said 600, i.e. the column was simply ignored.
--
-- WHY A SLOT AND NOT AN INTERVAL:
-- esp_sleep_enable_timer_wakeup(N) sleeps N seconds *from now*, so a
-- device's period is N + however long it stayed awake (~14.4s of the
-- observed 74.4s). Awake time varies with join attempts, retries and
-- sensor reads, so two devices never align and slowly separate. A slot is
-- absolute instead: the device sleeps until the next multiple of
-- sample_slot_seconds in wall-clock time, so every device converges on the
-- same boundaries regardless of boot phase, and each cycle re-corrects
-- rather than accumulating error. The device gets that wall clock from the
-- LoRaWAN DeviceTimeReq MAC command.
--
-- Values should divide evenly into an hour (60, 300, 900, 1800, 3600) or
-- the "boundary" walks across the hour. 900 (15 min) is a reasonable
-- default: it also cuts P9's ~1160 uplinks/day by ~12x, which matters
-- because that rate is well over TTN's fair-use airtime guidance.
--
-- NOTE this schedules when devices *sample*, deliberately not when they
-- transmit. LoRaWAN is ALOHA with no collision avoidance, so co-located
-- devices transmitting at the same instant collide at the gateway and both
-- packets are lost. Firmware is expected to sample on the boundary and
-- then stagger its uplink by a small deterministic per-device offset --
-- readings stay comparable across devices, radio traffic stays spread out.
--
-- Null means "device keeps its compiled-in default"; the downlink is only
-- sent when this is set, so existing devices are unaffected until opted in.
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- Safe to re-run.
-- ============================================================================

alter table public.devices
  add column if not exists sample_slot_seconds integer;

comment on column public.devices.sample_slot_seconds is
  'LoRaWAN slot-aligned sampling period in seconds, pushed to the device as '
  'a TTN downlink by the ingest_ttn function. Should divide evenly into an '
  'hour. Null = leave the device on its compiled-in default.';
