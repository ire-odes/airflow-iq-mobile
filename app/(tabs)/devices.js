import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, Alert, ActivityIndicator, Modal, RefreshControl,
  KeyboardAvoidingView, Platform, Switch,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import {
  FILTER_INTERVAL_MIN_DAYS, FILTER_INTERVAL_MAX_DAYS, DEFAULT_FILTER_INTERVAL_DAYS,
  WAKE_INTERVAL_MIN_SECONDS, WAKE_INTERVAL_MAX_SECONDS, DEFAULT_WAKE_INTERVAL_SECONDS,
} from "../../lib/config";
import { getLatestVerdict } from "../../lib/mlVerdict";

let Haptics = null;
try { Haptics = require("expo-haptics"); } catch (_) {}
const haptic = () => { try { Haptics?.impactAsync(Haptics.ImpactFeedbackStyle?.Light); } catch (_) {} };

let CameraView = null;
let useCameraPermissions = () => [null, async () => {}];
try {
  const cam = require("expo-camera");
  CameraView = cam.CameraView;
  useCameraPermissions = cam.useCameraPermissions;
} catch (_) {}

function timeAgo(ts) {
  if (!ts) return null;
  const d = new Date(ts.replace ? ts.replace(" ", "T") : ts);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function getOnlineStatus(lastSeen) {
  if (!lastSeen) return "unknown";
  const diff = Date.now() - new Date(lastSeen.replace ? lastSeen.replace(" ", "T") : lastSeen).getTime();
  if (diff < 10 * 60 * 1000) return "online";
  if (diff < 60 * 60 * 1000) return "idle";
  return "offline";
}

function getFilterProgress(installedAt, intervalDays) {
  if (!installedAt || !intervalDays) return null;
  const daysSince = Math.floor((Date.now() - new Date(installedAt.replace ? installedAt.replace(" ", "T") : installedAt).getTime()) / 86400000);
  const pct = Math.min(100, Math.round((daysSince / intervalDays) * 100));
  const daysLeft = Math.max(0, intervalDays - daysSince);
  return { daysSince, daysLeft, pct, intervalDays };
}

function FilterProgressBar({ pct, daysLeft, theme }) {
  const color = pct >= 100 ? "#ef4444" : pct >= 75 ? "#f59e0b" : pct >= 50 ? "#f59e0b" : "#22c55e";
  const label = pct >= 100 ? "Replace now" : pct >= 90 ? "Replace soon" : pct >= 75 ? "Watch closely" : `${daysLeft}d left`;
  return (
    <View style={fpb.container}>
      <View style={fpb.labelRow}>
        <Text style={[fpb.label, { color: theme.subtext }]}>Filter life</Text>
        <Text style={[fpb.right, { color }]}>{label}</Text>
      </View>
      <View style={[fpb.track, { backgroundColor: color + "25" }]}>
        <View style={[fpb.fill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      <Text style={[fpb.pct, { color: theme.subtext }]}>{pct}% used</Text>
    </View>
  );
}

// Acoustic verdict, shown ALONGSIDE the time-based FilterProgressBar above,
// never replacing it -- a brand-new device's classifier can be confidently
// wrong until its per-device drift baseline has warmed up (see
// ML/drift_detector.py), so the existing time-based estimate stays the
// primary signal until there's ML history to trust. Renders nothing (not
// even an empty slot) until a device actually has a verdict.
function AcousticVerdictBadge({ mlVerdict }) {
  if (!mlVerdict?.verdict) return null;

  // "calibrating" means the device hasn't finished its acoustic warmup --
  // the classifier alone is known to misfire on a brand-new environment
  // (a real device called 100% of a real house's clean readings "dirty"),
  // so its raw opinion never gets shown as a verdict during this phase.
  if (mlVerdict.verdict === "calibrating") {
    return (
      <View style={[abadge.container, { backgroundColor: "#6366f115" }]}>
        <Ionicons name="sync" size={13} color="#6366f1" />
        <Text style={[abadge.text, { color: "#6366f1" }]}>Calibrating…</Text>
      </View>
    );
  }

  const isClean = mlVerdict.verdict === "clean";
  const color = isClean ? "#22c55e" : "#f97316";
  const label = isClean ? "Clean (acoustic)" : "Clogged (acoustic)";
  const pct = mlVerdict.confidence != null ? Math.round(mlVerdict.confidence * 100) : null;
  return (
    <View style={[abadge.container, { backgroundColor: color + "15" }]}>
      <Ionicons name={isClean ? "checkmark-circle" : "warning"} size={13} color={color} />
      <Text style={[abadge.text, { color }]}>
        {label}{pct != null ? ` · clf ${pct}% dirty` : ""}
      </Text>
    </View>
  );
}

// ── Claim Modal ───────────────────────────────────────────────────────────────
function ClaimDeviceModal({ visible, onClose, onClaimed, theme }) {
  const { session } = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [searching, setSearching] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [mac, setMac] = useState("");
  const claimingRef = useRef(false);

  useEffect(() => {
    if (!visible) { setScanned(false); setManualMode(false); setMac(""); setTorchOn(false); claimingRef.current = false; }
  }, [visible]);

  const formatMac = (text) => {
    const clean = text.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
    return (clean.match(/.{1,2}/g) || []).join(":").slice(0, 17);
  };

  const handleClaim = async (rawMac) => {
    const cleanMac = rawMac.replace(/[^a-fA-F0-9]/gi, "").toUpperCase();
    if (cleanMac.length !== 12) {
      Alert.alert("Invalid Code", "QR code doesn't contain a valid device MAC address.");
      setScanned(false);
      return;
    }
    setSearching(true);
    const { data, error } = await supabase.from("devices").select("*").eq("device_mac", cleanMac).is("owner_id", null).single();
    if (error || !data) {
      const { data: existing } = await supabase.from("devices").select("id, owner_id").eq("device_mac", cleanMac).single();
      setSearching(false);
      if (existing?.owner_id === session?.user?.id) Alert.alert("Already Yours", "This device is already registered to your account.");
      else if (existing?.owner_id) Alert.alert("Already Claimed", "This device is registered to another account.");
      else Alert.alert("Not Found", "No device found matching this QR code.");
      setScanned(false);
      return;
    }
    const { error: claimError } = await supabase.from("devices").update({ owner_id: session?.user?.id }).eq("id", data.id);
    setSearching(false);
    if (claimError) { Alert.alert("Error", claimError.message); setScanned(false); return; }
    Alert.alert("Device Claimed!", `"${data.name || "Device"}" has been added to your account.`);
    onClaimed();
  };

  const handleBarCodeScanned = ({ data }) => {
    if (claimingRef.current) return;
    claimingRef.current = true;
    setScanned(true);
    haptic();
    let macValue = data.trim();
    try { const p = JSON.parse(data); if (p.mac) macValue = p.mac; } catch (_) {}
    handleClaim(macValue);
  };

  const renderScanner = () => {
    if (!CameraView) {
      return (
        <View style={scanStyles.permissionBox}>
          <Ionicons name="camera-outline" size={48} color={theme.subtext} />
          <Text style={[scanStyles.permissionText, { color: theme.text }]}>Camera not available</Text>
          <Text style={[scanStyles.permissionSub, { color: theme.subtext }]}>Run: npx expo install expo-camera</Text>
        </View>
      );
    }
    if (!permission) return <ActivityIndicator color="#007BFF" style={{ marginVertical: 40 }} />;
    if (!permission.granted) {
      return (
        <View style={scanStyles.permissionBox}>
          <Ionicons name="camera-outline" size={48} color={theme.subtext} />
          <Text style={[scanStyles.permissionText, { color: theme.text }]}>Camera access needed</Text>
          <Text style={[scanStyles.permissionSub, { color: theme.subtext }]}>Allow camera access to scan your device's QR code</Text>
          <TouchableOpacity style={scanStyles.grantBtn} onPress={requestPermission}>
            <Text style={scanStyles.grantBtnText}>Grant Camera Access</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={scanStyles.cameraContainer}>
        <CameraView
          style={scanStyles.camera}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
          enableTorch={torchOn}
        >
          <View style={scanStyles.scanOverlay}>
            <View style={scanStyles.scanFrame}>
              <View style={[scanStyles.corner, scanStyles.cornerTL]} />
              <View style={[scanStyles.corner, scanStyles.cornerTR]} />
              <View style={[scanStyles.corner, scanStyles.cornerBL]} />
              <View style={[scanStyles.corner, scanStyles.cornerBR]} />
            </View>
          </View>
          <TouchableOpacity
            style={[scanStyles.torchBtn, torchOn && scanStyles.torchBtnOn]}
            onPress={() => { haptic(); setTorchOn(t => !t); }}
          >
            <Ionicons name={torchOn ? "flashlight" : "flashlight-outline"} size={18} color="#fff" />
          </TouchableOpacity>
        </CameraView>
        {searching && (
          <View style={scanStyles.searchingOverlay}>
            <ActivityIndicator color="#007BFF" size="large" />
            <Text style={[scanStyles.searchingText, { color: theme.text }]}>Finding device...</Text>
          </View>
        )}
        {scanned && !searching && (
          <TouchableOpacity style={scanStyles.rescanRow} onPress={() => { setScanned(false); claimingRef.current = false; }}>
            <Text style={scanStyles.rescanText}>Tap to scan again</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent presentationStyle="overFullScreen">
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <TouchableOpacity style={modal.overlay} activeOpacity={1} onPress={onClose}>
          <TouchableOpacity activeOpacity={1}>
            <View style={[modal.card, { backgroundColor: theme.card }]}>
              <View style={modal.handle} />
              <Text style={[modal.title, { color: theme.text }]}>Claim Device</Text>
              <Text style={[modal.subtitle, { color: theme.subtext }]}>
                {manualMode ? "Enter the MAC address printed on your device" : "Scan the QR code on your device"}
              </Text>

              {manualMode ? (
                <>
                  <View style={[modal.fieldGroup, { backgroundColor: theme.inputBg }]}>
                    <View style={modal.fieldRow}>
                      <View style={[modal.fieldIcon, { backgroundColor: theme.inputBg }]}>
                        <Ionicons name="barcode-outline" size={18} color={theme.subtext} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[modal.label, { color: theme.subtext }]}>MAC Address</Text>
                        <TextInput
                          style={[modal.input, { color: theme.text }]}
                          placeholder="AA:BB:CC:DD:EE:FF"
                          placeholderTextColor={theme.subtext}
                          value={mac}
                          onChangeText={(t) => setMac(formatMac(t))}
                          autoCapitalize="characters"
                          autoCorrect={false}
                          maxLength={17}
                          returnKeyType="done"
                          onSubmitEditing={() => handleClaim(mac)}
                          autoFocus
                        />
                      </View>
                    </View>
                  </View>
                  <View style={modal.btnRow}>
                    <TouchableOpacity style={[modal.cancelBtn, { backgroundColor: theme.inputBg, borderColor: theme.border }]} onPress={() => setManualMode(false)}>
                      <Text style={[modal.cancelText, { color: theme.subtext }]}>Back</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[modal.saveBtn, searching && modal.disabledBtn]} onPress={() => handleClaim(mac)} disabled={searching}>
                      {searching ? <ActivityIndicator color="#fff" /> : <Text style={modal.saveText}>Claim Device</Text>}
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <>
                  {renderScanner()}
                  <View style={modal.btnRow}>
                    <TouchableOpacity style={[modal.cancelBtn, { backgroundColor: theme.inputBg, borderColor: theme.border, flex: 1 }]} onPress={onClose}>
                      <Text style={[modal.cancelText, { color: theme.subtext }]}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity onPress={() => setManualMode(true)} style={scanStyles.manualLink}>
                    <Text style={[scanStyles.manualLinkText, { color: theme.subtext }]}>Enter MAC address manually</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Edit Device Modal ─────────────────────────────────────────────────────────
function EditDeviceModal({ visible, device, onClose, onSave, theme, isOwner }) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [intervalDays, setIntervalDays] = useState(`${DEFAULT_FILTER_INTERVAL_DAYS}`);
  const [wakeInterval, setWakeInterval] = useState(`${DEFAULT_WAKE_INTERVAL_SECONDS}`);
  const [tenantEmail, setTenantEmail] = useState("");
  const [tenantEnabled, setTenantEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(device?.name || "");
    setLocation(device?.hvac_location || "");
    // Clamp legacy values into the allowed range so the form opens valid
    const storedInterval = device?.filter_interval_days || DEFAULT_FILTER_INTERVAL_DAYS;
    setIntervalDays(`${Math.min(Math.max(storedInterval, FILTER_INTERVAL_MIN_DAYS), FILTER_INTERVAL_MAX_DAYS)}`);
    const storedWake = device?.wake_interval_seconds || DEFAULT_WAKE_INTERVAL_SECONDS;
    setWakeInterval(`${Math.min(Math.max(storedWake, WAKE_INTERVAL_MIN_SECONDS), WAKE_INTERVAL_MAX_SECONDS)}`);
    setTenantEmail(device?.tenant_email || "");
    setTenantEnabled(!!device?.tenant_email);
  }, [device]);

  const handleSave = async () => {
    if (!name.trim()) { Alert.alert("Error", "Device name is required"); return; }

    // Technicians may only edit name and location — the DB enforces this too
    if (!isOwner) {
      setSaving(true);
      await onSave({ name: name.trim(), hvac_location: location.trim() });
      setSaving(false);
      return;
    }

    const interval = parseInt(intervalDays) || DEFAULT_FILTER_INTERVAL_DAYS;
    if (interval < FILTER_INTERVAL_MIN_DAYS || interval > FILTER_INTERVAL_MAX_DAYS) {
      Alert.alert("Error", `Filter interval must be between ${FILTER_INTERVAL_MIN_DAYS} and ${FILTER_INTERVAL_MAX_DAYS} days`);
      return;
    }
    const wake = parseInt(wakeInterval) || DEFAULT_WAKE_INTERVAL_SECONDS;
    if (wake < WAKE_INTERVAL_MIN_SECONDS || wake > WAKE_INTERVAL_MAX_SECONDS) {
      Alert.alert("Error", `Wake interval must be between ${WAKE_INTERVAL_MIN_SECONDS / 60} minutes and 24 hours`);
      return;
    }
    if (tenantEnabled && tenantEmail && !tenantEmail.includes("@")) { Alert.alert("Error", "Please enter a valid tenant email"); return; }
    setSaving(true);
    await onSave({
      name: name.trim(),
      hvac_location: location.trim(),
      filter_interval_days: interval,
      wake_interval_seconds: wake,
      tenant_email: tenantEnabled ? tenantEmail.trim().toLowerCase() : null,
    });
    setSaving(false);
  };

  const WAKE_PRESETS = [
    { label: "10m", value: "600" },
    { label: "15m", value: "900" },
    { label: "30m", value: "1800" },
    { label: "1h",  value: "3600" },
    { label: "6h",  value: "21600" },
  ];

  return (
    <Modal visible={visible} animationType="slide" transparent presentationStyle="overFullScreen">
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <TouchableOpacity style={modal.overlay} activeOpacity={1} onPress={onClose}>
          <TouchableOpacity activeOpacity={1}>
            <ScrollView>
              <View style={[modal.card, { backgroundColor: theme.card }]}>
                <View style={modal.handle} />
                <Text style={[modal.title, { color: theme.text }]}>Edit Device</Text>
                <Text style={[modal.subtitle, { color: theme.subtext }]}>Update device settings</Text>

                <Text style={[modal.sectionLabel, { color: theme.subtext }]}>DEVICE INFO</Text>
                <View style={[modal.fieldGroup, { backgroundColor: theme.inputBg }]}>
                  <View style={modal.fieldRow}>
                    <View style={[modal.fieldIcon, { backgroundColor: theme.inputBg }]}><Ionicons name="hardware-chip" size={18} color={theme.subtext} /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={[modal.label, { color: theme.subtext }]}>Device Name</Text>
                      <TextInput style={[modal.input, { color: theme.text }]} placeholder="e.g., Living Room Unit" placeholderTextColor={theme.subtext} value={name} onChangeText={setName} returnKeyType="next" />
                    </View>
                  </View>
                  <View style={[modal.divider, { backgroundColor: theme.divider }]} />
                  <View style={modal.fieldRow}>
                    <View style={[modal.fieldIcon, { backgroundColor: theme.inputBg }]}><Ionicons name="location" size={18} color={theme.subtext} /></View>
                    <View style={{ flex: 1 }}>
                      <Text style={[modal.label, { color: theme.subtext }]}>HVAC Location</Text>
                      <TextInput style={[modal.input, { color: theme.text }]} placeholder="e.g., Upstairs Hallway" placeholderTextColor={theme.subtext} value={location} onChangeText={setLocation} returnKeyType="next" />
                    </View>
                  </View>
                </View>

                {isOwner && (
                  <>
                    <Text style={[modal.sectionLabel, { color: theme.subtext }]}>FILTER SETTINGS</Text>
                    <View style={[modal.fieldGroup, { backgroundColor: theme.inputBg }]}>
                      <View style={modal.fieldRow}>
                        <View style={[modal.fieldIcon, { backgroundColor: theme.inputBg }]}><Ionicons name="time-outline" size={18} color={theme.subtext} /></View>
                        <View style={{ flex: 1 }}>
                          <Text style={[modal.label, { color: theme.subtext }]}>Replacement Interval</Text>
                          <View style={modal.intervalRow}>
                            <TextInput style={[modal.intervalInput, { color: theme.text, borderColor: theme.border }]} value={intervalDays} onChangeText={setIntervalDays} keyboardType="number-pad" maxLength={3} />
                            <Text style={[modal.intervalUnit, { color: theme.subtext }]}>days</Text>
                          </View>
                        </View>
                      </View>
                      <View style={[modal.divider, { backgroundColor: theme.divider }]} />
                      <View style={modal.presetRow}>
                        {["7", "14", "21", "30"].map(d => (
                          <TouchableOpacity key={d} style={[modal.preset, { backgroundColor: intervalDays === d ? "#007BFF" : theme.divider }]} onPress={() => { haptic(); setIntervalDays(d); }}>
                            <Text style={[modal.presetText, { color: intervalDays === d ? "#fff" : theme.subtext }]}>{d}d</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>

                    <Text style={[modal.sectionLabel, { color: theme.subtext }]}>DATA COLLECTION</Text>
                    <View style={[modal.fieldGroup, { backgroundColor: theme.inputBg }]}>
                      <View style={modal.fieldRow}>
                        <View style={[modal.fieldIcon, { backgroundColor: theme.inputBg }]}><Ionicons name="pulse-outline" size={18} color={theme.subtext} /></View>
                        <View style={{ flex: 1 }}>
                          <Text style={[modal.label, { color: theme.subtext }]}>Wake Interval</Text>
                          <Text style={[modal.helperText, { color: theme.subtext }]}>How often the device wakes up to collect data (min 10 minutes)</Text>
                          <View style={modal.intervalRow}>
                            <TextInput
                              style={[modal.intervalInput, { color: theme.text, borderColor: theme.border, width: 80 }]}
                              value={wakeInterval}
                              onChangeText={(t) => setWakeInterval(t.replace(/[^0-9]/g, ""))}
                              keyboardType="number-pad"
                              maxLength={5}
                            />
                            <Text style={[modal.intervalUnit, { color: theme.subtext }]}>seconds</Text>
                          </View>
                        </View>
                      </View>
                      <View style={[modal.divider, { backgroundColor: theme.divider }]} />
                      <View style={modal.presetRow}>
                        {WAKE_PRESETS.map(({ label, value }) => (
                          <TouchableOpacity key={value} style={[modal.preset, { backgroundColor: wakeInterval === value ? "#7c3aed" : theme.divider }]} onPress={() => { haptic(); setWakeInterval(value); }}>
                            <Text style={[modal.presetText, { color: wakeInterval === value ? "#fff" : theme.subtext }]}>{label}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>

                    <Text style={[modal.sectionLabel, { color: theme.subtext }]}>TENANT NOTIFICATIONS</Text>
                    <View style={[modal.fieldGroup, { backgroundColor: theme.inputBg }]}>
                      <View style={modal.fieldRow}>
                        <View style={[modal.fieldIcon, { backgroundColor: theme.inputBg }]}><Ionicons name="person-add" size={18} color={theme.subtext} /></View>
                        <View style={{ flex: 1 }}>
                          <Text style={[modal.label, { color: theme.subtext }]}>Notify Tenant by Email</Text>
                          <Text style={[modal.helperText, { color: theme.subtext }]}>Tenant receives an email when filter needs changing</Text>
                        </View>
                        <Switch value={tenantEnabled} onValueChange={(v) => { haptic(); setTenantEnabled(v); }}
                          trackColor={{ false: "#e5e7eb", true: "#6b728080" }} thumbColor={tenantEnabled ? "#374151" : "#fff"} />
                      </View>
                      {tenantEnabled && (
                        <>
                          <View style={[modal.divider, { backgroundColor: theme.divider }]} />
                          <View style={modal.fieldRow}>
                            <View style={[modal.fieldIcon, { backgroundColor: theme.inputBg }]}><Ionicons name="mail" size={18} color={theme.subtext} /></View>
                            <View style={{ flex: 1 }}>
                              <Text style={[modal.label, { color: theme.subtext }]}>Tenant Email</Text>
                              <TextInput
                                style={[modal.input, { color: theme.text }]}
                                placeholder="tenant@example.com"
                                placeholderTextColor={theme.subtext}
                                value={tenantEmail}
                                onChangeText={setTenantEmail}
                                keyboardType="email-address"
                                autoCapitalize="none"
                                autoCorrect={false}
                              />
                            </View>
                          </View>
                        </>
                      )}
                    </View>
                  </>
                )}

                <View style={modal.btnRow}>
                  <TouchableOpacity style={[modal.cancelBtn, { backgroundColor: theme.inputBg, borderColor: theme.border }]} onPress={onClose}><Text style={[modal.cancelText, { color: theme.subtext }]}>Cancel</Text></TouchableOpacity>
                  <TouchableOpacity style={[modal.saveBtn, saving && modal.disabledBtn]} onPress={handleSave} disabled={saving}>
                    {saving ? <ActivityIndicator color="#fff" /> : <Text style={modal.saveText}>Save Changes</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            </ScrollView>
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Device Card ───────────────────────────────────────────────────────────────
function DeviceCard({ device, onEdit, onDelete, onRecalibrate, index, theme, lastSeen, latestData, filterInstalledAt, isOwner, mlVerdict }) {
  const status = getOnlineStatus(lastSeen);
  const statusColor = status === "online" ? "#22c55e" : status === "idle" ? "#f59e0b" : "#9ca3af";
  const statusLabel = status === "online" ? "Online" : status === "idle" ? "Idle" : "Offline";
  const filterProgress = getFilterProgress(filterInstalledAt, device.filter_interval_days || DEFAULT_FILTER_INTERVAL_DAYS);
  const addedDate = device.created_at ? new Date(device.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
  const wakeSeconds = device.wake_interval_seconds || DEFAULT_WAKE_INTERVAL_SECONDS;
  const wakeLabel = wakeSeconds < 60 ? `${wakeSeconds}s` : wakeSeconds < 3600 ? `${wakeSeconds / 60}m` : `${wakeSeconds / 3600}h`;

  const battVoltage = latestData?.battery;
  const battPct = battVoltage != null
    ? Math.min(100, Math.max(0, Math.round(((battVoltage - 2.8) / (3.2 - 2.8)) * 100)))
    : null;
  const battColor = battPct == null ? "#9ca3af" : battPct <= 10 ? "#ef4444" : battPct <= 25 ? "#f97316" : battPct <= 50 ? "#f59e0b" : "#22c55e";
  const battIcon = battPct == null ? "battery-dead-outline" : battPct <= 10 ? "battery-dead" : battPct <= 25 ? "battery-dead-outline" : battPct <= 50 ? "battery-half" : "battery-full";

  return (
    <View style={[styles.card, { backgroundColor: theme.card }]}>
      <View style={[styles.cardAccent, { backgroundColor: theme.border }]} />
      <View style={styles.cardContent}>

        <View style={styles.cardTop}>
          <View style={[styles.deviceIcon, { backgroundColor: theme.inputBg }]}>
            <Ionicons name="hardware-chip" size={22} color={theme.subtext} />
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={[styles.deviceName, { color: theme.text }]}>{device.name || "Unnamed Device"}</Text>
              {!isOwner && (
                <View style={[styles.techBadge, { backgroundColor: "#e0f2fe" }]}>
                  <Ionicons name="construct-outline" size={10} color="#0284c7" />
                  <Text style={styles.techBadgeText}>Technician</Text>
                </View>
              )}
            </View>
            {device.hvac_location ? (
              <View style={styles.metaRow}><Ionicons name="location-outline" size={12} color={theme.subtext} /><Text style={[styles.metaText, { color: theme.subtext }]}>{device.hvac_location}</Text></View>
            ) : null}
            {device.device_mac ? (
              <View style={styles.metaRow}><Ionicons name="barcode-outline" size={12} color={theme.subtext} /><Text style={[styles.metaText, { color: theme.subtext }]}>{device.device_mac}</Text></View>
            ) : null}
          </View>
          <View style={{ alignItems: "flex-end", gap: 6 }}>
            <View style={[styles.statusBadge, { backgroundColor: statusColor + "20" }]}>
              <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
              <Text style={[styles.statusLabel, { color: statusColor }]}>{statusLabel}</Text>
            </View>
            {battPct != null && (
              <View style={styles.battBadge}>
                <Ionicons name={battIcon} size={13} color={battColor} />
                <Text style={[styles.battText, { color: battColor }]}>{battPct}%</Text>
              </View>
            )}
          </View>
        </View>

        {lastSeen && <Text style={[styles.lastSeen, { color: theme.subtext }]}>Last seen {timeAgo(lastSeen)}</Text>}

        {filterProgress && <FilterProgressBar pct={filterProgress.pct} daysLeft={filterProgress.daysLeft} theme={theme} />}
        <AcousticVerdictBadge mlVerdict={mlVerdict} />

        <View style={[styles.filterInfoRow, { backgroundColor: theme.inputBg }]}>
          <View style={styles.filterInfoItem}>
            <Ionicons name="time-outline" size={13} color={theme.subtext} />
            <Text style={[styles.filterInfoText, { color: theme.subtext }]}>Filter every {device.filter_interval_days || DEFAULT_FILTER_INTERVAL_DAYS}d</Text>
          </View>
          <View style={styles.filterInfoItem}>
            <Ionicons name="pulse-outline" size={13} color={theme.subtext} />
            <Text style={[styles.filterInfoText, { color: theme.subtext }]}>Wake interval {wakeLabel}</Text>
          </View>
          {device.tenant_email ? (
            <View style={styles.filterInfoItem}>
              <Ionicons name="person" size={13} color={theme.subtext} />
              <Text style={[styles.filterInfoText, { color: theme.subtext }]} numberOfLines={1}>{device.tenant_email}</Text>
            </View>
          ) : (
            <View style={styles.filterInfoItem}>
              <Ionicons name="person-outline" size={13} color={theme.subtext} />
              <Text style={[styles.filterInfoText, { color: theme.subtext }]}>No tenant</Text>
            </View>
          )}
        </View>

        {addedDate ? <Text style={[styles.deviceDate, { color: theme.subtext }]}>Added {addedDate}</Text> : null}

        <View style={styles.cardBtns}>
          <TouchableOpacity style={[styles.editBtn, { backgroundColor: theme.inputBg, borderWidth: 1, borderColor: theme.border }]} onPress={() => { haptic(); onEdit(device); }}>
            <Ionicons name="pencil" size={13} color={theme.subtext} />
            <Text style={[styles.editBtnText, { color: theme.subtext }]}>Edit</Text>
          </TouchableOpacity>
          {isOwner && (
            <TouchableOpacity style={[styles.editBtn, { backgroundColor: theme.inputBg, borderWidth: 1, borderColor: theme.border }]} onPress={() => { haptic(); onRecalibrate(device); }}>
              <Ionicons name="refresh" size={13} color={theme.subtext} />
              <Text style={[styles.editBtnText, { color: theme.subtext }]}>Recalibrate</Text>
            </TouchableOpacity>
          )}
          {isOwner && (
            <TouchableOpacity style={[styles.deleteBtn, { borderColor: "#fecaca", backgroundColor: theme.inputBg }]} onPress={() => { haptic(); onDelete(device); }}>
              <Ionicons name="remove-circle-outline" size={13} color="#ef4444" />
              <Text style={styles.deleteBtnText}>Remove</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function DevicesScreen() {
  const { session, technicianAssignments } = useAuth();
  const { theme, isDark } = useTheme();
  const [devices, setDevices] = useState([]);
  const [deviceStats, setDeviceStats] = useState({});
  const [filterInstallDates, setFilterInstallDates] = useState({});
  const [mlVerdicts, setMlVerdicts] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [claimVisible, setClaimVisible] = useState(false);
  const [editVisible, setEditVisible] = useState(false);
  const [editingDevice, setEditingDevice] = useState(null);

  const loadDevices = useCallback(async () => {
    const userId = session?.user?.id;
    if (!userId) return;

    const landlordIds = technicianAssignments.map(a => a.landlord_id);

    const [ownedResult, techResult] = await Promise.all([
      supabase.from("devices").select("*").eq("owner_id", userId).order("created_at", { ascending: false }),
      landlordIds.length > 0
        ? supabase.from("devices").select("*").in("owner_id", landlordIds).order("created_at", { ascending: false })
        : Promise.resolve({ data: [] }),
    ]);

    if (ownedResult.error) {
      setLoading(false);
      Alert.alert("Error", "Failed to load devices: " + ownedResult.error.message);
      return;
    }
    if (techResult.error) console.warn("loadDevices (technician):", techResult.error.message);

    const devs = [
      ...(ownedResult.data || []).map(d => ({ ...d, _isOwner: true })),
      ...(techResult.data || []).map(d => ({ ...d, _isOwner: false })),
    ];

    setDevices(devs);
    setLoading(false);

    if (devs.length > 0) {
      const stats = {};
      const installDates = {};
      const verdicts = {};
      await Promise.all(devs.map(async (dev) => {
        const { data: logs, error: logsError } = await supabase.from("sensor_logs")
          .select("recorded_at, battery")
          .eq("device_id", dev.id).order("recorded_at", { ascending: false }).limit(1);
        if (logsError) console.warn(`sensor_logs (${dev.id}):`, logsError.message);
        if (logs?.length > 0) stats[dev.id] = { lastSeen: logs[0].recorded_at, latestData: logs[0] };

        const { data: rfidLogs, error: rfidError } = await supabase.from("sensor_logs")
          .select("recorded_at, rfid").eq("device_id", dev.id)
          .not("rfid", "is", null).order("recorded_at", { ascending: false }).limit(100);
        if (rfidError) console.warn(`rfid logs (${dev.id}):`, rfidError.message);

        if (rfidLogs?.length > 0) {
          const currentRfid = rfidLogs[0].rfid;
          const allWithCurrent = rfidLogs.filter(r => r.rfid === currentRfid);
          const firstSeen = allWithCurrent[allWithCurrent.length - 1]?.recorded_at;
          if (firstSeen) installDates[dev.id] = firstSeen;
        }

        // Acoustic ML verdict is keyed by MAC (audio_logs.device_id), not
        // devices.id -- null for devices the poller hasn't processed yet.
        const verdict = await getLatestVerdict(dev.device_mac);
        if (verdict) verdicts[dev.id] = verdict;
      }));
      setDeviceStats(stats);
      setFilterInstallDates(installDates);
      setMlVerdicts(verdicts);
    }
  }, [session, technicianAssignments]);

  useEffect(() => { loadDevices(); }, [loadDevices]);

  const onRefresh = async () => { setRefreshing(true); await loadDevices(); setRefreshing(false); };

  const handleEdit = async (formData) => {
    // .select() makes RLS-blocked updates visible: 0 rows back = not saved
    const { data, error } = await supabase
      .from("devices")
      .update(formData)
      .eq("id", editingDevice.id)
      .select("id");
    if (error) { Alert.alert("Error", "Failed to update device: " + error.message); return; }
    if (!data || data.length === 0) {
      Alert.alert("Not Saved", "You don't have permission to edit this device.");
      return;
    }
    Alert.alert("Saved", "Device settings updated.");
    setEditVisible(false);
    loadDevices();
  };

  const handleDelete = (device) => {
    Alert.alert("Remove Device", `Remove "${device.name || device.device_mac}" from your account?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => {
        const { error } = await supabase.from("devices").update({ owner_id: null }).eq("id", device.id);
        if (error) Alert.alert("Error", "Failed to remove device");
        else loadDevices();
      }},
    ]);
  };

  const handleRecalibrate = (device) => {
    Alert.alert(
      "Recalibrate Microphone",
      `Reset the acoustic baseline for "${device.name || device.device_mac}"? Use this after moving the sensor, cleaning/replacing the mic, or installing a filter you know is clean. It will start relearning "normal" from scratch, so acoustic verdicts go quiet for a while until it warms back up.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Recalibrate", style: "destructive", onPress: async () => {
          // .select() makes RLS-blocked deletes visible: 0 rows back = not reset
          const { data, error } = await supabase
            .from("device_baselines")
            .delete()
            .eq("device_mac", device.device_mac)
            .select("device_mac");
          if (error) { Alert.alert("Error", "Failed to recalibrate: " + error.message); return; }
          if (!data || data.length === 0) {
            Alert.alert("Nothing To Reset", "This device has no existing baseline yet, or you don't have permission to reset it.");
            return;
          }
          Alert.alert("Recalibrating", "Baseline cleared. The next uploads will rebuild it from scratch.");
          loadDevices();
        }},
      ]
    );
  };

  const onlineCount = Object.values(deviceStats).filter(s => getOnlineStatus(s.lastSeen) === "online").length;
  const offlineCount = devices.length - onlineCount;
  const needsReplacementCount = devices.filter(d => {
    const fp = getFilterProgress(filterInstallDates[d.id], d.filter_interval_days || DEFAULT_FILTER_INTERVAL_DAYS);
    return fp && fp.pct >= 90;
  }).length;

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={[styles.header, { backgroundColor: theme.bg }]}>
        <View>
          <Text style={[styles.greeting, { color: theme.subtext }]}>Manage</Text>
          <Text style={[styles.headerTitle, { color: theme.text }]}>My Devices</Text>
        </View>
        <TouchableOpacity style={[styles.addBtn, { backgroundColor: theme.card, borderColor: theme.border, borderWidth: 1 }]} onPress={() => { haptic(); setClaimVisible(true); }}>
          <Ionicons name="add" size={20} color="#007BFF" />
          <Text style={styles.addBtnText}>Claim Device</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.statsBar, { backgroundColor: theme.card }]}>
        <View style={styles.statItem}>
          <Text style={[styles.statNumber, { color: theme.text }]}>{devices.length}</Text>
          <Text style={[styles.statLabel, { color: theme.subtext }]}>Total</Text>
        </View>
        <View style={[styles.statDivider, { backgroundColor: theme.divider }]} />
        <View style={styles.statItem}>
          <Text style={[styles.statNumber, { color: theme.text }]}>{onlineCount}</Text>
          <Text style={[styles.statLabel, { color: theme.subtext }]}>Online</Text>
        </View>
        <View style={[styles.statDivider, { backgroundColor: theme.divider }]} />
        <View style={styles.statItem}>
          <Text style={[styles.statNumber, { color: theme.text }]}>{offlineCount}</Text>
          <Text style={[styles.statLabel, { color: theme.subtext }]}>Offline</Text>
        </View>
        <View style={[styles.statDivider, { backgroundColor: theme.divider }]} />
        <View style={styles.statItem}>
          <Text style={[styles.statNumber, { color: needsReplacementCount > 0 ? "#f97316" : theme.text }]}>{needsReplacementCount}</Text>
          <Text style={[styles.statLabel, { color: theme.subtext }]}>Filter due</Text>
        </View>
      </View>

      {needsReplacementCount > 0 && (
        <View style={[styles.filterBanner, { backgroundColor: "#fff7ed", borderColor: "#fed7aa" }]}>
          <Ionicons name="warning" size={16} color="#f97316" />
          <Text style={styles.filterBannerText}>
            {needsReplacementCount} device{needsReplacementCount > 1 ? "s need" : " needs"} a filter replacement soon
          </Text>
        </View>
      )}

      {loading ? (
        <ActivityIndicator color="#007BFF" style={{ marginTop: 60 }} />
      ) : (
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#007BFF" />}>
          {(() => {
            const myDevices = devices.filter(d => d._isOwner);
            const techDevices = devices.filter(d => !d._isOwner);

            if (myDevices.length === 0 && techDevices.length === 0) {
              return (
                <View style={styles.empty}>
                  <View style={[styles.emptyIcon, { backgroundColor: theme.card }]}>
                    <Ionicons name="hardware-chip-outline" size={40} color="#007BFF" />
                  </View>
                  <Text style={[styles.emptyText, { color: theme.text }]}>No devices yet</Text>
                  <Text style={[styles.emptySubText, { color: theme.subtext }]}>Tap "Claim Device" and scan your device's QR code</Text>
                  <TouchableOpacity style={styles.emptyBtn} onPress={() => setClaimVisible(true)}>
                    <Text style={styles.emptyBtnText}>Claim Your First Device</Text>
                  </TouchableOpacity>
                </View>
              );
            }

            const cardProps = (d) => ({
              key: d.id, device: d, theme,
              lastSeen: deviceStats[d.id]?.lastSeen,
              latestData: deviceStats[d.id]?.latestData,
              filterInstalledAt: filterInstallDates[d.id],
              mlVerdict: mlVerdicts[d.id],
              isOwner: d._isOwner,
              onEdit: (dev) => { setEditingDevice(dev); setEditVisible(true); },
              onDelete: handleDelete,
              onRecalibrate: handleRecalibrate,
            });

            return (
              <>
                {myDevices.length > 0 && (
                  <>
                    {techDevices.length > 0 && (
                      <Text style={[styles.sectionLabel, { color: theme.subtext }]}>MY DEVICES</Text>
                    )}
                    {myDevices.map((d, i) => <DeviceCard key={d.id} index={i} {...cardProps(d)} />)}
                  </>
                )}

                {techDevices.length > 0 && (
                  <>
                    <View style={[styles.sectionHeader, { borderColor: theme.border }]}>
                      <Ionicons name="construct-outline" size={14} color="#0284c7" />
                      <Text style={[styles.sectionLabel, { color: "#0284c7", marginBottom: 0 }]}>MANAGED PROPERTIES</Text>
                    </View>
                    <Text style={[styles.sectionDesc, { color: theme.subtext }]}>
                      You can edit the name and location of these devices.
                    </Text>
                    {techDevices.map((d, i) => <DeviceCard key={d.id} index={i} {...cardProps(d)} />)}
                  </>
                )}
              </>
            );
          })()}
        </ScrollView>
      )}

      <ClaimDeviceModal visible={claimVisible} onClose={() => setClaimVisible(false)} onClaimed={() => { setClaimVisible(false); loadDevices(); }} theme={theme} />
      <EditDeviceModal visible={editVisible} device={editingDevice} onClose={() => setEditVisible(false)} onSave={handleEdit} theme={theme} isOwner={editingDevice?._isOwner ?? true} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", paddingHorizontal: 20, paddingTop: 56, paddingBottom: 16 },
  greeting: { fontSize: 13, fontWeight: "500" },
  headerTitle: { fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20 },
  addBtnText: { color: "#007BFF", fontWeight: "700", fontSize: 14 },
  statsBar: { flexDirection: "row", marginHorizontal: 20, borderRadius: 16, padding: 16, marginBottom: 12, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
  statItem: { flex: 1, alignItems: "center" },
  statNumber: { fontSize: 22, fontWeight: "800" },
  statLabel: { fontSize: 10, fontWeight: "600", marginTop: 2 },
  statDivider: { width: 1 },
  filterBanner: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 20, borderRadius: 12, padding: 12, marginBottom: 8, borderWidth: 1 },
  filterBannerText: { color: "#f97316", fontSize: 13, fontWeight: "600", flex: 1 },
  scroll: { paddingHorizontal: 20, paddingBottom: 40 },
  card: { borderRadius: 20, marginBottom: 14, flexDirection: "row", overflow: "hidden", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 10, elevation: 2 },
  cardAccent: { width: 4 },
  cardContent: { flex: 1, padding: 16, gap: 10 },
  cardTop: { flexDirection: "row", alignItems: "flex-start" },
  deviceIcon: { width: 44, height: 44, borderRadius: 14, justifyContent: "center", alignItems: "center", flexShrink: 0 },
  deviceName: { fontSize: 16, fontWeight: "700" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3 },
  metaText: { fontSize: 12, fontWeight: "500" },
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusLabel: { fontSize: 11, fontWeight: "700" },
  battBadge: { flexDirection: "row", alignItems: "center", gap: 3 },
  battText: { fontSize: 11, fontWeight: "700" },
  lastSeen: { fontSize: 11, fontWeight: "500" },
  filterInfoRow: { flexDirection: "row", borderRadius: 12, padding: 10, gap: 12 },
  filterInfoItem: { flexDirection: "row", alignItems: "center", gap: 4, flex: 1 },
  filterInfoText: { fontSize: 11, fontWeight: "600", flex: 1 },
  deviceDate: { fontSize: 11 },
  cardBtns: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  editBtn: { flexDirection: "row", alignItems: "center", gap: 5, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14 },
  editBtnText: { fontWeight: "700", fontSize: 13 },
  deleteBtn: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1.5, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14 },
  deleteBtnText: { color: "#ef4444", fontWeight: "700", fontSize: 13 },
  techBadge: { flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  techBadgeText: { fontSize: 10, fontWeight: "700", color: "#0284c7" },
  sectionLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.8, marginBottom: 8, marginTop: 8, marginHorizontal: 2 },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 16, marginBottom: 4, paddingTop: 16, borderTopWidth: 1 },
  sectionDesc: { fontSize: 12, marginBottom: 8, marginHorizontal: 2 },
  empty: { alignItems: "center", paddingTop: 60, gap: 10 },
  emptyIcon: { width: 80, height: 80, borderRadius: 24, justifyContent: "center", alignItems: "center", marginBottom: 8 },
  emptyText: { fontSize: 20, fontWeight: "800" },
  emptySubText: { fontSize: 14, textAlign: "center", paddingHorizontal: 40 },
  emptyBtn: { backgroundColor: "#007BFF", borderRadius: 14, paddingHorizontal: 24, paddingVertical: 14, marginTop: 8 },
  emptyBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});

const fpb = StyleSheet.create({
  container: { gap: 4 },
  labelRow: { flexDirection: "row", justifyContent: "space-between" },
  label: { fontSize: 11, fontWeight: "600" },
  right: { fontSize: 11, fontWeight: "700" },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3 },
  pct: { fontSize: 10, fontWeight: "500" },
});

const abadge = StyleSheet.create({
  container: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  text: { fontSize: 11, fontWeight: "700" },
});

const scanStyles = StyleSheet.create({
  cameraContainer: { width: "100%", height: 260, borderRadius: 16, overflow: "hidden", marginBottom: 16 },
  camera: { flex: 1 },
  scanOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: "center", alignItems: "center" },
  scanFrame: { width: 160, height: 160, position: "relative" },
  corner: { position: "absolute", width: 20, height: 20, borderColor: "#fff", borderWidth: 3 },
  cornerTL: { top: 0, left: 0, borderRightWidth: 0, borderBottomWidth: 0, borderTopLeftRadius: 4 },
  cornerTR: { top: 0, right: 0, borderLeftWidth: 0, borderBottomWidth: 0, borderTopRightRadius: 4 },
  cornerBL: { bottom: 0, left: 0, borderRightWidth: 0, borderTopWidth: 0, borderBottomLeftRadius: 4 },
  cornerBR: { bottom: 0, right: 0, borderLeftWidth: 0, borderTopWidth: 0, borderBottomRightRadius: 4 },
  torchBtn: { position: "absolute", top: 12, right: 12, width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center" },
  torchBtnOn: { backgroundColor: "#007BFF" },
  searchingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(255,255,255,0.85)", justifyContent: "center", alignItems: "center", gap: 12, borderRadius: 16 },
  searchingText: { fontSize: 15, fontWeight: "600" },
  rescanRow: { position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.6)", padding: 12, alignItems: "center" },
  rescanText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  permissionBox: { alignItems: "center", paddingVertical: 24, gap: 10, marginBottom: 16 },
  permissionText: { fontSize: 17, fontWeight: "700" },
  permissionSub: { fontSize: 13, textAlign: "center", lineHeight: 18 },
  grantBtn: { backgroundColor: "#007BFF", borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12, marginTop: 8 },
  grantBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  manualLink: { alignItems: "center", paddingVertical: 10 },
  manualLinkText: { fontSize: 13, fontWeight: "500", textDecorationLine: "underline" },
});

const modal = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  card: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 44 },
  handle: { width: 36, height: 4, backgroundColor: "#e5e7eb", borderRadius: 2, alignSelf: "center", marginBottom: 20 },
  title: { fontSize: 22, fontWeight: "800", marginBottom: 4 },
  subtitle: { fontSize: 14, marginBottom: 16 },
  sectionLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.8, marginBottom: 8, marginTop: 8 },
  fieldGroup: { borderRadius: 16, overflow: "hidden", marginBottom: 16 },
  fieldRow: { flexDirection: "row", alignItems: "center", padding: 16, gap: 12 },
  fieldIcon: { width: 36, height: 36, borderRadius: 10, justifyContent: "center", alignItems: "center" },
  divider: { height: 1, marginLeft: 64 },
  label: { fontSize: 11, fontWeight: "700", marginBottom: 4 },
  helperText: { fontSize: 11, marginTop: 2, marginBottom: 4 },
  input: { fontSize: 15, fontWeight: "500", padding: 0 },
  intervalRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  intervalInput: { width: 64, borderWidth: 1, borderRadius: 10, padding: 8, fontSize: 18, fontWeight: "800", textAlign: "center" },
  intervalUnit: { fontSize: 15, fontWeight: "600" },
  presetRow: { flexDirection: "row", gap: 8, padding: 12, paddingTop: 0 },
  preset: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: "center" },
  presetText: { fontSize: 13, fontWeight: "700" },
  btnRow: { flexDirection: "row", gap: 12, marginTop: 8 },
  cancelBtn: { flex: 1, borderWidth: 1.5, borderRadius: 14, padding: 16, alignItems: "center" },
  cancelText: { fontWeight: "700", fontSize: 15 },
  saveBtn: { flex: 1, backgroundColor: "#007BFF", borderRadius: 14, padding: 16, alignItems: "center" },
  disabledBtn: { backgroundColor: "#93c5fd" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});