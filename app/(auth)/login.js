import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, Alert, ActivityIndicator,
} from "react-native";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../context/AuthContext";

export default function LoginScreen() {
  const { signIn, signUp, resetPassword } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  // modes: "login" | "signup" | "verify" | "forgot" | "forgot_verify" | "forgot_newpass"
  const [mode, setMode] = useState("login");

  const handleLogin = async () => {
    if (!email || !password) { Alert.alert("Error", "Please enter email and password"); return; }
    setLoading(true);
    const { error } = await signIn(email, password);
    setLoading(false);
    if (error) Alert.alert("Error", error.message);
  };

  const handleSignUp = async () => {
  if (!email || !password) { Alert.alert("Error", "Please enter email and password"); return; }
  if (password.length < 6) { Alert.alert("Error", "Password must be at least 6 characters"); return; }
  setLoading(true);
  const { error } = await signUp(email, password);
  setLoading(false);
  if (error) { Alert.alert("Error", error.message); return; }
  setMode("verify");
};
  const handleVerifyOtp = async () => {
    if (otp.length !== 8) { Alert.alert("Error", "Please enter the 8-digit code from your email"); return; }
    setLoading(true);
    const { error } = await supabase.auth.verifyOtp({ email, token: otp, type: "signup" });
    setLoading(false);
    if (error) Alert.alert("Error", error.message);
    // on success AuthContext onAuthStateChange handles navigation
  };

  // Step 1: send OTP to email
  const handleForgotSend = async () => {
    if (!email) { Alert.alert("Error", "Please enter your email address first"); return; }
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email);
    setLoading(false);
    if (error) Alert.alert("Error", error.message);
    else { setOtp(""); setMode("forgot_verify"); }
  };

  // Step 2: verify OTP
  const handleForgotVerify = async () => {
    if (otp.length !== 8) { Alert.alert("Error", "Please enter the 8-digit code from your email"); return; }
    setLoading(true);
    const { error } = await supabase.auth.verifyOtp({ email, token: otp, type: "recovery" });
    setLoading(false);
    if (error) Alert.alert("Error", error.message);
    else { setOtp(""); setNewPassword(""); setMode("forgot_newpass"); }
  };

  const handleResend = async () => {
  setLoading(true);
  if (mode === "verify") {
    await supabase.auth.resend({ type: "signup", email });
  } else {
    await supabase.auth.resetPasswordForEmail(email);
  }
  setLoading(false);
  Alert.alert("Code resent", `A new code was sent to ${email}`);
};

  // Step 3: set new password
  const handleForgotNewPass = async () => {
    if (newPassword.length < 6) { Alert.alert("Error", "Password must be at least 6 characters"); return; }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setLoading(false);
    if (error) Alert.alert("Error", error.message);
    else Alert.alert("Success", "Password updated! You are now signed in.");
    // AuthContext picks up the session automatically
  };

  const goBackToLogin = () => { setMode("login"); setOtp(""); setNewPassword(""); };

  const subtitle = {
    login: "Sign in to your dashboard",
    signup: "Create your account",
    verify: "Check your email",
    forgot: "Reset your password",
    forgot_verify: "Check your email",
    forgot_newpass: "Set a new password",
  }[mode];

  const primaryLabel = {
    login: "Log In",
    signup: "Create Account",
    verify: "Confirm Email",
    forgot: "Send Code",
    forgot_verify: "Verify Code",
    forgot_newpass: "Update Password",
  }[mode];

  const primaryAction = {
    login: handleLogin,
    signup: handleSignUp,
    verify: handleVerifyOtp,
    forgot: handleForgotSend,
    forgot_verify: handleForgotVerify,
    forgot_newpass: handleForgotNewPass,
  }[mode];

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.appName}>AirFlow IQ</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>

        <View style={styles.card}>

          {/* Email — shown on all modes except forgot_newpass */}
          {mode !== "forgot_newpass" && (
            <>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                placeholder="you@example.com"
                placeholderTextColor="#aaa"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                editable={mode === "login" || mode === "signup" || mode === "forgot"}
              />
            </>
          )}

          {/* Password — login and signup only */}
          {(mode === "login" || mode === "signup") && (
            <>
              <Text style={styles.label}>Password</Text>
              <TextInput
                style={styles.input}
                placeholder="••••••••"
                placeholderTextColor="#aaa"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
              />
            </>
          )}

          {/* Forgot password link — login only */}
          {mode === "login" && (
            <TouchableOpacity onPress={() => setMode("forgot")} style={styles.forgotLink}>
              <Text style={styles.forgotText}>Forgot Password?</Text>
            </TouchableOpacity>
          )}

          {/* OTP input — verify and forgot_verify */}
          {(mode === "verify" || mode === "forgot_verify") && (
            <>
              <Text style={styles.label}>Confirmation Code</Text>
              <Text style={styles.hint}>Enter the 8-digit code sent to {email}</Text>
              <TextInput
                style={[styles.input, styles.otpInput]}
                placeholder="12345678"
                placeholderTextColor="#aaa"
                value={otp}
                onChangeText={(t) => setOtp(t.replace(/[^0-9]/g, "").slice(0, 8))}
                keyboardType="number-pad"
                autoCapitalize="none"
                autoFocus
              />
            </>
          )}

          {(mode === "verify" || mode === "forgot_verify") && (
  <TouchableOpacity onPress={handleResend} disabled={loading} style={styles.resendLink}>
    <Text style={styles.resendText}>Resend Code</Text>
  </TouchableOpacity>
)}

          {/* New password — forgot_newpass only */}
          {mode === "forgot_newpass" && (
            <>
              <Text style={styles.label}>New Password</Text>
              <TextInput
                style={styles.input}
                placeholder="••••••••"
                placeholderTextColor="#aaa"
                value={newPassword}
                onChangeText={setNewPassword}
                secureTextEntry
                autoCapitalize="none"
                autoFocus
              />
            </>
          )}

          {/* Primary action button */}
          <TouchableOpacity
            style={[styles.primaryBtn, loading && styles.disabledBtn]}
            onPress={primaryAction}
            disabled={loading}
          >
            {loading
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.primaryBtnText}>{primaryLabel}</Text>
            }
          </TouchableOpacity>

          {/* Create Account button — login only */}
          {mode === "login" && (
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => setMode("signup")}>
              <Text style={styles.secondaryBtnText}>Create Account</Text>
            </TouchableOpacity>
          )}

          {/* Back to login */}
          {mode !== "login" && (
            <TouchableOpacity style={styles.backLink} onPress={goBackToLogin}>
              <Text style={styles.backLinkText}>← Back to Login</Text>
            </TouchableOpacity>
          )}

        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F4F7FA" },
  scroll: { flexGrow: 1, justifyContent: "center", padding: 24 },
  header: { alignItems: "center", marginBottom: 32 },
  appName: { fontSize: 36, fontWeight: "800", color: "#007BFF", letterSpacing: -1 },
  subtitle: { fontSize: 15, color: "#6c757d", marginTop: 6 },
  card: {
    backgroundColor: "#fff", borderRadius: 16, padding: 24,
    shadowColor: "#000", shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08, shadowRadius: 12, elevation: 4,
  },
  label: { fontSize: 13, fontWeight: "600", color: "#6c757d", marginBottom: 6, marginTop: 12 },
  input: {
    borderWidth: 1, borderColor: "#E0E0E0", borderRadius: 10,
    padding: 14, fontSize: 15, color: "#333", backgroundColor: "#FAFAFA",
  },
  hint: { fontSize: 13, color: "#6c757d", marginBottom: 8, lineHeight: 18 },
  otpInput: { fontSize: 22, fontWeight: "700", letterSpacing: 8, textAlign: "center" },
  forgotLink: { alignSelf: "flex-end", marginTop: 8 },
  forgotText: { color: "#007BFF", fontSize: 13, fontWeight: "600" },
  primaryBtn: {
    backgroundColor: "#007BFF", borderRadius: 10, padding: 16,
    alignItems: "center", marginTop: 24,
  },
  disabledBtn: { backgroundColor: "#93c5fd" },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  secondaryBtn: {
    borderWidth: 2, borderColor: "#007BFF", borderRadius: 10,
    padding: 14, alignItems: "center", marginTop: 12,
  },
  secondaryBtnText: { color: "#007BFF", fontSize: 15, fontWeight: "700" },
  backLink: { alignItems: "center", marginTop: 16 },
  backLinkText: { color: "#6c757d", fontSize: 14, fontWeight: "600" },
  resendLink: { alignItems: "center", marginTop: 12 },
resendText: { color: "#007BFF", fontSize: 13, fontWeight: "600" }
});