-- Admin access and per-device wake-interval exceptions.

-- 1. Close self-service admin escalation ------------------------------------
-- profiles carried a table-level UPDATE grant to anon and authenticated, and
-- its update policy only checks that the row is your own. Together that let
-- ANY signed-in user run
--     PATCH /rest/v1/profiles?id=eq.<self>   {"is_admin": true}
-- and gain every admin power the database grants: all orders, invoices,
-- shipments, products, and the email outbox (every customer address, and the
-- ability to queue mail as AirFlow IQ).
--
-- The only column any client legitimately writes is full_name -- the web and
-- Expo Account pages. delete-account also writes it, via the service role,
-- which these grants don't affect. interactive_landlord_acks is added and
-- granted in 20260911010000.
revoke update on public.profiles from anon, authenticated;
grant update (full_name) on public.profiles to authenticated;

-- 2. Full admin for kannan@airfloiq.com ---------------------------------------
-- "Admin" in this system is profiles.is_admin, checked by is_admin() and
-- assert_is_admin() and by the "Admins manage ..." policies.
update public.profiles p
   set is_admin = true
  from auth.users u
 where u.id = p.id
   and lower(u.email) = 'kannan@airfloiq.com';

-- 3. Wake interval: 4 hours by default, admin-set exceptions -----------------
-- 20260910000000 fixed every device at exactly 14400 with a CHECK constraint.
-- That also blocked the legitimate case: AirFlow IQ choosing a different
-- cadence for a particular unit. The rule that matters is "consumers can't
-- change it", which is about WHO writes, and a CHECK can't see who is writing.
-- A trigger can.
alter table public.devices drop constraint if exists devices_wake_interval_fixed;
-- devices_wake_interval_seconds_range (600 .. 86400) remains in force.

create or replace function public.guard_wake_interval()
returns trigger language plpgsql set search_path = public as $$
begin
  -- App users (anon / authenticated JWTs) who aren't admins. The service role
  -- and direct SQL carry no such role and pass through.
  if coalesce(auth.role(), '') in ('authenticated', 'anon') and not public.is_admin() then
    if tg_op = 'INSERT' and new.wake_interval_seconds is distinct from 14400 then
      raise exception 'Wake interval is set by AirFlow IQ' using errcode = '42501';
    elsif tg_op = 'UPDATE'
          and new.wake_interval_seconds is distinct from old.wake_interval_seconds then
      raise exception 'Wake interval is set by AirFlow IQ and cannot be changed from the app'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_wake_interval on public.devices;
create trigger trg_guard_wake_interval
  before insert or update of wake_interval_seconds on public.devices
  for each row execute function public.guard_wake_interval();

comment on column public.devices.wake_interval_seconds is
  'Seconds between device wakes. 14400 (4h) by default; only admins or the '
  'service can set anything else (trigger trg_guard_wake_interval, migration '
  '20260911000000). Calibration still samples at 60s via effective_wake_seconds.';

-- 4. Exceptions -----------------------------------------------------------------
-- By MAC: device names aren't unique ("P5 (offline spare)" also exists).
update public.devices set wake_interval_seconds = 28800  -- every 8 hours
 where device_mac = 'E4B3238E6B10';                      -- P5
update public.devices set wake_interval_seconds = 86400  -- once a day
 where device_mac = 'E4B3238E5DF8';                      -- P2
