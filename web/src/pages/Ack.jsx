import { useEffect, useRef, useState } from "react";
import Icon from "../components/Icon";
import { supabase } from "../lib/supabase";

// ============================================================================
// Landing page for the "I've changed this filter" link in overdue-filter
// emails (Interactive Landlord Acknowledgements, Account settings).
//
// Works signed in or signed out: landlords click it from their inbox, often
// on a phone with no session, so authority comes from the one-time token in
// the URL -- checked and consumed server-side -- never from who is logged in.
//
// Loading the page only DESCRIBES the token. Recording the acknowledgement
// takes a button press, because mail security scanners routinely open links
// in emails; if a page load counted, a scanner could mark a filter changed
// that nobody touched.
// ============================================================================

const STATES = {
  ready:        { icon: "wrench",  color: "#007BFF", title: "Confirm filter change" },
  acknowledged: { icon: "success", color: "#22c55e", title: "Filter change recorded" },
  test:         { icon: "success", color: "#22c55e", title: "Test link works" },
  used:         { icon: "check",   color: "#6b7280", title: "Already recorded" },
  superseded:   { icon: "check",   color: "#6b7280", title: "Already replaced" },
  expired:      { icon: "clock",   color: "#f59e0b", title: "Link expired" },
  disabled:     { icon: "lock",    color: "#f59e0b", title: "Acknowledgements are turned off" },
  invalid:      { icon: "alert",   color: "#ef4444", title: "Link not recognised" },
  error:        { icon: "alert",   color: "#ef4444", title: "Something went wrong" },
};

function body(status, info) {
  const name = info?.device_name || "this unit";
  switch (status) {
    case "ready":
      return info?.is_test
        ? "This is a test link. Pressing the button checks that it works and records nothing."
        : `Confirm that the HVAC filter for ${name} has been replaced. This stops the overdue reminders and restarts its filter life.`;
    case "acknowledged":
      return `Thanks — ${name} is marked as changed. Overdue reminders have stopped and its filter life has restarted.`;
    case "test":
      return "The acknowledgement link works. This was a test, so nothing was recorded.";
    case "used":
      return "This link has already been used, so the change is on record. There's nothing more to do.";
    case "superseded":
      return `A new filter has already been detected for ${name}, so no acknowledgement is needed.`;
    case "expired":
      return "Acknowledgement links last 14 days. Sign in to AirFlow IQ to mark the filter as changed from the Devices page.";
    case "disabled":
      return "The account owner has turned off interactive acknowledgements. Sign in to AirFlow IQ to manage this filter.";
    case "invalid":
      return "It may be incomplete — try opening it again straight from the email.";
    default:
      return "Please try again in a moment.";
  }
}

export default function Ack() {
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const [status, setStatus] = useState(token ? "loading" : "invalid");
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  // StrictMode runs effects twice in development; the describe call is
  // harmless to repeat, but there's no reason to make it twice.
  const described = useRef(false);

  useEffect(() => {
    if (!token || described.current) return;
    described.current = true;
    supabase.rpc("describe_filter_ack_token", { p_token: token }).then(({ data, error }) => {
      if (error) { setStatus("error"); return; }
      setInfo(data);
      setStatus(data?.status || "invalid");
    });
  }, [token]);

  const confirm = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc("acknowledge_filter_change_by_token", { p_token: token });
    setBusy(false);
    if (error) { setStatus("error"); return; }
    setInfo((i) => ({ ...i, ...data }));
    setStatus(data?.status || "error");
  };

  const s = STATES[status] || STATES.error;
  const where = [info?.hvac_location, info?.property_name].filter(Boolean).join(" · ");

  return (
    <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 20, background: "var(--bg)" }}>
      <div className="card" style={{ width: "100%", maxWidth: 440, padding: 28, textAlign: "center" }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: "#007BFF", marginBottom: 20 }}>AirFlow IQ</div>

        {status === "loading" ? (
          <div className="spinner" style={{ width: 26, height: 26, color: "var(--accent)", margin: "12px auto" }} />
        ) : (
          <>
            <div style={{
              width: 56, height: 56, borderRadius: 18, margin: "0 auto 14px",
              display: "grid", placeItems: "center",
              background: `${s.color}1f`, color: s.color,
            }}>
              <Icon name={s.icon} size={26} />
            </div>
            <h1 style={{ fontSize: 21, fontWeight: 800, marginBottom: 8 }}>{s.title}</h1>
            {info?.device_name && status !== "invalid" && (
              <div className="hint" style={{ marginBottom: 10, fontWeight: 600 }}>
                {info.device_name}{where ? ` · ${where}` : ""}
              </div>
            )}
            <p className="hint" style={{ fontSize: 14, lineHeight: 1.55, marginBottom: 22 }}>
              {body(status, info)}
            </p>

            {status === "ready" ? (
              <button className="btn btn-primary btn-block" onClick={confirm} disabled={busy}
                style={{ padding: "13px 16px", fontSize: 15 }}>
                {busy ? <span className="spinner" /> : info?.is_test ? "Test the link" : "Yes, the filter has been changed"}
              </button>
            ) : (
              <a className="btn btn-block" href="/" style={{ padding: "12px 16px" }}>Open AirFlow IQ</a>
            )}
          </>
        )}
      </div>
    </div>
  );
}
