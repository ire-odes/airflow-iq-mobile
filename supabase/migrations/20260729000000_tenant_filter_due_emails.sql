-- ============================================================================
-- Automated tenant notification when a filter is actually due (replaces the
-- old approach, which was just a mailto: link the landlord had to send by
-- hand). Runs on a schedule via pg_cron, reusing the existing email_outbox /
-- send-emails / Resend pipeline built for order and invoice emails.
--
-- "Due" is computed the same way the app already infers it: the current RFID
-- tag's first-seen timestamp in sensor_logs vs. the device's
-- filter_interval_days (default 30). One email per install cycle — a new
-- filter (new RFID tag) resets tenant_notified_installed_at, so the tenant
-- gets reminded again next time that new filter becomes due, but isn't
-- re-emailed every day while the same overdue filter just sits there.
-- ============================================================================

alter table public.devices
  add column if not exists tenant_notified_installed_at timestamptz;

-- Mirrors enqueue_email_to_user, but for a tenant, who isn't necessarily an
-- app user at all — no auth.users lookup, the email address is given
-- directly.
create or replace function public.enqueue_email_to_address(
  p_to_email text, p_template text, p_subject text, p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.email_outbox (user_id, to_email, template, subject, payload)
  values (null, p_to_email, p_template, p_subject, coalesce(p_payload, '{}'::jsonb));
end;
$$;

revoke execute on function public.enqueue_email_to_address(text, text, text, jsonb)
  from public, anon, authenticated;

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
      where rfid is not null
      order by device_id, recorded_at desc
    ),
    installed as (
      select sl.device_id, min(sl.recorded_at) as installed_at
      from public.sensor_logs sl
      join latest_rfid lr on lr.device_id = sl.device_id and lr.rfid = sl.rfid
      group by sl.device_id
    )
    select
      d.id, d.name, d.hvac_location, d.tenant_email,
      coalesce(d.filter_interval_days, 30) as interval_days,
      i.installed_at,
      extract(day from now() - i.installed_at)::int as days_since
    from public.devices d
    join installed i on i.device_id = d.id
    where d.tenant_email is not null
      and extract(day from now() - i.installed_at)::int >= coalesce(d.filter_interval_days, 30)
      -- Skip if already notified for this exact install cycle.
      and (d.tenant_notified_installed_at is null or d.tenant_notified_installed_at <> i.installed_at)
  loop
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

    update public.devices
    set tenant_notified_installed_at = r.installed_at
    where id = r.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke execute on function public.check_tenant_filter_notifications() from public, anon, authenticated;

-- Runs once a day. Cheap query, and "due" changes on the order of days, not
-- minutes, so daily is frequent enough without spamming.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'check-tenant-filter-notifications') then
    perform cron.unschedule('check-tenant-filter-notifications');
  end if;
end $$;

select cron.schedule(
  'check-tenant-filter-notifications',
  '0 13 * * *', -- 13:00 UTC daily
  $$ select public.check_tenant_filter_notifications(); $$
);
