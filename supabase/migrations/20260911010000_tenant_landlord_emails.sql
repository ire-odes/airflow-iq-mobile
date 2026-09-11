-- Multiple tenant emails per unit, one landlord email per property, and the
-- Interactive Landlord Acknowledgements account toggle.

-- 1. Tenant emails: a list per unit (device) -----------------------------------
alter table public.devices
  add column if not exists tenant_emails text[] not null default '{}';

update public.devices
   set tenant_emails = array[lower(trim(tenant_email))]
 where tenant_email is not null and trim(tenant_email) <> ''
   and cardinality(tenant_emails) = 0;

alter table public.devices drop constraint if exists devices_tenant_emails_max;
alter table public.devices
  add constraint devices_tenant_emails_max check (cardinality(tenant_emails) <= 10);

-- tenant_email (single) stays, derived from the list, because older writers
-- still use it: the Expo app reads and writes one address, and delete-account
-- clears it. Keeping it as "the first address" means those keep working
-- without every client having to change at once.
create or replace function public.sync_tenant_emails()
returns trigger language plpgsql set search_path = public as $$
declare
  v_email text;
  v_clean text[] := '{}';
begin
  -- A legacy writer changed the single address but not the list.
  if tg_op = 'UPDATE'
     and new.tenant_emails is not distinct from old.tenant_emails
     and new.tenant_email is distinct from old.tenant_email then
    if new.tenant_email is null or trim(new.tenant_email) = '' then
      -- Single-address clients turn notifications off by clearing the field.
      new.tenant_emails := '{}';
    else
      -- Swap the primary, keep any additional tenants set from the web app.
      new.tenant_emails := array[new.tenant_email]
        || array_remove(old.tenant_emails, lower(trim(coalesce(old.tenant_email, ''))));
    end if;
  elsif tg_op = 'INSERT' and cardinality(coalesce(new.tenant_emails, '{}')) = 0
        and new.tenant_email is not null then
    new.tenant_emails := array[new.tenant_email];
  end if;

  -- Normalise: trim, lower-case, drop blanks and duplicates, keep order.
  foreach v_email in array coalesce(new.tenant_emails, '{}') loop
    v_email := lower(trim(v_email));
    continue when v_email = '' or v_email = any(v_clean);
    if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'Invalid tenant email: %', v_email using errcode = '22023';
    end if;
    v_clean := v_clean || v_email;
  end loop;

  new.tenant_emails := v_clean;
  new.tenant_email := v_clean[1];      -- null when the list is empty
  return new;
end $$;

drop trigger if exists trg_sync_tenant_emails on public.devices;
create trigger trg_sync_tenant_emails
  before insert or update on public.devices
  for each row execute function public.sync_tenant_emails();

comment on column public.devices.tenant_emails is
  'Tenant addresses for this unit (max 10). tenant_email mirrors the first '
  'one for single-address clients; see trg_sync_tenant_emails.';

-- 2. Landlord email: one per property -------------------------------------------
-- Receives the daily overdue notices for every unit in the property. When
-- blank, notices go to the owner's account email (landlord_email_for_device).
alter table public.properties add column if not exists landlord_email text;
alter table public.properties drop constraint if exists properties_landlord_email_format;
alter table public.properties
  add constraint properties_landlord_email_format
  check (landlord_email is null or landlord_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

comment on column public.properties.landlord_email is
  'Designated landlord address for overdue-filter notices. Null = owner''s account email.';

-- 3. Account toggle ---------------------------------------------------------------
alter table public.profiles
  add column if not exists interactive_landlord_acks boolean not null default false;
grant update (interactive_landlord_acks) on public.profiles to authenticated;

comment on column public.profiles.interactive_landlord_acks is
  'Interactive Landlord Acknowledgements: overdue emails to the landlord carry '
  'a one-time "I''ve changed this filter" link, and device cards show a '
  '"Mark filter changed" button. Off by default.';
