-- AirFlow IQ SaaS additions — works WITH the existing store schema
-- (products / orders / order_items / invoices / shipments stay as they are).
-- Adds: subscriptions table, a Stripe session column on orders, device limits.
-- Run in the Supabase SQL editor, or: supabase db push

-- ── Subscriptions (one row per user, synced from Stripe by webhook) ─────────
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  plan text not null default 'pro',
  status text not null default 'incomplete',  -- Stripe status verbatim
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

-- Users read their own subscription; writes happen only through Edge
-- Functions using the service role (which bypasses RLS).
drop policy if exists "subscription readable by owner" on public.subscriptions;
create policy "subscription readable by owner"
  on public.subscriptions for select
  to authenticated
  using (auth.uid() = user_id);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ── Stripe linkage on existing orders table (additive, nullable) ────────────
alter table public.orders
  add column if not exists stripe_checkout_session_id text;

create unique index if not exists orders_stripe_checkout_session_id_idx
  on public.orders (stripe_checkout_session_id);

-- ── Device configuration limits (matches the app: filter ≤ 30 days, wake ≥ 10 min)
alter table public.devices
  alter column filter_interval_days set default 30,
  alter column wake_interval_seconds set default 600;

-- Bring any existing rows into range before adding constraints
update public.devices set filter_interval_days = 30
  where filter_interval_days is not null and filter_interval_days > 30;
update public.devices set wake_interval_seconds = 600
  where wake_interval_seconds is not null and wake_interval_seconds < 600;

alter table public.devices drop constraint if exists devices_filter_interval_days_range;
alter table public.devices add constraint devices_filter_interval_days_range
  check (filter_interval_days is null or (filter_interval_days between 1 and 30));

alter table public.devices drop constraint if exists devices_wake_interval_seconds_range;
alter table public.devices add constraint devices_wake_interval_seconds_range
  check (wake_interval_seconds is null or (wake_interval_seconds between 600 and 86400));

-- ── Seed catalog ONLY if the products table is empty (edit to taste) ────────
insert into public.products (sku, name, description, product_type, price_cents, currency)
select * from (values
  ('AFIQ-SENSOR',      'AirFlow IQ Sensor',        'HVAC filter monitor with RFID filter detection, temperature, humidity, pressure and airflow sensors.', 'physical', 7900::bigint,  'USD'),
  ('AFIQ-SENSOR-3PK',  'AirFlow IQ Sensor 3-Pack', 'Three sensors for multi-unit properties. Best value for landlords.',                                   'physical', 19900::bigint, 'USD'),
  ('AFIQ-RFID-TAGS10', 'Replacement RFID Filter Tags (10)', 'Adhesive RFID tags to attach to standard HVAC filters.',                                      'physical', 1900::bigint,  'USD')
) as seed(sku, name, description, product_type, price_cents, currency)
where not exists (select 1 from public.products);
