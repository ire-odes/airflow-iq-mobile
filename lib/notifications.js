// lib/notifications.js
// ─────────────────────────────────────────────────────────────────────────────
// Push notification service for AirFlow IQ
// Handles: threshold alerts, filter status changes, device offline, filter due
// ─────────────────────────────────────────────────────────────────────────────

import * as Notifications from "expo-notifications";
import * as BackgroundFetch from "expo-background-fetch";
import * as TaskManager from "expo-task-manager";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import { DEFAULT_FILTER_INTERVAL_DAYS } from "./config";

// ── Constants ────────────────────────────────────────────────────────────────
const BACKGROUND_TASK = "AIRFLOW_BACKGROUND_CHECK";
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between same notification

const STORAGE_KEYS = {
  LAST_FILTER_STATUS:   "notif_last_filter_status",
  LAST_NOTIF_TIMES:     "notif_last_times",       // { [notifKey]: timestamp }
  THRESHOLDS:           "notif_thresholds",        // { temp_c: { enabled, min, max }, ... }
  DEVICE_LAST_SEEN:     "notif_device_last_seen",  // { [deviceId]: timestamp }
  PUSH_TOKEN:           "notif_push_token",
};

// ── Notification handler (foreground) ────────────────────────────────────────
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

// ── Permission request ────────────────────────────────────────────────────────
export async function requestNotificationPermissions() {
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === "granted") return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === "granted";
}

// ── Schedule a local notification (with cooldown) ────────────────────────────
async function sendNotification(key, title, body, data = {}) {
  const now = Date.now();
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.LAST_NOTIF_TIMES);
  const times = raw ? JSON.parse(raw) : {};

  if (times[key] && now - times[key] < COOLDOWN_MS) return; // cooldown active

  await Notifications.scheduleNotificationAsync({
    content: { title, body, data, sound: true },
    trigger: null, // immediate
  });

  times[key] = now;
  await AsyncStorage.setItem(STORAGE_KEYS.LAST_NOTIF_TIMES, JSON.stringify(times));
}

// ── Save/load thresholds from AsyncStorage ────────────────────────────────────
export async function saveThresholds(thresholds) {
  await AsyncStorage.setItem(STORAGE_KEYS.THRESHOLDS, JSON.stringify(thresholds));
}

export async function loadThresholds() {
  const raw = await AsyncStorage.getItem(STORAGE_KEYS.THRESHOLDS);
  return raw ? JSON.parse(raw) : {};
}

// ── Core check function ──────────────────────────────────────────────────────
export async function runNotificationChecks(userId) {
  if (!userId) return;

  try {
    // 1. Get user's devices
    const { data: devices, error: devicesError } = await supabase
      .from("devices")
      .select("id, name, filter_interval_days")
      .eq("owner_id", userId);

    if (devicesError) { console.warn("runNotificationChecks devices:", devicesError.message); return; }
    if (!devices || devices.length === 0) return;

    const deviceIds = devices.map(d => d.id);

    // 2. Get latest sensor log per device
    const { data: latestLogs, error: logsError } = await supabase
      .from("sensor_logs")
      .select("device_id, recorded_at, temp_c, humidity, pressure_pa, windspeed")
      .in("device_id", deviceIds)
      .order("recorded_at", { ascending: false })
      .limit(deviceIds.length * 2);

    if (logsError) console.warn("runNotificationChecks logs:", logsError.message);

    // 3. Get RFID data for filter checks
    const { data: rfidLogs, error: rfidError } = await supabase
      .from("sensor_logs")
      .select("recorded_at, rfid, device_id")
      .in("device_id", deviceIds)
      .not("rfid", "is", null)
      .order("recorded_at", { ascending: false })
      .limit(50);
    if (rfidError) console.warn("runNotificationChecks rfid:", rfidError.message);

    const thresholds = await loadThresholds();

    // ── Check each device ─────────────────────────────────────────────────
    for (const device of devices) {
      const log = latestLogs?.find(l => l.device_id === device.id);
      const deviceName = device.name || "Your device";

      // ── A. Device offline check ─────────────────────────────────────────
      if (log?.recorded_at) {
        const lastSeenRaw = await AsyncStorage.getItem(STORAGE_KEYS.DEVICE_LAST_SEEN);
        const lastSeenMap = lastSeenRaw ? JSON.parse(lastSeenRaw) : {};
        const lastSeenTs = new Date(log.recorded_at.replace(" ", "T")).getTime();
        const diffMins = (Date.now() - lastSeenTs) / 60000;

        if (diffMins > 30) {
          await sendNotification(
            `offline_${device.id}`,
            `📡 ${deviceName} is offline`,
            `No data received in ${Math.round(diffMins)} minutes. Check your device connection.`,
            { type: "offline", deviceId: device.id }
          );
        }

        lastSeenMap[device.id] = lastSeenTs;
        await AsyncStorage.setItem(STORAGE_KEYS.DEVICE_LAST_SEEN, JSON.stringify(lastSeenMap));
      }

      // ── B. Threshold alerts ─────────────────────────────────────────────
      if (log) {
        const checks = [
          { key: "temp_c",      label: "Temperature", value: parseFloat(log.temp_c),      unit: "°C" },
          { key: "humidity",    label: "Humidity",     value: parseFloat(log.humidity),    unit: "%" },
          { key: "pressure_pa", label: "Pressure",     value: parseFloat(log.pressure_pa), unit: " Pa" },
          { key: "windspeed",   label: "Wind Speed",   value: parseFloat(log.windspeed),   unit: " m/s" },
        ];

        for (const check of checks) {
          const t = thresholds[check.key];
          if (!t?.enabled || isNaN(check.value)) continue;

          const min = parseFloat(t.min);
          const max = parseFloat(t.max);

          if (!isNaN(min) && check.value < min) {
            await sendNotification(
              `threshold_low_${device.id}_${check.key}`,
              `⚠️ Low ${check.label} — ${deviceName}`,
              `${check.label} is ${check.value.toFixed(1)}${check.unit}, below your minimum of ${min}${check.unit}.`,
              { type: "threshold", metric: check.key, deviceId: device.id }
            );
          } else if (!isNaN(max) && check.value > max) {
            await sendNotification(
              `threshold_high_${device.id}_${check.key}`,
              `⚠️ High ${check.label} — ${deviceName}`,
              `${check.label} is ${check.value.toFixed(1)}${check.unit}, above your maximum of ${max}${check.unit}.`,
              { type: "threshold", metric: check.key, deviceId: device.id }
            );
          }
        }
      }
    }

    // ── C. Filter status change ───────────────────────────────────────────
    // Detect RFID changes across all devices
    if (rfidLogs && rfidLogs.length > 0) {
      const lastRfid = rfidLogs[0].rfid;
      const prevLastRfid = rfidLogs.find(l => l.rfid !== lastRfid)?.rfid;

      if (prevLastRfid && lastRfid !== prevLastRfid) {
        const lastKnown = await AsyncStorage.getItem(STORAGE_KEYS.LAST_FILTER_STATUS);
        if (lastKnown !== lastRfid) {
          await sendNotification(
            "filter_changed",
            "🔄 Filter Change Detected",
            "A new HVAC filter has been detected. Your filter tracking has been updated.",
            { type: "filter_change" }
          );
          await AsyncStorage.setItem(STORAGE_KEYS.LAST_FILTER_STATUS, lastRfid);
        }
      }
    }

    // ── D. Filter due for replacement (per device, using its own interval) ──
    if (rfidLogs && rfidLogs.length > 0) {
      for (const device of devices) {
        const deviceLogs = rfidLogs.filter(l => l.device_id === device.id);
        if (deviceLogs.length === 0) continue;

        // Find when this device's current filter was first detected
        const currentRfid = deviceLogs[0].rfid;
        const allWithCurrent = deviceLogs.filter(l => l.rfid === currentRfid);
        const firstSeen = allWithCurrent[allWithCurrent.length - 1]?.recorded_at;
        if (!firstSeen) continue;

        const daysSince = Math.floor(
          (Date.now() - new Date(firstSeen.replace(" ", "T")).getTime()) / 86400000
        );
        const dueDays = device.filter_interval_days || DEFAULT_FILTER_INTERVAL_DAYS;

        if (daysSince >= dueDays) {
          const overdueBy = daysSince - dueDays;
          const urgency = overdueBy >= 14
            ? { emoji: "🚨", level: "immediately" }
            : { emoji: "🔔", level: "soon" };

          await sendNotification(
            `filter_due_${device.id}`,
            `${urgency.emoji} Filter Replacement Due — ${device.name || "Your device"}`,
            `This filter has been installed for ${daysSince} days (interval: ${dueDays} days). Replace it ${urgency.level}.`,
            { type: "filter_due", deviceId: device.id, daysSince }
          );
        }
      }
    }

  } catch (e) {
    console.error("Notification check error:", e);
  }
}

// ── Background task definition ────────────────────────────────────────────────
TaskManager.defineTask(BACKGROUND_TASK, async () => {
  try {
    // Get stored userId from AsyncStorage (set on login)
    const userId = await AsyncStorage.getItem("current_user_id");
    if (!userId) return BackgroundFetch.BackgroundFetchResult.NoData;

    await runNotificationChecks(userId);
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch (e) {
    console.error("Background task error:", e);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// ── Register background fetch (call after login) ─────────────────────────────
export async function registerBackgroundFetch() {
  try {
    await BackgroundFetch.registerTaskAsync(BACKGROUND_TASK, {
      minimumInterval: 15 * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
    console.log("✅ Background fetch registered");
  } catch (e) {
    // Silently fails in Expo Go — works in production builds
    console.log("Background fetch unavailable:", e.message);
  }
}