import { useState } from "react";
import Icon from "../components/Icon";
import { supabase } from "../lib/supabase";
import { useAuth } from "../context/AuthContext";

// modes: login | signup | verify | forgot | forgot_verify | forgot_newpass
const SUBTITLES = {
  login: "Sign in to your dashboard",
  signup: "Create your account",
  verify: "Check your email for an 8-digit code",
  forgot: "Reset your password",
  forgot_verify: "Check your email for an 8-digit code",
  forgot_newpass: "Set a new password",
};

const PRIMARY_LABELS = {
  login: "Log In",
  signup: "Create Account",
  verify: "Confirm Email",
  forgot: "Send Code",
  forgot_verify: "Verify Code",
  forgot_newpass: "Update Password",
};

const FEATURES = [
  { icon: "chart",    text: "Live temperature, humidity, pressure and airflow" },
  { icon: "waveform", text: "Acoustic filter analysis with ML classification" },
  { icon: "building", text: "Manage every property from one dashboard" },
];

export default function Login() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const reset = (next) => {
    setMode(next); setError(null); setNotice(null); setOtp(""); setNewPassword("");
  };

  const handleLogin = async () => {
    if (!email || !password) return setError("Please enter email and password");
    const { error } = await signIn(email, password);
    if (error) setError(error.message);
  };

  const handleSignUp = async () => {
    if (!email || !password) return setError("Please enter email and password");
    if (password.length < 6) return setError("Password must be at least 6 characters");
    const { error } = await signUp(email, password);
    if (error) return setError(error.message);
    setMode("verify");
    setNotice(`We sent an 8-digit code to ${email}`);
  };

  const handleVerifyOtp = async () => {
    if (otp.length !== 8) return setError("Please enter the 8-digit code from your email");
    const { error } = await supabase.auth.verifyOtp({ email, token: otp, type: "signup" });
    if (error) setError(error.message);
    // On success AuthContext's onAuthStateChange swaps in the app shell.
  };

  const handleForgotSend = async () => {
    if (!email) return setError("Please enter your email address first");
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    if (error) return setError(error.message);
    setOtp("");
    setMode("forgot_verify");
    setNotice(`We sent an 8-digit code to ${email}`);
  };

  const handleForgotVerify = async () => {
    if (otp.length !== 8) return setError("Please enter the 8-digit code from your email");
    const { error } = await supabase.auth.verifyOtp({ email, token: otp, type: "recovery" });
    if (error) return setError(error.message);
    setOtp(""); setNewPassword(""); setMode("forgot_newpass"); setNotice(null);
  };

  const handleForgotNewPass = async () => {
    if (newPassword.length < 6) return setError("Password must be at least 6 characters");
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) return setError(error.message);
    setNotice("Password updated — signing you in…");
  };

  const ACTIONS = {
    login: handleLogin,
    signup: handleSignUp,
    verify: handleVerifyOtp,
    forgot: handleForgotSend,
    forgot_verify: handleForgotVerify,
    forgot_newpass: handleForgotNewPass,
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setNotice(null);
    setLoading(true);
    try { await ACTIONS[mode](); }
    catch (err) { setError(err?.message || "Something went wrong"); }
    setLoading(false);
  };

  const handleResend = async () => {
    setLoading(true); setError(null);
    if (mode === "verify") await supabase.auth.resend({ type: "signup", email });
    else await supabase.auth.resetPasswordForEmail(email);
    setLoading(false);
    setNotice(`A new code was sent to ${email}`);
  };

  const isOtpStep = mode === "verify" || mode === "forgot_verify";

  return (
    <div className="auth-wrap">
      <aside className="auth-aside">
        <div className="row" style={{ gap: 12 }}>
          <div className="sidebar-logo" style={{ width: 44, height: 44, borderRadius: 14, background: "rgba(255,255,255,0.22)" }}>
            <Icon name="wind" size={23} />
          </div>
          <div style={{ fontSize: 19, fontWeight: 800 }}>AirFlow IQ</div>
        </div>

        <h2>Every filter, every property, one screen.</h2>
        <p>
          Monitor HVAC health across your whole portfolio — sensor trends, filter
          life predictions and acoustic diagnostics, in real time.
        </p>

        <div className="col" style={{ gap: 14, marginTop: 8 }}>
          {FEATURES.map((f) => (
            <div className="auth-feature" key={f.text}>
              <div className="auth-feature-icon"><Icon name={f.icon} size={17} /></div>
              <span>{f.text}</span>
            </div>
          ))}
        </div>
      </aside>

      <section className="auth-panel">
        <form className="auth-form" onSubmit={submit}>
          <div>
            <h1 style={{ fontSize: 27, fontWeight: 900 }}>
              {mode === "signup" ? "Create account" : "Welcome back"}
            </h1>
            <p className="hint" style={{ marginTop: 5, fontSize: 13.5 }}>{SUBTITLES[mode]}</p>
          </div>

          {error && <div className="auth-error">{error}</div>}
          {notice && !error && <div className="auth-ok">{notice}</div>}

          {!isOtpStep && mode !== "forgot_newpass" && (
            <div className="field">
              <label className="field-label">Email</label>
              <input
                className="input" type="email" value={email} autoComplete="email"
                placeholder="you@example.com" autoFocus
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          )}

          {(mode === "login" || mode === "signup") && (
            <div className="field">
              <label className="field-label">Password</label>
              <input
                className="input" type="password" value={password}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                placeholder={mode === "signup" ? "At least 6 characters" : "••••••••"}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}

          {isOtpStep && (
            <div className="field">
              <label className="field-label">8-digit code</label>
              <input
                className="input mono" value={otp} inputMode="numeric" maxLength={8} autoFocus
                placeholder="00000000"
                style={{ fontSize: 21, letterSpacing: 7, textAlign: "center", fontWeight: 700 }}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 8))}
              />
              <button type="button" className="link-btn" style={{ alignSelf: "flex-start", marginTop: 2 }} onClick={handleResend}>
                Didn't get it? Resend code
              </button>
            </div>
          )}

          {mode === "forgot_newpass" && (
            <div className="field">
              <label className="field-label">New password</label>
              <input
                className="input" type="password" value={newPassword} autoFocus
                autoComplete="new-password" placeholder="At least 6 characters"
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
          )}

          <button className="btn btn-primary btn-block" type="submit" disabled={loading} style={{ padding: "12px 15px", marginTop: 2 }}>
            {loading ? <span className="spinner" /> : PRIMARY_LABELS[mode]}
          </button>

          <div className="row" style={{ justifyContent: "space-between", marginTop: 2 }}>
            {mode === "login" && (
              <>
                <button type="button" className="link-btn" onClick={() => reset("forgot")}>Forgot password?</button>
                <button type="button" className="link-btn" onClick={() => reset("signup")}>Create an account</button>
              </>
            )}
            {mode === "signup" && (
              <button type="button" className="link-btn" onClick={() => reset("login")}>
                Already have an account? Log in
              </button>
            )}
            {mode !== "login" && mode !== "signup" && (
              <button type="button" className="link-btn" onClick={() => reset("login")}>
                ← Back to log in
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
