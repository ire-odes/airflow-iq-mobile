# AirFlow IQ — Production Setup Checklist

Everything in the app is wired and ready. These are the one-time steps only you
can do (they need your Stripe account and Supabase admin access).

## 1. Database migration

Open the Supabase dashboard → SQL Editor and run
[supabase/migrations/20260713000000_orders_and_subscriptions.sql](supabase/migrations/20260713000000_orders_and_subscriptions.sql).

The migration works **with** the existing store/fulfillment schema (products,
orders, order_items, invoices, packing_slips, shipments and the `v_my_*`
views) — it does not touch those tables except adding one nullable
`stripe_checkout_session_id` column to `orders`. It creates the new
`subscriptions` table (with RLS), enforces the device limits at the database
level (filter interval 1–30 days, wake interval 600–86400 seconds — existing
out-of-range rows are clamped), and seeds three catalog products **only if
`products` is empty**.

How Stripe plugs into your pipeline: `create-checkout` inserts a `draft`
order (your triggers compute line/order totals), and after payment the
webhook flips it to `submitted` — which fires your invoice-creation and email
triggers — then marks the new invoice `paid`. Abandoned checkouts
(`checkout.session.expired`) delete the leftover draft. Two assumptions worth
double-checking against your trigger functions: the invoice trigger fires on
`status = 'submitted'`, and invoices use `status = 'paid'` + `paid_at`.

## 2. Stripe account

1. Grab your **secret key** from https://dashboard.stripe.com/apikeys (use test
   mode keys first).
2. Create a **Product** for the Pro plan with a recurring monthly price
   (the app displays it as $9.99/mo — adjust `SUBSCRIPTION_PLANS` in
   [lib/billing.js](lib/billing.js) if you pick a different price). Copy the
   price id (`price_...`).

## 3. Deploy the Edge Functions

With the [Supabase CLI](https://supabase.com/docs/guides/cli) logged in and
linked to your project (`supabase link --project-ref hniplnaohvcbtmelatnz`):

```sh
supabase secrets set STRIPE_SECRET_KEY=sk_test_...
supabase secrets set STRIPE_PRO_PRICE_ID=price_...

supabase functions deploy create-checkout
supabase functions deploy create-subscription-checkout
supabase functions deploy customer-portal
supabase functions deploy billing-return --no-verify-jwt
supabase functions deploy stripe-webhook --no-verify-jwt
```

(`--no-verify-jwt` is required on the last two: Stripe and the browser call
them without a Supabase session. The webhook authenticates via its Stripe
signature instead.)

## 4. Stripe webhook

In https://dashboard.stripe.com/webhooks add an endpoint:

- URL: `https://hniplnaohvcbtmelatnz.supabase.co/functions/v1/stripe-webhook`
- Events: `checkout.session.completed`, `checkout.session.expired`,
  `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`

Copy the signing secret and set it:

```sh
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
```

## 5. App environment (optional but recommended)

Copy `.env.example` to `.env` and fill it in. The Supabase URL/anon key
currently have in-code fallbacks so nothing breaks, but env vars are the way
forward. Setting `EXPO_PUBLIC_GEMINI_API_KEY` turns the dashboard AI Insight
card back on (it is hidden while unset — it used to fail silently with the
placeholder key).

## 6. Test the flow (Stripe test mode)

1. Start the app, sign in, open the new **Orders** tab — your product catalog
   should appear once the migration is run.
2. Add an item → **Checkout with Stripe** → pay with card `4242 4242 4242 4242`,
   any future expiry/CVC. After the browser closes, the order should show
   **Paid**, and an invoice should appear in your fulfillment pipeline
   (check `v_admin_fulfillment_queue`). Once you create a shipment with a
   tracking number, the app shows **Shipped** with the tracking number.
3. In **Account → Subscription**, tap **Upgrade to Pro**, pay with the test
   card, and confirm the section flips to PRO with the renewal date.
4. Tap **Manage Billing** and cancel — the section should show "Ends <date>".

## Email (Resend, from support@airfloiq.com)

Two paths, both needing the Resend API key:

1. **Pipeline emails** (order submitted / invoice paid / shipment updates):
   queued by DB triggers into `email_outbox`, drained every minute by the
   `send-emails` edge function via a pg_cron job (`process-email-outbox`).
   Needs Supabase secret `RESEND_API_KEY` (optionally `EMAIL_FROM`, default
   `AirFlow IQ <support@airfloiq.com>`). Failed sends get `status='failed'`
   with the reason in the `error` column; requeue with
   `update email_outbox set status='queued' where status='failed'`.
2. **Auth codes** (signup/reset OTPs): Supabase dashboard →
   Project Settings → Authentication → **SMTP Settings** → enable custom SMTP:
   host `smtp.resend.com`, port `465`, username `resend`, password = the
   Resend API key, sender `support@airfloiq.com`. Then raise the email rate
   limit under Authentication → Rate Limits (the default 2/hour only applies
   to Supabase's built-in mailer).

## What changed in the app (no action needed)

- New **Orders** tab: catalog, cart, Stripe Checkout, order history.
- **Account → Subscription**: Free/Pro plan display, upgrade, billing portal.
- Filter change interval is now capped at **30 days** (presets 7/14/21/30);
  wake interval minimum is **10 minutes** (presets 10m–6h). Legacy values are
  clamped when the edit form opens and rejected on save.
- Silent failures cleaned up: every Supabase query now surfaces or logs its
  error, the Devices load failure alert includes the reason, a crash-in-waiting
  missing `Alert` import on the dashboard was fixed, debug `console.log`s were
  removed, and the theme choice now persists across restarts (and defaults to
  the system scheme).
- Filter-due notifications are now per device and use each device's own
  configured interval instead of a hardcoded 90 days.
- Secrets/config moved to [lib/config.js](lib/config.js) + `.env` support;
  `.env` is gitignored.
