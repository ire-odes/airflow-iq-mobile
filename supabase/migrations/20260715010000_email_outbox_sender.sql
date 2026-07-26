-- Applied 2026-07-15 (via MCP). Email outbox sender: pg_cron invokes the
-- send-emails edge function every minute; the function claims rows atomically
-- and sends them via Resend.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Track when a row was claimed so crashed runs can be retried safely
alter table public.email_outbox
  add column if not exists claimed_at timestamptz;

-- Atomically claim queued emails (plus stale 'sending' rows from crashed
-- runs, after 15 minutes). SECURITY DEFINER + service_role-only.
create or replace function public.claim_queued_emails(p_limit int default 25)
returns setof public.email_outbox
language sql
security definer
set search_path = public
as $$
  update public.email_outbox
  set status = 'sending', claimed_at = now()
  where id in (
    select id from public.email_outbox
    where status = 'queued'
       or (status = 'sending' and claimed_at < now() - interval '15 minutes')
    order by created_at
    limit p_limit
    for update skip locked
  )
  returning *;
$$;

revoke execute on function public.claim_queued_emails(int) from public, anon, authenticated;
grant execute on function public.claim_queued_emails(int) to service_role;

-- Schedule the drain. The anon key below is the public client key (already
-- shipped inside the mobile app) — it only gets the request past the JWT
-- gateway; the function itself uses the service role internally.
-- NOTE: if the project's anon key is ever rotated, re-run this schedule.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'process-email-outbox') then
    perform cron.unschedule('process-email-outbox');
  end if;
end $$;

select cron.schedule(
  'process-email-outbox',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://hniplnaohvcbtmelatnz.supabase.co/functions/v1/send-emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuaXBsbmFvaHZjYnRtZWxhdG56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1Nzk0MjAsImV4cCI6MjA4MDE1NTQyMH0.g7sgeZBW0RKkMI1lryA96Sym6cnejUAcmIx_npGr1Ko'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
