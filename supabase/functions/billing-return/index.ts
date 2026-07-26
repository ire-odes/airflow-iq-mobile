// Stripe redirect target. Stripe requires https success/cancel URLs, so this
// tiny page bounces the user back into the app via its deep link.
// Deploy with: supabase functions deploy billing-return --no-verify-jwt
const APP_SCHEME = "airflowiq://billing-return";

Deno.serve((req) => {
  const status = new URL(req.url).searchParams.get("status") ?? "done";
  const target = `${APP_SCHEME}?status=${encodeURIComponent(status)}`;
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AirFlow IQ</title>
    <meta http-equiv="refresh" content="0;url=${target}" />
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; display: flex; flex-direction: column;
             align-items: center; justify-content: center; min-height: 100vh; margin: 0; gap: 16px; }
      a { background: #007BFF; color: #fff; text-decoration: none; padding: 14px 28px;
          border-radius: 12px; font-weight: 700; }
    </style>
  </head>
  <body>
    <p>${status === "cancel" ? "Checkout canceled." : "Payment step complete."} Returning to AirFlow IQ…</p>
    <a href="${target}">Open AirFlow IQ</a>
    <script>location.href = ${JSON.stringify(target)};</script>
  </body>
</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
});
