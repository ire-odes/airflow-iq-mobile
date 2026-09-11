-- Overdue-filter escalation, interactive landlord acknowledgements, and a
-- tenant test email.
--
-- Depends on 20260911010000 (devices.tenant_emails, properties.landlord_email,
-- profiles.interactive_landlord_acks).
--
-- WHAT CHANGES FOR RECIPIENTS
--   Due day      : unchanged one-off reminder, now to EVERY tenant address.
--   Days 1-5     : one "overdue" email a day to every tenant and the landlord,
--   after due      each day sent at most once (filter_overdue_notices).
--   Stops when   : a new RFID-tagged filter is seen, or the landlord
--                  acknowledges the change (email link or dashboard button).
--
-- A filter already more than 5 days overdue when this ships is outside its
-- window and gets nothing -- the literal reading of "the 5 days after the due
-- date", and what keeps months-overdue bench units from emailing anyone.
--
-- "Days past due" is counted in America/Chicago calendar days, matching when
-- the daily job runs (13:00 UTC = 8am Central).

-- 1. Acknowledgements --------------------------------------------------------
-- An acknowledgement is the landlord saying "this filter was changed". It
-- restarts the filter clock exactly as a new RFID tag would, which is what
-- stops the escalation and what the next due date is counted from.
create table if not exists public.filter_acknowledgements (
  id                    uuid primary key default gen_random_uuid(),
  device_id             uuid not null references public.devices(id) on delete cascade,
  acknowledged_at       timestamptz not null default now(),
  acknowledged_by_email text,
  method                text not null check (method in ('email_link', 'dashboard')),
  previous_installed_at timestamptz
);
create index if not exists filter_acknowledgements_device_idx
  on public.filter_acknowledgements (device_id, acknowledged_at desc);

alter table public.filter_acknowledgements enable row level security;
drop policy if exists "read acknowledgements for visible devices" on public.filter_acknowledgements;
create policy "read acknowledgements for visible devices" on public.filter_acknowledgements
  for select using (exists (select 1 from public.devices d where d.id = device_id));
-- No insert/update/delete policies: rows are only written by the
-- security-definer functions below, which do their own authorisation.

-- 2. One-time acknowledgement tokens ----------------------------------------
-- Only the SHA-256 of a token is stored. The token itself exists in the
-- landlord's inbox and nowhere else (send-emails scrubs it from the outbox
-- copy once sent), so a database read cannot be turned into a usable link.
create table if not exists public.filter_ack_tokens (
  token_hash         bytea primary key,
  device_id          uuid not null references public.devices(id) on delete cascade,
  landlord_email     text not null,
  cycle_installed_at timestamptz,          -- the filter cycle it was issued for
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default now() + interval '14 days',
  used_at            timestamptz,
  is_test            boolean not null default false
);
alter table public.filter_ack_tokens enable row level security;
revoke all on public.filter_ack_tokens from anon, authenticated;

-- 3. Notice ledger ----------------------------------------------------------
-- One row per device, filter cycle and day. The primary key is what makes the
-- escalation idempotent: re-running the job, or running it twice in a day,
-- cannot send the same day's notice again.
create table if not exists public.filter_overdue_notices (
  device_id          uuid not null references public.devices(id) on delete cascade,
  cycle_installed_at timestamptz not null,
  day_number         int  not null check (day_number between 1 and 5),
  sent_on            date not null,
  recipients         text[] not null,
  created_at         timestamptz not null default now(),
  primary key (device_id, cycle_installed_at, day_number)
);
alter table public.filter_overdue_notices enable row level security;
drop policy if exists "read notices for visible devices" on public.filter_overdue_notices;
create policy "read notices for visible devices" on public.filter_overdue_notices
  for select using (exists (select 1 from public.devices d where d.id = device_id));

-- 4. Where each device's filter cycle stands ---------------------------------
-- installed_at is the later of: when the current RFID tag was first seen, and
-- the latest acknowledgement. greatest() ignores NULLs, so a device with only
-- one of the two still has a cycle.
create or replace function public.device_filter_cycles()
returns table (device_id uuid, installed_at timestamptz, interval_days int,
               due_on date, days_past_due int)
language sql stable security definer set search_path = public as $$
  with latest_rfid as (
    select distinct on (sl.device_id) sl.device_id, sl.rfid
    from sensor_logs sl
    where sl.rfid is not null and sl.rfid <> ''
    order by sl.device_id, sl.recorded_at desc
  ),
  rfid_installed as (
    select sl.device_id, min(sl.recorded_at) as installed_at
    from sensor_logs sl
    join latest_rfid lr on lr.device_id = sl.device_id and lr.rfid = sl.rfid
    group by sl.device_id
  ),
  last_ack as (
    select fa.device_id, max(fa.acknowledged_at) as acknowledged_at
    from filter_acknowledgements fa group by fa.device_id
  ),
  cycles as (
    select d.id as device_id,
           greatest(r.installed_at, a.acknowledged_at) as installed_at,
           coalesce(d.filter_interval_days, 30) as interval_days
    from devices d
    left join rfid_installed r on r.device_id = d.id
    left join last_ack a on a.device_id = d.id
    where d.owner_id is not null
  )
  select c.device_id, c.installed_at, c.interval_days,
         (c.installed_at at time zone 'America/Chicago')::date + c.interval_days,
         (now() at time zone 'America/Chicago')::date
           - ((c.installed_at at time zone 'America/Chicago')::date + c.interval_days)
  from cycles c
  where c.installed_at is not null;
$$;
revoke all on function public.device_filter_cycles() from public, anon, authenticated;

-- 5. Addresses ----------------------------------------------------------------
-- The property's designated landlord address, else the owner's account email.
create or replace function public.landlord_email_for_device(p_device_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select lower(coalesce(nullif(trim(p.landlord_email), ''), u.email))
  from devices d
  left join properties p on p.id = d.property_id
  left join auth.users u on u.id = d.owner_id
  where d.id = p_device_id;
$$;
revoke all on function public.landlord_email_for_device(uuid) from public, anon, authenticated;

create or replace function public.app_base_url()
returns text language sql immutable as $$ select 'https://www.airfloiq.com' $$;

-- 6. Issue a token -----------------------------------------------------------
create or replace function public.issue_filter_ack_token(
  p_device_id uuid, p_landlord_email text, p_cycle_installed_at timestamptz,
  p_is_test boolean default false)
returns text language plpgsql volatile security definer
set search_path = public, extensions as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into filter_ack_tokens (token_hash, device_id, landlord_email, cycle_installed_at, is_test)
  values (extensions.digest(v_token, 'sha256'), p_device_id, lower(p_landlord_email),
          p_cycle_installed_at, p_is_test);
  return v_token;
end $$;
revoke all on function public.issue_filter_ack_token(uuid, text, timestamptz, boolean)
  from public, anon, authenticated;

-- 7. Describe a token without using it ----------------------------------------
-- The /ack page calls this on load and only consumes the token when the
-- landlord presses the button. Mail scanners routinely open links in emails;
-- if merely loading the link recorded an acknowledgement, a scanner could mark
-- a filter changed that nobody touched.
create or replace function public.describe_filter_ack_token(p_token text)
returns jsonb language plpgsql stable security definer
set search_path = public, extensions as $$
declare
  t record;
  v_current timestamptz;
  v_status text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;

  select tk.used_at, tk.expires_at, tk.is_test, tk.device_id, tk.cycle_installed_at,
         coalesce(d.name, d.hvac_location, 'Your HVAC unit') as device_name,
         d.hvac_location, p.name as property_name,
         coalesce(pr.interactive_landlord_acks, false) as enabled
    into t
  from filter_ack_tokens tk
  join devices d on d.id = tk.device_id
  left join properties p on p.id = d.property_id
  left join profiles pr on pr.id = d.owner_id
  where tk.token_hash = extensions.digest(p_token, 'sha256');

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  select c.installed_at into v_current
  from public.device_filter_cycles() c where c.device_id = t.device_id;

  v_status := case
    when t.used_at is not null                     then 'used'
    when t.expires_at < now()                      then 'expired'
    when t.is_test                                 then 'ready'
    when not t.enabled                             then 'disabled'
    when v_current is distinct from t.cycle_installed_at
         and v_current > t.cycle_installed_at      then 'superseded'
    else 'ready'
  end;

  return jsonb_build_object(
    'status', v_status, 'is_test', t.is_test,
    'device_name', t.device_name, 'hvac_location', t.hvac_location,
    'property_name', t.property_name, 'used_at', t.used_at);
end $$;
revoke all on function public.describe_filter_ack_token(text) from public;
grant execute on function public.describe_filter_ack_token(text) to anon, authenticated;

-- 8. Use a token -------------------------------------------------------------
-- Authority comes from the token, not the session: the landlord is usually
-- clicking from a phone with no login. Single use is enforced under a row
-- lock, so two simultaneous clicks cannot both record.
create or replace function public.acknowledge_filter_change_by_token(p_token text)
returns jsonb language plpgsql volatile security definer
set search_path = public, extensions as $$
declare
  v_desc jsonb := public.describe_filter_ack_token(p_token);
  t record;
  v_prev timestamptz;
begin
  if v_desc->>'status' <> 'ready' then
    return v_desc || jsonb_build_object('ok', false);
  end if;

  select * into t from filter_ack_tokens
  where token_hash = extensions.digest(p_token, 'sha256')
  for update;

  if t.used_at is not null then
    return v_desc || jsonb_build_object('ok', false, 'status', 'used');
  end if;

  update filter_ack_tokens set used_at = now() where token_hash = t.token_hash;

  if t.is_test then
    return v_desc || jsonb_build_object('ok', true, 'status', 'test');
  end if;

  select c.installed_at into v_prev
  from public.device_filter_cycles() c where c.device_id = t.device_id;

  insert into filter_acknowledgements (device_id, acknowledged_by_email, method, previous_installed_at)
  values (t.device_id, t.landlord_email, 'email_link', v_prev);

  return v_desc || jsonb_build_object('ok', true, 'status', 'acknowledged');
end $$;
revoke all on function public.acknowledge_filter_change_by_token(text) from public;
grant execute on function public.acknowledge_filter_change_by_token(text) to anon, authenticated;

-- 9. Acknowledge from the dashboard ------------------------------------------
create or replace function public.acknowledge_filter_change(p_device_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_owner uuid;
  v_enabled boolean;
  v_prev timestamptz;
begin
  select d.owner_id, coalesce(pr.interactive_landlord_acks, false)
    into v_owner, v_enabled
  from devices d left join profiles pr on pr.id = d.owner_id
  where d.id = p_device_id;

  if v_owner is null or v_owner <> auth.uid() then
    raise exception 'Only the device owner can acknowledge a filter change'
      using errcode = '42501';
  end if;
  if not v_enabled then
    raise exception 'Interactive landlord acknowledgements are turned off in Account settings'
      using errcode = '42501';
  end if;

  select c.installed_at into v_prev
  from public.device_filter_cycles() c where c.device_id = p_device_id;

  insert into filter_acknowledgements (device_id, acknowledged_by_email, method, previous_installed_at)
  values (p_device_id, lower(auth.email()), 'dashboard', v_prev);

  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.acknowledge_filter_change(uuid) from public, anon;
grant execute on function public.acknowledge_filter_change(uuid) to authenticated;

-- 10. Tenant test email --------------------------------------------------------
-- Owners can test their own device's tenant list; only admins (or the service
-- itself) may name an arbitrary recipient, so this cannot be used to send mail
-- to strangers. Throttled to 5 per device per hour for the same reason.
create or replace function public.send_tenant_test_email(
  p_device_id uuid default null, p_to text default null)
returns int language plpgsql volatile security definer set search_path = public as $$
declare
  v_privileged boolean := coalesce(auth.role(), '') not in ('authenticated', 'anon')
                          or public.is_admin();
  v_owner uuid;
  v_name text;
  v_list text[] := '{}';
  v_email text;
  v_n int := 0;
begin
  if p_device_id is not null then
    select d.owner_id, coalesce(d.name, d.hvac_location), d.tenant_emails
      into v_owner, v_name, v_list
    from devices d where d.id = p_device_id;
    if not found then raise exception 'Device not found'; end if;
    if not v_privileged and (v_owner is null or v_owner <> auth.uid()) then
      raise exception 'Only the device owner can send a test email' using errcode = '42501';
    end if;
    if (select count(*) from email_outbox
          where template = 'tenant_email_test'
            and payload->>'device_id' = p_device_id::text
            and created_at > now() - interval '1 hour') >= 5 then
      raise exception 'Test email limit reached for this device -- try again in an hour';
    end if;
  end if;

  if p_to is not null then
    if not v_privileged then
      raise exception 'Only admins can send a test email to an arbitrary address'
        using errcode = '42501';
    end if;
    v_list := array[lower(trim(p_to))];
  end if;

  if coalesce(cardinality(v_list), 0) = 0 then
    raise exception 'No tenant email addresses to test';
  end if;

  foreach v_email in array v_list loop
    perform enqueue_email_to_address(
      v_email, 'tenant_email_test', 'AirFlow IQ test: tenant notifications',
      jsonb_build_object('device_name', v_name, 'device_id', p_device_id,
                         'requested_at', now()));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.send_tenant_test_email(uuid, text) from public, anon;
grant execute on function public.send_tenant_test_email(uuid, text) to authenticated;

-- 11. The daily job (cron 'check-tenant-filter-notifications', 13:00 UTC) ----
create or replace function public.check_tenant_filter_notifications()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_count int := 0;
  r record;
  v_email text;
  v_token text;
  v_recipients text[];
begin
  -- A. Due-day reminder: the original one-off, now to every tenant address.
  for r in
    select d.id, d.name, d.hvac_location, d.tenant_emails, d.tenant_phone,
           c.installed_at, c.interval_days,
           (now() at time zone 'America/Chicago')::date
             - (c.installed_at at time zone 'America/Chicago')::date as days_since
    from devices d
    join public.device_filter_cycles() c on c.device_id = d.id
    where (cardinality(d.tenant_emails) > 0 or d.tenant_phone is not null)
      and c.days_past_due >= 0
      and (d.tenant_notified_installed_at is null
           or d.tenant_notified_installed_at <> c.installed_at)
  loop
    foreach v_email in array r.tenant_emails loop
      perform enqueue_email_to_address(
        v_email, 'tenant_filter_due', 'Filter Replacement Reminder',
        jsonb_build_object(
          'device_name', coalesce(r.name, r.hvac_location, 'your HVAC unit'),
          'hvac_location', r.hvac_location,
          'days_since', r.days_since,
          'interval_days', r.interval_days));
    end loop;

    if r.tenant_phone is not null then
      perform enqueue_sms_to_number(
        r.tenant_phone, 'tenant_filter_due',
        format('AirFlow IQ: the HVAC filter for %s is due for replacement (installed %s days ago, %s-day interval). Please contact your property manager.',
               coalesce(r.name, r.hvac_location, 'your unit'), r.days_since, r.interval_days));
    end if;

    update devices set tenant_notified_installed_at = r.installed_at where id = r.id;
    v_count := v_count + 1;
  end loop;

  -- B. Overdue escalation: one notice a day on days 1-5 after the due date.
  for r in
    select d.id,
           coalesce(d.name, d.hvac_location, 'your HVAC unit') as device_name,
           d.hvac_location, p.name as property_name, d.tenant_emails,
           c.installed_at, c.due_on, c.days_past_due,
           coalesce(pr.interactive_landlord_acks, false) as acks_on,
           public.landlord_email_for_device(d.id) as landlord
    from devices d
    join public.device_filter_cycles() c on c.device_id = d.id
    left join properties p on p.id = d.property_id
    left join profiles pr on pr.id = d.owner_id
    where c.days_past_due between 1 and 5
      and not exists (
        select 1 from filter_overdue_notices n
        where n.device_id = d.id
          and n.cycle_installed_at = c.installed_at
          and n.day_number = c.days_past_due)
  loop
    v_recipients := '{}';

    foreach v_email in array r.tenant_emails loop
      -- A tenant who is also the landlord gets the landlord copy only.
      if v_email is distinct from r.landlord then
        perform enqueue_email_to_address(
          v_email, 'filter_overdue',
          format('Overdue HVAC filter: reminder %s of 5', r.days_past_due),
          jsonb_build_object(
            'device_name', r.device_name, 'hvac_location', r.hvac_location,
            'property_name', r.property_name, 'due_on', r.due_on,
            'day_number', r.days_past_due, 'days_total', 5,
            'recipient_role', 'tenant'));
        v_recipients := v_recipients || v_email;
      end if;
    end loop;

    if r.landlord is not null then
      v_token := case when r.acks_on
                      then public.issue_filter_ack_token(r.id, r.landlord, r.installed_at)
                 end;
      perform enqueue_email_to_address(
        r.landlord, 'filter_overdue',
        format('Overdue HVAC filter: reminder %s of 5', r.days_past_due),
        jsonb_build_object(
          'device_name', r.device_name, 'hvac_location', r.hvac_location,
          'property_name', r.property_name, 'due_on', r.due_on,
          'day_number', r.days_past_due, 'days_total', 5,
          'recipient_role', 'landlord',
          'ack_url', case when v_token is not null
                          then public.app_base_url() || '/ack?token=' || v_token end));
      v_recipients := v_recipients || r.landlord;
    end if;

    insert into filter_overdue_notices (device_id, cycle_installed_at, day_number, sent_on, recipients)
    values (r.id, r.installed_at, r.days_past_due,
            (now() at time zone 'America/Chicago')::date, v_recipients);
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

-- 12. Dry run ------------------------------------------------------------------
-- What the next escalation run would send, with no side effects. For checking
-- before and after changes; not exposed to app users.
create or replace function public.preview_overdue_notifications()
returns table (device_name text, day_number int, due_on date,
               tenants text[], landlord text, ack_link boolean)
language sql stable security definer set search_path = public as $$
  select coalesce(d.name, d.hvac_location), c.days_past_due, c.due_on,
         d.tenant_emails, public.landlord_email_for_device(d.id),
         coalesce(pr.interactive_landlord_acks, false)
  from devices d
  join public.device_filter_cycles() c on c.device_id = d.id
  left join profiles pr on pr.id = d.owner_id
  where c.days_past_due between 1 and 5
    and not exists (
      select 1 from filter_overdue_notices n
      where n.device_id = d.id
        and n.cycle_installed_at = c.installed_at
        and n.day_number = c.days_past_due)
  order by 1;
$$;
revoke all on function public.preview_overdue_notifications() from public, anon, authenticated;
