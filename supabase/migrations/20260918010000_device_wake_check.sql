-- ============================================================================
-- AirFlow IQ -- one request that answers "has my clip been scored, and how
-- long should I sleep?"
--
-- The burst-mode firmware waits on a normal wake for the ML to score the clip
-- it just uploaded, then sleeps for whatever effective_wake_seconds says. Doing
-- that against the plain tables took three requests per wake plus one per poll:
-- snapshot device_baselines.last_processed_at before uploading, poll it until
-- it changed, then read devices.effective_wake_seconds. Each is a round trip
-- with the radio at full power.
--
-- This collapses it. The device learns its clip's own upload stamp from the
-- audio_logs upsert (return=representation), then polls this function with it:
--
--   POST /rest/v1/rpc/device_wake_check  {"p_mac": "...", "p_since": "<stamp>"}
--   -> {"wake": 60, "scored": true}
--
-- "scored" is true once the poller has finished a clip at least as new as the
-- stamp -- including a clip it discarded as silence, since that stamps
-- last_processed_at too. "wake" is always the current answer, so on a timeout
-- the device still has an interval to sleep on.
--
-- The comparison happens here, as timestamptz, rather than as string equality
-- on the device, which would be fragile across JSON timestamp formats.
--
-- SECURITY DEFINER so it keeps working when the firmware moves off the
-- service-role key onto the anon key: it exposes one device's wake interval
-- and a boolean, nothing else.
-- ============================================================================

create or replace function public.device_wake_check(p_mac text, p_since timestamptz default null)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
           'wake',   public.effective_wake_seconds(d),
           'scored', coalesce(p_since is not null and b.last_processed_at >= p_since, false)
         )
    from public.devices d
    left join public.device_baselines b on b.device_mac = d.device_mac
   where d.device_mac = p_mac
$$;

revoke all on function public.device_wake_check(text, timestamptz) from public;
grant execute on function public.device_wake_check(text, timestamptz)
  to anon, authenticated, service_role;

-- Make the new function callable over REST immediately; PostgREST only sees
-- functions after its schema cache reloads.
notify pgrst, 'reload schema';
