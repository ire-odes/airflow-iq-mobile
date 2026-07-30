-- ============================================================================
-- SMS outbox — mirrors email_outbox exactly, but for text messages sent via
-- Twilio (see supabase/functions/send-sms). No client ever reads/writes this
-- table directly; RLS is enabled with zero policies, same "deny by default"
-- posture as email_outbox — only SECURITY DEFINER functions and the
-- service-role edge function touch it.
-- ============================================================================

create table if not exists public.sms_outbox (
  id          uuid primary key default gen_random_uuid(),
  to_phone    text not null,
  template    text not null,
  body        text not null,
  status      text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  error       text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  claimed_at  timestamptz
);

alter table public.sms_outbox enable row level security;

-- Atomic claim, identical pattern to claim_queued_emails.
create or replace function public.claim_queued_sms(p_limit int default 25)
returns setof public.sms_outbox
language sql
security definer
set search_path = public
as $$
  update public.sms_outbox
  set status = 'sending', claimed_at = now()
  where id in (
    select id from public.sms_outbox
    where status = 'queued'
       or (status = 'sending' and claimed_at < now() - interval '15 minutes')
    order by created_at
    limit p_limit
    for update skip locked
  )
  returning *;
$$;

revoke execute on function public.claim_queued_sms(int) from public, anon, authenticated;
grant execute on function public.claim_queued_sms(int) to service_role;

-- Mirrors enqueue_email_to_address — a tenant isn't necessarily an app user.
create or replace function public.enqueue_sms_to_number(
  p_to_phone text, p_template text, p_body text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.sms_outbox (to_phone, template, body)
  values (p_to_phone, p_template, p_body);
end;
$$;

revoke execute on function public.enqueue_sms_to_number(text, text, text)
  from public, anon, authenticated;

-- Drain every minute, same cadence as send-emails.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'process-sms-outbox') then
    perform cron.unschedule('process-sms-outbox');
  end if;
end $$;

select cron.schedule(
  'process-sms-outbox',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://hniplnaohvcbtmelatnz.supabase.co/functions/v1/send-sms',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuaXBsbmFvaHZjYnRtZWxhdG56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1Nzk0MjAsImV4cCI6MjA4MDE1NTQyMH0.g7sgeZBW0RKkMI1lryA96Sym6cnejUAcmIx_npGr1Ko'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

-- ── Extend the tenant filter-due check to also text, when a phone is set ───
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
