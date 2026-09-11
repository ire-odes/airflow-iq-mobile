-- Explicit "notify landlord" address for accounts run by a surrogate.
--
-- Until now, when a property had no landlord_email, overdue notices went to the
-- account holder's own email on the assumption that the account holder IS the
-- landlord. That is false whenever the account is operated on the landlord's
-- behalf -- a property manager, a relative, a technician -- and in that case
-- the actual landlord never heard about an overdue filter at all.
--
-- Resolution for a device's designated landlord, most specific first:
--   1. properties.landlord_email          (that property's own landlord)
--   2. profiles.notify_landlord_email     (the account's landlord, all properties)
--   3. the account holder's email         (no surrogate: holder is the landlord)
--
-- When the designated landlord differs from the account holder, BOTH receive
-- the overdue notice: the landlord because it's their property, the holder
-- because they're the one running it day to day. Each copy says who else was
-- told, and each carries its own one-time acknowledgement link when
-- Interactive Landlord Acknowledgements is on.

alter table public.profiles add column if not exists notify_landlord_email text;
alter table public.profiles drop constraint if exists profiles_notify_landlord_email_format;
alter table public.profiles
  add constraint profiles_notify_landlord_email_format
  check (notify_landlord_email is null
         or notify_landlord_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');
grant update (notify_landlord_email) on public.profiles to authenticated;

comment on column public.profiles.notify_landlord_email is
  'Explicit landlord address for accounts operated on a landlord''s behalf. '
  'Overdue notices go to it as well as to the account holder. A property''s '
  'own landlord_email takes priority for that property.';

-- Designated landlord (single address).
create or replace function public.landlord_email_for_device(p_device_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select lower(coalesce(nullif(trim(p.landlord_email), ''),
                        nullif(trim(pr.notify_landlord_email), ''),
                        u.email))
  from devices d
  left join properties p on p.id = d.property_id
  left join profiles pr on pr.id = d.owner_id
  left join auth.users u on u.id = d.owner_id
  where d.id = p_device_id;
$$;
revoke all on function public.landlord_email_for_device(uuid) from public, anon, authenticated;

-- The account holder, who gets a copy when they aren't the designated landlord.
create or replace function public.account_holder_email_for_device(p_device_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select lower(u.email)
  from devices d join auth.users u on u.id = d.owner_id
  where d.id = p_device_id;
$$;
revoke all on function public.account_holder_email_for_device(uuid) from public, anon, authenticated;

-- The daily job, with the surrogate copy added to part B. Part A (due-day
-- tenant reminder) is unchanged from 20260911020000.
create or replace function public.check_tenant_filter_notifications()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_count int := 0;
  r record;
  v_email text;
  v_token text;
  v_recipients text[];
  v_base jsonb;
begin
  -- A. Due-day reminder to every tenant address.
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
           public.landlord_email_for_device(d.id) as landlord,
           public.account_holder_email_for_device(d.id) as holder
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
    v_base := jsonb_build_object(
      'device_name', r.device_name, 'hvac_location', r.hvac_location,
      'property_name', r.property_name, 'due_on', r.due_on,
      'day_number', r.days_past_due, 'days_total', 5);

    -- Tenants. Anyone who is also the landlord or the holder gets that copy only.
    foreach v_email in array r.tenant_emails loop
      if v_email is distinct from r.landlord and v_email is distinct from r.holder then
        perform enqueue_email_to_address(
          v_email, 'filter_overdue',
          format('Overdue HVAC filter: reminder %s of 5', r.days_past_due),
          v_base || jsonb_build_object('recipient_role', 'tenant'));
        v_recipients := v_recipients || v_email;
      end if;
    end loop;

    -- Designated landlord. Told who manages the account when that's someone else.
    if r.landlord is not null then
      v_token := case when r.acks_on
                      then public.issue_filter_ack_token(r.id, r.landlord, r.installed_at) end;
      perform enqueue_email_to_address(
        r.landlord, 'filter_overdue',
        format('Overdue HVAC filter: reminder %s of 5', r.days_past_due),
        v_base || jsonb_build_object(
          'recipient_role', 'landlord',
          'managed_by', case when r.holder is distinct from r.landlord then r.holder end,
          'ack_url', case when v_token is not null
                          then public.app_base_url() || '/ack?token=' || v_token end));
      v_recipients := v_recipients || r.landlord;
    end if;

    -- Surrogate account holder: a copy, saying the landlord was notified too.
    if r.holder is not null and r.holder is distinct from r.landlord then
      v_token := case when r.acks_on
                      then public.issue_filter_ack_token(r.id, r.holder, r.installed_at) end;
      perform enqueue_email_to_address(
        r.holder, 'filter_overdue',
        format('Overdue HVAC filter: reminder %s of 5', r.days_past_due),
        v_base || jsonb_build_object(
          'recipient_role', 'account_holder',
          'landlord_email', r.landlord,
          'ack_url', case when v_token is not null
                          then public.app_base_url() || '/ack?token=' || v_token end));
      v_recipients := v_recipients || r.holder;
    end if;

    insert into filter_overdue_notices (device_id, cycle_installed_at, day_number, sent_on, recipients)
    values (r.id, r.installed_at, r.days_past_due,
            (now() at time zone 'America/Chicago')::date, v_recipients);
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

-- Dry run, now showing the surrogate copy. Return type changes, so drop first.
drop function if exists public.preview_overdue_notifications();
create function public.preview_overdue_notifications()
returns table (device_name text, day_number int, due_on date,
               tenants text[], landlord text, account_holder_copy text, ack_link boolean)
language sql stable security definer set search_path = public as $$
  select coalesce(d.name, d.hvac_location), c.days_past_due, c.due_on,
         d.tenant_emails,
         public.landlord_email_for_device(d.id),
         nullif(public.account_holder_email_for_device(d.id),
                public.landlord_email_for_device(d.id)),
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
