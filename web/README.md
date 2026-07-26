# AirFlow IQ — Desktop Web

Desktop companion to the Expo mobile app. Separate Vite + React codebase, but
it talks to the **same Supabase project**, so accounts, devices and sensor data
are shared — sign in with the same credentials.

## Running it

```bash
cd web
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # production bundle -> web/dist
npm run preview  # serve the built bundle
```

Supabase credentials default to the same hardcoded project the mobile app uses.
To point elsewhere, create `web/.env`:

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

## Required migration

The property hierarchy needs a table that doesn't exist yet. Run
[`../supabase/migrations/20260725000000_properties.sql`](../supabase/migrations/20260725000000_properties.sql)
once in **Supabase Dashboard → SQL Editor**.

It adds a `properties` table, a `devices.property_id` column, and RLS policies
(owners manage their own; assigned technicians get read access).

Until it's run the app still works — every device just falls into a single
"Unassigned" group and the Devices page shows a banner explaining why.

## What's here

| Page | Notes |
|---|---|
| **Login** | Full auth flow ported from mobile: sign in, sign up, 8-digit email OTP confirmation, password reset. |
| **Dashboard** | Trend chart (line for 24H, bars for 7D/30D), configurable metric cards, derived HVAC breakdown, filter lifecycle, and the Acoustic Data panel. |
| **Devices** | Devices grouped under properties. Property CRUD, device editing, claim-by-MAC. |
| **Account** | Profile, dark mode, duct area, alert thresholds, password change, technician team management. |

Scope is controlled by the **Property → Device picker** in the dashboard header:
pick "All properties" to aggregate the whole portfolio, a property to see just
that building, or drill into a single device.

## Acoustic Data — placeholder

> **The verdict and every spectral feature shown are mock data.**

Defined in [`src/lib/acoustic.js`](src/lib/acoustic.js). The intent is that an ML
model will eventually classify filter condition from a real recording.

What's real: the audio is synthesized in the browser with the Web Audio API, and
the waveform is computed from that buffer's actual samples — so playback,
pause, scrubbing and the seek playhead all genuinely work, and the three sample
clips audibly differ (a "clogged" clip carries noticeably more high-frequency
hiss than a "clean" one).

What's fake: the `Clean` / `Partially Restricted` / `Clogged` verdict, the
confidence score, and all eight features (spectral centroid, spectral rolloff,
low frequency energy ratio, spectral flatness, zero crossing rate, RMS energy,
spectral bandwidth, MFCC-1).

To wire up real data later, replace `getRecordings()` with a Supabase query and
point the player at the stored audio URL instead of the synthesized buffer.

## Relationship to the mobile app

Nothing in `web/` is imported by the Expo app and vice versa — the mobile app is
untouched. Shared *logic* (unit conversion, HVAC formulas, filter-life
inference, status thresholds) is duplicated in `src/lib/metrics.js`, ported 1:1
so both clients report identical numbers. If you change a formula in one, change
it in the other.

Platform differences: no camera QR scanning (claim devices by typing the MAC),
no push notifications (thresholds are stored but only the mobile app acts on
them), and session storage is `localStorage` rather than SecureStore.
