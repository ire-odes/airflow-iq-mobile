-- Applied 2026-07-15 (via MCP). Allow the 'sending' claim state used by the
-- send-emails worker (original constraint only allowed queued/sent/failed).
alter table public.email_outbox drop constraint email_outbox_status_check;
alter table public.email_outbox add constraint email_outbox_status_check
  check (status = any (array['queued'::text, 'sending'::text, 'sent'::text, 'failed'::text]));
