-- ============================================================================
-- Fix: sensor_logs.rfid is written as an empty string ("") by the firmware
-- when no tag is currently detected, not null. Every "current RFID tag"
-- query in the app and in this function filtered `rfid is not null`, which
-- empty strings pass -- so whenever a device's most recent row (or the most
-- recent row sharing a device's "current" tag) had rfid = "", the computed
-- install date/tenant-due calculation silently locked onto the empty-string
-- streak instead of the real tag. Client-side queries got the same fix
-- (added `.neq("rfid", "")` alongside `.not("rfid", "is", null)`); this
-- migration re-applies it to check_tenant_filter_notifications(), the
-- pg_cron-scheduled function that drives tenant filter-due emails/SMS.
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- ============================================================================

create or replace function public.check_tenant_filter_notifications()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  r record;
begin
  for r in
    with latest_rfid as (
      select distinct on (device_id) device_id, rfid, recorded_at
      from public.sensor_logs
      where rfid is not null and rfid <> ''
      order by device_id, recorded_at desc
    ),
    installed as (
      select sl.device_id, min(sl.recorded_at) as installed_at
      from public.sensor_logs sl
      join latest_rfid lr on lr.device_id = sl.device_id and lr.rfid = sl.rfid
      group by sl.device_id
    )
    select
      d.id, d.name, d.hvac_location, d.tenant_email, d.tenant_phone,
      coalesce(d.filter_interval_days, 30) as interval_days,
      i.installed_at,
      extract(day from now() - i.installed_at)::int as days_since
    from public.devices d
    join installed i on i.device_id = d.id
    where (d.tenant_email is not null or d.tenant_phone is not null)
      and extract(day from now() - i.installed_at)::int >= coalesce(d.filter_interval_days, 30)
      and (d.tenant_notified_installed_at is null or d.tenant_notified_installed_at <> i.installed_at)
  loop
    if r.tenant_email is not null then
      perform public.enqueue_email_to_address(
        r.tenant_email,
        'tenant_filter_due',
        'Filter Replacement Reminder',
        jsonb_build_object(
          'device_name', coalesce(r.name, r.hvac_location, 'your HVAC unit'),
          'hvac_location', r.hvac_location,
          'days_since', r.days_since,
          'interval_days', r.interval_days
        )
      );
    end if;

    if r.tenant_phone is not null then
      perform public.enqueue_sms_to_number(
        r.tenant_phone,
        'tenant_filter_due',
        format(
          'AirFlow IQ: the HVAC filter for %s is due for replacement (installed %s days ago, %s-day interval). Please contact your property manager.',
          coalesce(r.name, r.hvac_location, 'your unit'), r.days_since, r.interval_days
        )
      );
    end if;

    update public.devices
    set tenant_notified_installed_at = r.installed_at
    where id = r.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.check_tenant_filter_notifications() from public, anon, authenticated;
