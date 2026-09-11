-- Stop the outbox cron jobs calling out when there is nothing to send.
--
-- process-email-outbox and process-sms-outbox both run every minute and fire
-- net.http_post at an Edge Function unconditionally. Measured on 2026-09-04:
--
--   net.http_post                          126,806 calls,  30.9M block touches
--   net._http_response cleanup DELETE      217,382 calls, 731.8M block touches,
--                                          13.6 HOURS of cumulative db time
--
-- 731 million block touches is by a wide margin the largest consumer on this
-- project and the direct cause of the Disk IO budget warning. The mechanism is
-- not the HTTP call itself: every call leaves a row in net._http_response,
-- pg_net's worker repeatedly DELETEs expired rows, and the constant
-- insert/delete churn had bloated that table to 117 MB holding 720 live rows.
-- Each cleanup pass then had to work through 117 MB of mostly dead space.
--
-- What makes it pure waste: email_outbox has had 4 rows in its entire history,
-- the most recent on 2026-08-14, and sms_outbox is empty. Roughly 2,880 calls
-- a day, essentially all of them finding nothing to do.
--
-- The anon key stays inline exactly as the jobs already had it. It is the
-- public anon key (it also ships in web/src/lib/config.js), and swapping it
-- for a current_setting() lookup that is not configured would resolve to an
-- empty bearer token and silently break sending the moment something IS
-- queued.
--
-- Gating on pending work rather than lengthening the interval, because that
-- costs no latency: something queued is still picked up within the minute,
-- while an idle outbox generates no traffic at all. Reducing the schedule to
-- every 5 minutes would cut the volume 5x but delay every real notification.

select cron.alter_job(
  job_id  := (select jobid from cron.job where jobname = 'process-email-outbox'),
  command := $job$
  select net.http_post(
    url := 'https://hniplnaohvcbtmelatnz.supabase.co/functions/v1/send-emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuaXBsbmFvaHZjYnRtZWxhdG56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1Nzk0MjAsImV4cCI6MjA4MDE1NTQyMH0.g7sgeZBW0RKkMI1lryA96Sym6cnejUAcmIx_npGr1Ko'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  where exists (
    select 1 from public.email_outbox
    where status is distinct from 'sent'
  );
  $job$
);

select cron.alter_job(
  job_id  := (select jobid from cron.job where jobname = 'process-sms-outbox'),
  command := $job$
  select net.http_post(
    url := 'https://hniplnaohvcbtmelatnz.supabase.co/functions/v1/send-sms',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuaXBsbmFvaHZjYnRtZWxhdG56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1Nzk0MjAsImV4cCI6MjA4MDE1NTQyMH0.g7sgeZBW0RKkMI1lryA96Sym6cnejUAcmIx_npGr1Ko'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  )
  where exists (
    select 1 from public.sms_outbox
    where status is distinct from 'sent'
  );
  $job$
);

-- Partial indexes so the new EXISTS check is a couple of block reads rather
-- than a scan of the outbox. Tiny: they only cover rows still awaiting send.
create index if not exists email_outbox_pending_idx
  on public.email_outbox (created_at)
  where status is distinct from 'sent';

create index if not exists sms_outbox_pending_idx
  on public.sms_outbox (created_at)
  where status is distinct from 'sent';
