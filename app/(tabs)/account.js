import React, { useState, useEffect } from "react";
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  Alert, ActivityIndicator, Modal, KeyboardAvoidingView, Platform, Switch,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { saveThresholds, loadThresholds } from "../../lib/notifications";
import {
  fetchSubscription, isSubscriptionActive, startSubscriptionCheckout,
  openBillingPortal, SUBSCRIPTION_PLANS,
} from "../../lib/billing";
import { APP_VERSION } from "../../lib/config";

let Haptics = null;
try { Haptics = require("expo-haptics"); } catch (_) {}
const haptic = () => { try { Haptics?.impactAsync(Haptics.ImpactFeedbackStyle?.Light); } catch (_) {} };

const THRESHOLDS = [
  { key: "temp_c",      label: "Temperature", unit: "°F",   icon: "thermometer",  color: "#FF6B6B", defaultMin: 59, defaultMax: 86 },
  { key: "humidity",    label: "Humidity",    unit: "%",    icon: "water",        color: "#45B7D1", defaultMin: 25, defaultMax: 65 },
  { key: "pressure_pa", label: "Pressure",    unit: " hPa", icon: "speedometer",  color: "#4ECDC4", defaultMin: 950, defaultMax: 1050 },
  { key: "windspeed",   label: "Wind Speed",  unit: " m/s", icon: "partly-sunny", color: "#96CEB4", defaultMin: 0, defaultMax: 8 },
];

function ChangePasswordModal({ visible, onClose, theme }) {
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [loading, setLoading] = useState(false);
  const handleChange = async () => {
    if (newPass !== confirmPass) { Alert.alert("Error", "Passwords do not match"); return; }
    if (newPass.length < 6) { Alert.alert("Error", "Password must be at least 6 characters"); return; }
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password: newPass });
    setLoading(false);
    if (error) Alert.alert("Error", error.message);
    else { Alert.alert("Success", "Password changed!"); setNewPass(""); setConfirmPass(""); onClose(); }
  };
  return (
    <Modal visible={visible} animationType="slide" transparent presentationStyle="overFullScreen">
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <TouchableOpacity style={modal.overlay} activeOpacity={1} onPress={onClose}>
          <TouchableOpacity activeOpacity={1} onPress={() => {}}>
            <View style={[modal.card, { backgroundColor: theme.card }]}>
              <View style={modal.handle} />
              <Text style={[modal.title, { color: theme.text }]}>Change Password</Text>
              <Text style={[modal.subtitle, { color: theme.subtext }]}>Must be at least 6 characters</Text>
              <View style={[modal.fieldGroup, { backgroundColor: theme.inputBg }]}>
                <View style={modal.fieldRow}>
                  <View style={[modal.fieldIcon, { backgroundColor: "#EBF5FF" }]}><Ionicons name="lock-closed" size={18} color="#007BFF" /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={[modal.label, { color: theme.subtext }]}>New Password</Text>
                    <TextInput style={[modal.input, { color: theme.text }]} placeholder="Enter new password" placeholderTextColor={theme.subtext} value={newPass} onChangeText={setNewPass} secureTextEntry autoCapitalize="none" />
                  </View>
                </View>
                <View style={[modal.divider, { backgroundColor: theme.divider }]} />
                <View style={modal.fieldRow}>
                  <View style={[modal.fieldIcon, { backgroundColor: "#F0FFF6" }]}><Ionicons name="checkmark-circle" size={18} color="#22c55e" /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={[modal.label, { color: theme.subtext }]}>Confirm Password</Text>
                    <TextInput style={[modal.input, { color: theme.text }]} placeholder="Confirm new password" placeholderTextColor={theme.subtext} value={confirmPass} onChangeText={setConfirmPass} secureTextEntry autoCapitalize="none" onSubmitEditing={handleChange} />
                  </View>
                </View>
              </View>
              <View style={modal.btnRow}>
                <TouchableOpacity style={[modal.cancelBtn, { backgroundColor: theme.inputBg, borderColor: theme.border }]} onPress={onClose}><Text style={[modal.cancelText, { color: theme.subtext }]}>Cancel</Text></TouchableOpacity>
                <TouchableOpacity style={[modal.saveBtn, loading && modal.disabledBtn]} onPress={handleChange} disabled={loading}>{loading ? <ActivityIndicator color="#fff" /> : <Text style={modal.saveText}>Change Password</Text>}</TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ThresholdRow({ metric, theme }) {
  const [min, setMin] = useState(`${metric.defaultMin}`);
  const [max, setMax] = useState(`${metric.defaultMax}`);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    loadThresholds().then((saved) => {
      if (saved[metric.key]) {
        setEnabled(saved[metric.key].enabled ?? false);
        setMin(`${saved[metric.key].min ?? metric.defaultMin}`);
        setMax(`${saved[metric.key].max ?? metric.defaultMax}`);
      }
    });
  }, []);

  const persist = async (newEnabled, newMin, newMax) => {
    const current = await loadThresholds();
    current[metric.key] = { enabled: newEnabled, min: newMin, max: newMax };
    await saveThresholds(current);
  };

  return (
    <View style={[thresh.row, { borderBottomColor: theme.divider }]}>
      <View style={[thresh.iconBg, { backgroundColor: metric.color + "20" }]}><Ionicons name={metric.icon} size={16} color={metric.color} /></View>
      <View style={{ flex: 1 }}>
        <Text style={[thresh.label, { color: theme.text }]}>{metric.label}</Text>
        {enabled && (
          <View style={thresh.inputs}>
            <View style={thresh.inputWrap}>
              <Text style={[thresh.inputLabel, { color: theme.subtext }]}>Min</Text>
              <TextInput style={[thresh.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]} value={min} onChangeText={setMin} keyboardType="numeric" onBlur={() => persist(enabled, min, max)} />
              <Text style={[thresh.inputUnit, { color: theme.subtext }]}>{metric.unit}</Text>
            </View>
            <View style={thresh.inputWrap}>
              <Text style={[thresh.inputLabel, { color: theme.subtext }]}>Max</Text>
              <TextInput style={[thresh.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]} value={max} onChangeText={setMax} keyboardType="numeric" onBlur={() => persist(enabled, min, max)} />
              <Text style={[thresh.inputUnit, { color: theme.subtext }]}>{metric.unit}</Text>
            </View>
          </View>
        )}
      </View>
      <Switch value={enabled} onValueChange={(v) => { setEnabled(v); persist(v, min, max); }}
        trackColor={{ false: "#e5e7eb", true: metric.color + "80" }} thumbColor={enabled ? metric.color : "#fff"} />
    </View>
  );
}

export default function AccountScreen() {
  const { session, signOut, technicianAssignments, refreshTechnicianAssignments } = useAuth();
  const { theme, isDark, toggleTheme } = useTheme();
  const [displayName, setDisplayName] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [changePassVisible, setChangePassVisible] = useState(false);
  const [editing, setEditing] = useState(false);

  const [myTechnician, setMyTechnician] = useState(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [landlordNames, setLandlordNames] = useState({});

  const [subscription, setSubscription] = useState(null);
  const [subLoading, setSubLoading] = useState(false);

  useEffect(() => {
    loadProfile();
    loadTeamData();
    loadSubscription();
  }, []);

  useEffect(() => {
    loadLandlordNames();
  }, [technicianAssignments]);

  const loadProfile = async () => {
    const userId = session?.user?.id;
    if (!userId) return;
    const { data, error } = await supabase.from("profiles").select("full_name").eq("id", userId).maybeSingle();
    if (error) console.warn("loadProfile:", error.message);
    setDisplayName(data?.full_name || "");
    setLoading(false);
  };

  const loadTeamData = async () => {
    const userId = session?.user?.id;
    if (!userId) return;
    const { data, error } = await supabase
      .from("technician_assignments")
      .select("id, technician_email")
      .eq("landlord_id", userId)
      .maybeSingle();
    if (error) { console.warn("loadTeamData:", error.message); return; }
    setMyTechnician(data || null);
  };

  const loadLandlordNames = async () => {
    if (!technicianAssignments.length) return;
    const ids = technicianAssignments.map(a => a.landlord_id);
    const { data, error } = await supabase.from("profiles").select("id, full_name").in("id", ids);
    if (error) { console.warn("loadLandlordNames:", error.message); return; }
    const map = {};
    (data || []).forEach(p => { map[p.id] = p.full_name || "Your landlord"; });
    setLandlordNames(map);
  };

  const loadSubscription = async () => {
    const userId = session?.user?.id;
    if (!userId) return;
    try {
      setSubscription(await fetchSubscription(userId));
    } catch (e) {
      // Table may not exist until backend setup is run — treat as free plan
      console.warn("loadSubscription:", e.message);
    }
  };

  const handleUpgrade = async () => {
    setSubLoading(true);
    try {
      await startSubscriptionCheckout();
      await loadSubscription();
    } catch (e) {
      Alert.alert("Upgrade Failed", e.message);
    }
    setSubLoading(false);
  };

  const handleManageBilling = async () => {
    setSubLoading(true);
    try {
      await openBillingPortal();
      await loadSubscription();
    } catch (e) {
      Alert.alert("Billing Portal", e.message);
    }
    setSubLoading(false);
  };

  const inviteTechnician = async () => {
    const email = inviteEmail.toLowerCase().trim();
    if (!email || !email.includes("@")) { Alert.alert("Error", "Enter a valid email address"); return; }
    setInviteLoading(true);
    const { error } = await supabase.from("technician_assignments").insert({
      landlord_id: session.user.id,
      technician_email: email,
    });
    setInviteLoading(false);
    if (error) {
      if (error.code === "23505") Alert.alert("Already assigned", "That email is already your technician.");
      else Alert.alert("Error", error.message);
      return;
    }
    setInviteEmail("");
    loadTeamData();
  };

  const removeTechnician = () => {
    Alert.alert("Remove Technician", `Remove ${myTechnician.technician_email} as your technician?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => {
        const { error } = await supabase.from("technician_assignments").delete().eq("id", myTechnician.id);
        if (error) { Alert.alert("Error", "Failed to remove technician: " + error.message); return; }
        setMyTechnician(null);
      }},
    ]);
  };

  const saveProfile = async () => {
    if (!displayName.trim()) { Alert.alert("Error", "Display name cannot be empty"); return; }
    setSaving(true);
    const { error } = await supabase.from("profiles").update({ full_name: displayName.trim() }).eq("id", session?.user?.id);
    setSaving(false);
    if (error) Alert.alert("Error", "Failed to update profile");
    else { Alert.alert("Success", "Profile updated!"); setEditing(false); }
  };

  const handleSignOut = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign Out", style: "destructive", onPress: signOut },
    ]);
  };

  const avatarLetter = (displayName || session?.user?.email || "?")[0].toUpperCase();

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={styles.header}>
        <View style={styles.avatarCircle}><Text style={styles.avatarText}>{avatarLetter}</Text></View>
        <Text style={styles.headerName}>{displayName || "Your Account"}</Text>
        <Text style={styles.headerEmail}>{session?.user?.email}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>

        {/* Profile */}
        <View style={styles.sectionLabel}><Text style={[styles.sectionTitle, { color: theme.subtext }]}>Profile</Text></View>
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={styles.cardRow}>
            <View style={[styles.rowIcon, { backgroundColor: theme.inputBg }]}><Ionicons name="person" size={18} color={theme.subtext} /></View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowLabel, { color: theme.subtext }]}>Display Name</Text>
              {editing ? (
                <TextInput style={[styles.inlineInput, { color: theme.text, borderBottomColor: "#007BFF" }]} value={displayName} onChangeText={setDisplayName} autoFocus returnKeyType="done" onSubmitEditing={saveProfile} />
              ) : (
                <Text style={[styles.rowValue, { color: theme.text }]}>{displayName || "Not set"}</Text>
              )}
            </View>
            <TouchableOpacity onPress={() => { haptic(); editing ? saveProfile() : setEditing(true); }}>
              {saving ? <ActivityIndicator color="#007BFF" size="small" /> : <Text style={styles.editLink}>{editing ? "Save" : "Edit"}</Text>}
            </TouchableOpacity>
          </View>
          <View style={[styles.rowDivider, { backgroundColor: theme.divider, marginLeft: 58 }]} />
          <View style={styles.cardRow}>
            <View style={[styles.rowIcon, { backgroundColor: theme.inputBg }]}><Ionicons name="mail" size={18} color={theme.subtext} /></View>
            <View style={{ flex: 1 }}><Text style={[styles.rowLabel, { color: theme.subtext }]}>Email</Text><Text style={[styles.rowValue, { color: theme.text }]} numberOfLines={1}>{session?.user?.email}</Text></View>
          </View>
          <View style={[styles.rowDivider, { backgroundColor: theme.divider, marginLeft: 58 }]} />
          <View style={styles.cardRow}>
            <View style={[styles.rowIcon, { backgroundColor: theme.inputBg }]}><Ionicons name="finger-print" size={18} color={theme.subtext} /></View>
            <View style={{ flex: 1 }}><Text style={[styles.rowLabel, { color: theme.subtext }]}>User ID</Text><Text style={[styles.rowValue, { color: theme.subtext, fontSize: 12, fontFamily: "monospace" }]} numberOfLines={1} ellipsizeMode="middle">{session?.user?.id}</Text></View>
          </View>
        </View>

        {/* Subscription */}
        {(() => {
          const active = isSubscriptionActive(subscription);
          const plan = active ? SUBSCRIPTION_PLANS.pro : SUBSCRIPTION_PLANS.free;
          const renewal = subscription?.current_period_end
            ? new Date(subscription.current_period_end).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
            : null;
          return (
            <>
              <View style={styles.sectionLabel}><Text style={[styles.sectionTitle, { color: theme.subtext }]}>Subscription</Text></View>
              <View style={[styles.card, { backgroundColor: theme.card, borderColor: active ? "#007BFF40" : theme.border }]}>
                <View style={styles.cardRow}>
                  <View style={[styles.rowIcon, { backgroundColor: active ? "#EBF5FF" : theme.inputBg }]}>
                    <Ionicons name={active ? "star" : "star-outline"} size={18} color={active ? "#007BFF" : theme.subtext} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.rowLabel, { color: theme.subtext }]}>Current Plan</Text>
                    <Text style={[styles.rowValue, { color: theme.text }]}>
                      {plan.name}{active && subscription?.status === "past_due" ? " · payment issue" : ""}
                    </Text>
                    {active && renewal && (
                      <Text style={[styles.rowLabel, { color: theme.subtext, marginTop: 2 }]}>
                        {subscription?.cancel_at_period_end ? `Ends ${renewal}` : `Renews ${renewal}`}
                      </Text>
                    )}
                  </View>
                  {active && (
                    <View style={styles.proBadge}><Text style={styles.proBadgeText}>PRO</Text></View>
                  )}
                </View>
                <View style={[styles.rowDivider, { backgroundColor: theme.divider, marginLeft: 58 }]} />
                {!active && (
                  <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
                    {SUBSCRIPTION_PLANS.pro.features.map(f => (
                      <View key={f} style={styles.featureRow}>
                        <Ionicons name="checkmark-circle" size={14} color="#22c55e" />
                        <Text style={[styles.featureText, { color: theme.subtext }]}>{f}</Text>
                      </View>
                    ))}
                  </View>
                )}
                <TouchableOpacity
                  style={[styles.subBtn, active ? { backgroundColor: theme.inputBg } : { backgroundColor: "#007BFF" }]}
                  onPress={() => { haptic(); active ? handleManageBilling() : handleUpgrade(); }}
                  disabled={subLoading}
                >
                  {subLoading ? (
                    <ActivityIndicator color={active ? "#007BFF" : "#fff"} size="small" />
                  ) : (
                    <Text style={[styles.subBtnText, { color: active ? theme.text : "#fff" }]}>
                      {active ? "Manage Billing" : `Upgrade to Pro · ${SUBSCRIPTION_PLANS.pro.priceLabel}`}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </>
          );
        })()}

        {/* Appearance */}
        <View style={styles.sectionLabel}><Text style={[styles.sectionTitle, { color: theme.subtext }]}>Appearance</Text></View>
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <View style={styles.cardRow}>
            <View style={[styles.rowIcon, { backgroundColor: theme.inputBg }]}><Ionicons name={isDark ? "moon" : "sunny"} size={18} color={theme.subtext} /></View>
            <View style={{ flex: 1 }}><Text style={[styles.rowValue, { color: theme.text }]}>Dark Mode</Text><Text style={[styles.rowLabel, { color: theme.subtext }]}>{isDark ? "On" : "Off"}</Text></View>
            <Switch value={isDark} onValueChange={toggleTheme} trackColor={{ false: "#e5e7eb", true: "#3b82f6" }} thumbColor="#fff" />
          </View>
        </View>

        {/* Alert thresholds */}
        <View style={styles.sectionLabel}><Text style={[styles.sectionTitle, { color: theme.subtext }]}>Alert Thresholds</Text></View>
        <Text style={[styles.sectionDesc, { color: theme.subtext }]}>Get notified when a reading goes outside your set range.</Text>
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          {THRESHOLDS.map((t, i) => (
            <View key={t.key}>
              <ThresholdRow metric={t} theme={theme} />
              {i < THRESHOLDS.length - 1 && <View style={[styles.rowDivider, { backgroundColor: theme.divider, marginLeft: 0 }]} />}
            </View>
          ))}
        </View>

        {/* Security */}
        <View style={styles.sectionLabel}><Text style={[styles.sectionTitle, { color: theme.subtext }]}>Security</Text></View>
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <TouchableOpacity style={styles.cardRow} onPress={() => { haptic(); setChangePassVisible(true); }}>
            <View style={[styles.rowIcon, { backgroundColor: theme.inputBg }]}><Ionicons name="lock-closed" size={18} color={theme.subtext} /></View>
            <View style={{ flex: 1 }}><Text style={[styles.rowValue, { color: theme.text }]}>Change Password</Text></View>
            <Ionicons name="chevron-forward" size={18} color={theme.subtext} />
          </TouchableOpacity>
        </View>

        {/* Team */}
        <View style={styles.sectionLabel}><Text style={[styles.sectionTitle, { color: theme.subtext }]}>Team</Text></View>

        {/* As landlord: manage my technician */}
        <Text style={[styles.sectionDesc, { color: theme.subtext }]}>
          {myTechnician ? "Your technician can view all devices and edit names and locations." : "Invite a technician to manage your devices."}
        </Text>
        <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
          {myTechnician ? (
            <View style={styles.cardRow}>
              <View style={[styles.rowIcon, { backgroundColor: "#e0f2fe" }]}><Ionicons name="construct" size={18} color="#0284c7" /></View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowLabel, { color: theme.subtext }]}>Technician</Text>
                <Text style={[styles.rowValue, { color: theme.text }]} numberOfLines={1}>{myTechnician.technician_email}</Text>
              </View>
              <TouchableOpacity onPress={() => { haptic(); removeTechnician(); }}>
                <Text style={{ color: "#ef4444", fontWeight: "700", fontSize: 14 }}>Remove</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.cardRow}>
              <View style={[styles.rowIcon, { backgroundColor: theme.inputBg }]}><Ionicons name="person-add" size={18} color={theme.subtext} /></View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowLabel, { color: theme.subtext }]}>Technician Email</Text>
                <TextInput
                  style={[styles.inlineInput, { color: theme.text, borderBottomColor: theme.border }]}
                  placeholder="technician@example.com"
                  placeholderTextColor={theme.subtext}
                  value={inviteEmail}
                  onChangeText={setInviteEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={inviteTechnician}
                />
              </View>
              <TouchableOpacity onPress={() => { haptic(); inviteTechnician(); }} disabled={inviteLoading}>
                {inviteLoading
                  ? <ActivityIndicator color="#007BFF" size="small" />
                  : <Text style={styles.editLink}>Invite</Text>}
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* As technician: show which landlord account I work under */}
        {technicianAssignments.length > 0 && (
          <>
            <Text style={[styles.sectionDesc, { color: theme.subtext, marginTop: 8 }]}>You have technician access to the following accounts:</Text>
            <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}>
              {technicianAssignments.map((a, i) => (
                <View key={a.id}>
                  <View style={styles.cardRow}>
                    <View style={[styles.rowIcon, { backgroundColor: "#e0f2fe" }]}><Ionicons name="home" size={18} color="#0284c7" /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.rowLabel, { color: theme.subtext }]}>Landlord</Text>
                      <Text style={[styles.rowValue, { color: theme.text }]}>{landlordNames[a.landlord_id] || a.technician_email}</Text>
                    </View>
                    <View style={[styles.rowIcon, { backgroundColor: "#e0f2fe" }]}><Ionicons name="construct-outline" size={16} color="#0284c7" /></View>
                  </View>
                  {i < technicianAssignments.length - 1 && <View style={[styles.rowDivider, { backgroundColor: theme.divider, marginLeft: 0 }]} />}
                </View>
              ))}
            </View>
          </>
        )}

        {/* Sign out */}
        <TouchableOpacity style={[styles.signOutBtn, { borderColor: "#fecaca", backgroundColor: theme.card }]} onPress={handleSignOut}>
          <Ionicons name="log-out-outline" size={20} color="#ef4444" />
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>

        <Text style={[styles.version, { color: theme.subtext }]}>AirFlow IQ Mobile v{APP_VERSION}</Text>
      </ScrollView>

      <ChangePasswordModal visible={changePassVisible} onClose={() => setChangePassVisible(false)} theme={theme} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { backgroundColor: "#007BFF", paddingTop: 60, paddingBottom: 32, alignItems: "center" },
  avatarCircle: { width: 80, height: 80, borderRadius: 40, backgroundColor: "rgba(255,255,255,0.25)", justifyContent: "center", alignItems: "center", marginBottom: 12 },
  avatarText: { fontSize: 34, fontWeight: "800", color: "#fff" },
  headerName: { fontSize: 22, fontWeight: "800", color: "#fff" },
  headerEmail: { fontSize: 13, color: "rgba(255,255,255,0.75)", marginTop: 4 },
  scroll: { paddingHorizontal: 20, paddingBottom: 40, paddingTop: 8 },
  sectionLabel: { paddingVertical: 10, paddingHorizontal: 4 },
  sectionTitle: { fontSize: 13, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.8 },
  sectionDesc: { fontSize: 12, marginBottom: 10, marginHorizontal: 4 },
  card: { borderRadius: 18, borderWidth: 1, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2, marginBottom: 8 },
  cardRow: { flexDirection: "row", alignItems: "center", padding: 16, gap: 12 },
  rowIcon: { width: 36, height: 36, borderRadius: 10, justifyContent: "center", alignItems: "center" },
  rowLabel: { fontSize: 11, fontWeight: "700", marginBottom: 3 },
  rowValue: { fontSize: 15, fontWeight: "600" },
  rowDivider: { height: 1 },
  editLink: { fontSize: 14, fontWeight: "700", color: "#007BFF" },
  inlineInput: { fontSize: 15, fontWeight: "600", borderBottomWidth: 1.5, paddingBottom: 2 },
  proBadge: { backgroundColor: "#007BFF", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  proBadgeText: { color: "#fff", fontSize: 10, fontWeight: "800", letterSpacing: 0.5 },
  featureRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  featureText: { fontSize: 13, fontWeight: "500" },
  subBtn: { borderRadius: 12, padding: 14, alignItems: "center", margin: 16, marginTop: 12 },
  subBtnText: { fontWeight: "700", fontSize: 14 },
  signOutBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 18, padding: 18, marginTop: 16, borderWidth: 1.5 },
  signOutText: { color: "#ef4444", fontSize: 16, fontWeight: "700" },
  version: { textAlign: "center", fontSize: 12, marginTop: 24 },
});

const thresh = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", padding: 16, gap: 12, borderBottomWidth: 1 },
  iconBg: { width: 32, height: 32, borderRadius: 10, justifyContent: "center", alignItems: "center" },
  label: { fontSize: 14, fontWeight: "600", marginBottom: 6 },
  inputs: { flexDirection: "row", gap: 12, marginTop: 4 },
  inputWrap: { flexDirection: "row", alignItems: "center", gap: 4 },
  inputLabel: { fontSize: 11, fontWeight: "600" },
  input: { width: 70, borderWidth: 1, borderRadius: 8, padding: 6, fontSize: 13, fontWeight: "600", textAlign: "center" },
  inputUnit: { fontSize: 11 },
});

const modal = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  card: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 44 },
  handle: { width: 36, height: 4, backgroundColor: "#e5e7eb", borderRadius: 2, alignSelf: "center", marginBottom: 20 },
  title: { fontSize: 22, fontWeight: "800", marginBottom: 4 },
  subtitle: { fontSize: 14, marginBottom: 24 },
  fieldGroup: { borderRadius: 16, overflow: "hidden", marginBottom: 24 },
  fieldRow: { flexDirection: "row", alignItems: "center", padding: 16, gap: 12 },
  fieldIcon: { width: 36, height: 36, borderRadius: 10, justifyContent: "center", alignItems: "center" },
  divider: { height: 1, marginLeft: 64 },
  label: { fontSize: 11, fontWeight: "700", marginBottom: 4 },
  input: { fontSize: 15, fontWeight: "500", padding: 0 },
  btnRow: { flexDirection: "row", gap: 12 },
  cancelBtn: { flex: 1, borderWidth: 1.5, borderRadius: 14, padding: 16, alignItems: "center" },
  cancelText: { fontWeight: "700", fontSize: 15 },
  saveBtn: { flex: 1, backgroundColor: "#007BFF", borderRadius: 14, padding: 16, alignItems: "center" },
  disabledBtn: { backgroundColor: "#93c5fd" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});