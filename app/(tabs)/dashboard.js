import React, { useState, useEffect, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Dimensions, RefreshControl, Modal, Linking, Alert,
} from "react-native";
import { BarChart, LineChart } from "react-native-gifted-charts";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { GEMINI_API_KEY, DEFAULT_FILTER_INTERVAL_DAYS } from "../../lib/config";

const SCREEN_WIDTH = Dimensions.get("window").width;

// ── Unit conversion helpers ───────────────────────────────────────────────────
const cToF = (c) => (c == null ? null : c * 9 / 5 + 32);
const paToHpa = (pa) => (pa == null ? null : pa / 100);

// Convert a raw DB value to display value for a given metric key
function toDisplay(key, raw) {
  if (raw == null) return null;
  if (key === "temp_c") return cToF(raw);
  if (key === "pressure_pa") return paToHpa(raw);
  return raw;
}

// Convert a display value back to raw (for chart y-axis when needed)
// Not needed here since we convert chart data inline.

let Haptics = null;
try { Haptics = require("expo-haptics"); } catch (_) {}
const haptic = () => { try { Haptics?.impactAsync(Haptics.ImpactFeedbackStyle?.Light); } catch (_) {} };

// All possible metrics — units and normalRanges are now in DISPLAY units
const ALL_METRICS = [
  { label: "Temperature",        key: "temp_c",            unit: "°F",    icon: "thermometer",              color: "#FF6B6B", normalRange: [64, 79],          decimals: 1 },
  { label: "Humidity",           key: "humidity",          unit: "%",     icon: "water",                    color: "#45B7D1", normalRange: [30, 60],          decimals: 1 },
  { label: "Pressure",           key: "pressure_pa",       unit: " hPa",  icon: "speedometer",              color: "#4ECDC4", normalRange: [980, 1020],       decimals: 1 },
  { label: "Wind Speed",         key: "windSpeed",         unit: " m/s",  icon: "partly-sunny",             color: "#96CEB4", normalRange: [0.5, 5],          decimals: 1 },
  { label: "Volumetric Airflow", key: "volumetricAirflow", unit: " m³/s", icon: "arrow-forward-circle",     color: "#a78bfa", normalRange: [0.01, 0.5],       decimals: 4, computed: true },
  { label: "Air Density",        key: "airDensity",        unit: " kg/m³",icon: "layers",                   color: "#34d399", normalRange: [1.1, 1.3],        decimals: 3, computed: true },
  { label: "Dew Point",          key: "dewPoint",          unit: "°F",    icon: "water-outline",            color: "#60a5fa", normalRange: [32, 59],          decimals: 1, computed: true },
  { label: "Comfort Index",      key: "comfortIndex",      unit: "/100",  icon: "happy-outline",            color: "#f472b6", normalRange: [70, 100],         decimals: 0, computed: true },
];

const METRICS = ALL_METRICS.filter(m => !m.computed);

const DEFAULT_CARD_KEYS = ["temp_c", "humidity", "pressure_pa", "windSpeed"];
const CARDS_STORAGE_KEY = "dashboard_metric_card_keys";

const TIME_RANGES = [
  { label: "24H", hours: 24,  bucket: "hour" },
  { label: "7D",  hours: 168, bucket: "day"  },
  { label: "30D", hours: 720, bucket: "day"  },
];

const FILTER_RANGES = ["D", "W", "M", "Y"];

async function callGemini(prompt) {
  if (!GEMINI_API_KEY) return null;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.4 },
      }),
    }
  );
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

// ── HVAC Calculations (still takes raw SI values internally) ─────────────────
function computeHvacMetrics(avg, ductArea = 0.1) {
  const T = avg.temp_c, RH = avg.humidity, P = avg.pressure_pa, v = avg.windSpeed;
  if (T == null || RH == null || P == null || v == null) return null;
  const Psat = 610.78 * Math.exp((17.27 * T) / (T + 237.3));
  const Pv = (RH / 100) * Psat;
  const Pd = P - Pv;
  const specificHumidity = (0.622 * Pv) / Pd;
  const absoluteHumidity = (Pv * 18.016) / (8.314 * (T + 273.15)) * 1000;
  const Rspecific = (287.058 * (1 + 1.608 * specificHumidity)) / (1 + specificHumidity);
  const airDensity = P / (Rspecific * (T + 273.15));
  const enthalpy = 1.006 * T + specificHumidity * (2501 + 1.86 * T);
  const dewPoint = (237.3 * Math.log(Pv / 610.78)) / (17.27 - Math.log(Pv / 610.78));
  const wetBulb = T * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) + Math.atan(T + RH) - Math.atan(RH - 1.676331) + 0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH) - 4.686035;
  const volumetricAirflow = v * ductArea;
  const massAirflow = airDensity * volumetricAirflow;
  const cp = 1.006 + 1.86 * specificHumidity;
  const sensibleHeatRate = massAirflow * cp * 1.0;
  const comfortScore = Math.max(0, 100 - Math.abs(T - 22) * 4 - Math.abs(RH - 45) * 1.2);
  // dewPoint displayed in °F
  const dewPointF = cToF(dewPoint);
  const wetBulbF = cToF(wetBulb);
  return {
    dewPoint:         { value: dewPointF.toFixed(1),                    unit: "°F",    label: "Dew Point",           icon: "water-outline",                description: "Temperature at which moisture condenses. If near room temp, humidity is very high." },
    wetBulb:          { value: wetBulbF.toFixed(1),                     unit: "°F",    label: "Wet Bulb Temp",       icon: "thermometer-outline",          description: "Lowest temp achievable by evaporative cooling. Key for HVAC system sizing." },
    absoluteHumidity: { value: absoluteHumidity.toFixed(2),             unit: " g/m³", label: "Absolute Humidity",   icon: "cloud-outline",                description: "Actual mass of water vapour per cubic metre of air." },
    specificHumidity: { value: (specificHumidity * 1000).toFixed(2),    unit: " g/kg", label: "Specific Humidity",   icon: "partly-sunny-outline",         description: "Mass of water vapour per kg of dry air. Used in HVAC load calculations." },
    airDensity:       { value: airDensity.toFixed(4),                   unit: " kg/m³",label: "Air Density",         icon: "layers-outline",               description: "Denser air carries more heat and moisture. Affects fan and duct efficiency." },
    enthalpy:         { value: enthalpy.toFixed(1),                     unit: " kJ/kg",label: "Enthalpy",            icon: "flash-outline",                description: "Total heat content of moist air. Used to size HVAC equipment." },
    volumetricAirflow:{ value: volumetricAirflow.toFixed(4),            unit: " m³/s", label: "Volumetric Airflow",  icon: "arrow-forward-circle-outline", description: `Estimated volume of air moving per second (duct area: ${ductArea} m²).` },
    massAirflow:      { value: massAirflow.toFixed(4),                  unit: " kg/s", label: "Mass Airflow",        icon: "speedometer-outline",          description: "Mass of air moving per second. Determines heating/cooling capacity." },
    sensibleHeat:     { value: sensibleHeatRate.toFixed(4),             unit: " kW",   label: "Sensible Heat Rate",  icon: "sunny-outline",                description: "Rate of heat transfer for a 1°C delta T. Baseline for system sizing." },
    comfortIndex:     { value: comfortScore.toFixed(0),                 unit: "/100",  label: "Comfort Index",       icon: "happy-outline",                description: "Combined temp + humidity comfort score. 80+ is ideal, below 50 needs attention." },
  };
}

// ── Edit Metric Cards Modal ───────────────────────────────────────────────────
function EditMetricCardsModal({ visible, onClose, activeKeys, onSave, theme, isDark }) {
  const [keys, setKeys] = useState(activeKeys);
  useEffect(() => { if (visible) setKeys(activeKeys); }, [visible]);

  const toggle = (key) => {
    setKeys(prev =>
      prev.includes(key) ? (prev.length > 1 ? prev.filter(k => k !== key) : prev) : [...prev, key]
    );
  };

  const moveUp = (idx) => {
    if (idx === 0) return;
    setKeys(prev => { const a = [...prev]; [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]]; return a; });
  };
  const moveDown = (idx) => {
    setKeys(prev => {
      if (idx >= prev.length - 1) return prev;
      const a = [...prev]; [a[idx], a[idx + 1]] = [a[idx + 1], a[idx]]; return a;
    });
  };

  return (
    <Modal visible={visible} animationType="slide" transparent presentationStyle="overFullScreen">
      <TouchableOpacity style={editModal.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1}>
          <View style={[editModal.sheet, { backgroundColor: theme.card }]}>
            <View style={editModal.handle} />
            <View style={editModal.header}>
              <Text style={[editModal.title, { color: theme.text }]}>Edit Metric Cards</Text>
              <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={theme.subtext} /></TouchableOpacity>
            </View>
            <Text style={[editModal.sub, { color: theme.subtext }]}>Tap to toggle · arrows to reorder</Text>

            <Text style={[editModal.sectionLabel, { color: theme.subtext }]}>ACTIVE</Text>
            {keys.map((key, idx) => {
              const m = ALL_METRICS.find(x => x.key === key);
              if (!m) return null;
              return (
                <View key={key} style={[editModal.row, { backgroundColor: m.color + "18", borderColor: m.color + "40" }]}>
                  <View style={[editModal.colorDot, { backgroundColor: m.color }]} />
                  <View style={[editModal.iconBg, { backgroundColor: m.color + "25" }]}>
                    <Ionicons name={m.icon} size={16} color={m.color} />
                  </View>
                  <Text style={[editModal.rowLabel, { color: theme.text }]}>{m.label}</Text>
                  <Text style={[editModal.rowUnit, { color: theme.subtext }]}>{m.unit.trim()}</Text>
                  <View style={editModal.rowActions}>
                    <TouchableOpacity onPress={() => { haptic(); moveUp(idx); }} style={editModal.arrowBtn}>
                      <Ionicons name="chevron-up" size={16} color={idx === 0 ? theme.border : theme.subtext} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => { haptic(); moveDown(idx); }} style={editModal.arrowBtn}>
                      <Ionicons name="chevron-down" size={16} color={idx === keys.length - 1 ? theme.border : theme.subtext} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => { haptic(); toggle(key); }} style={[editModal.removeBtn, { backgroundColor: "#ef444420" }]}>
                      <Ionicons name="remove" size={14} color="#ef4444" />
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}

            <Text style={[editModal.sectionLabel, { color: theme.subtext, marginTop: 16 }]}>ADD METRIC</Text>
            <ScrollView style={{ maxHeight: 220 }} showsVerticalScrollIndicator={false}>
              {ALL_METRICS.filter(m => !keys.includes(m.key)).map(m => (
                <TouchableOpacity key={m.key} style={[editModal.row, { backgroundColor: theme.inputBg, borderColor: theme.border }]} onPress={() => { haptic(); toggle(m.key); }} activeOpacity={0.7}>
                  <View style={[editModal.colorDot, { backgroundColor: m.color }]} />
                  <View style={[editModal.iconBg, { backgroundColor: m.color + "25" }]}>
                    <Ionicons name={m.icon} size={16} color={m.color} />
                  </View>
                  <Text style={[editModal.rowLabel, { color: theme.text }]}>{m.label}</Text>
                  <Text style={[editModal.rowUnit, { color: theme.subtext }]}>{m.unit.trim()}</Text>
                  {m.computed && (
                    <View style={[editModal.computedBadge, { backgroundColor: "#6366f120" }]}>
                      <Text style={editModal.computedBadgeText}>computed</Text>
                    </View>
                  )}
                  <TouchableOpacity onPress={() => { haptic(); toggle(m.key); }} style={[editModal.removeBtn, { backgroundColor: "#22c55e20", marginLeft: "auto" }]}>
                    <Ionicons name="add" size={14} color="#22c55e" />
                  </TouchableOpacity>
                </TouchableOpacity>
              ))}
            </ScrollView>

            <TouchableOpacity style={editModal.saveBtn} onPress={() => { haptic(); onSave(keys); onClose(); }}>
              <Text style={editModal.saveBtnText}>Save</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}


function SkeletonBox({ width, height, style, theme }) {
  return (
    <View style={[{ width, height, borderRadius: 12, backgroundColor: theme.divider, opacity: 0.5 }, style]} />
  );
}

function MetricCardSkeleton({ theme }) {
  const cardSize = (SCREEN_WIDTH - 48) / 2;
  return (
    <View style={[skelStyles.squareCard, { backgroundColor: theme.card, width: cardSize, height: cardSize }]}>
      <SkeletonBox width={32} height={32} style={{ borderRadius: 10 }} theme={theme} />
      <SkeletonBox width={70} height={10} style={{ marginTop: 12 }} theme={theme} />
      <SkeletonBox width={90} height={32} style={{ marginTop: 8 }} theme={theme} />
      <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
        <SkeletonBox width={50} height={9} theme={theme} />
        <SkeletonBox width={50} height={9} theme={theme} />
      </View>
    </View>
  );
}

function ChartSkeleton({ theme }) {
  return (
    <View style={[skelStyles.chartCard, { backgroundColor: theme.card }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <SkeletonBox width={10} height={10} style={{ borderRadius: 5 }} theme={theme} />
        <SkeletonBox width={100} height={14} theme={theme} />
      </View>
      <SkeletonBox width="100%" height={200} style={{ borderRadius: 12 }} theme={theme} />
      <View style={{ flexDirection: "row", justifyContent: "space-around", marginTop: 16 }}>
        <SkeletonBox width={60} height={32} theme={theme} />
        <SkeletonBox width={60} height={32} theme={theme} />
        <SkeletonBox width={60} height={32} theme={theme} />
      </View>
    </View>
  );
}

function ErrorCard({ message, onRetry, theme }) {
  return (
    <View style={[errStyles.card, { backgroundColor: theme.card, borderColor: "#fecaca" }]}>
      <Ionicons name="alert-circle" size={28} color="#ef4444" />
      <View style={{ flex: 1 }}>
        <Text style={[errStyles.title, { color: theme.text }]}>Something went wrong</Text>
        <Text style={[errStyles.msg, { color: theme.subtext }]}>{message}</Text>
      </View>
      <TouchableOpacity style={errStyles.retryBtn} onPress={() => { haptic(); onRetry(); }}>
        <Text style={errStyles.retryText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

function getStatusLabel(curr, prev) {
  if (curr == null || prev == null || prev === 0) return "Normal";
  const pct = ((curr - prev) / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 5) return "Normal";
  return pct > 5 ? "Above Average" : "Below Average";
}
function getStatusColor(s) {
  if (s === "Normal") return "#22c55e";
  if (s === "Above Average") return "#f59e0b";
  return "#45B7D1";
}
function getRangeStatus(v, r) {
  if (v == null || !r) return "normal";
  if (v > r[1]) return "high";
  if (v < r[0]) return "low";
  return "normal";
}
function getWeekNumber(d) {
  const j = new Date(d.getFullYear(), 0, 1);
  return Math.ceil((((d - j) / 86400000) + j.getDay() + 1) / 7);
}
function formatTimestamp(ts) {
  if (!ts) return "—";
  const d = new Date(ts.replace ? ts.replace(" ", "T") : ts);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function timeAgo(ts) {
  if (!ts) return null;
  const d = new Date(ts.replace ? ts.replace(" ", "T") : ts);
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return "Morning"; if (h < 17) return "Afternoon"; return "Evening";
}
function formatIntervalLabel(rangeHours, off) {
  const now = new Date();
  const end = new Date(now.getTime() - off * rangeHours * 3600000);
  const start = new Date(end.getTime() - rangeHours * 3600000);
  const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  if (rangeHours === 24) return end.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (rangeHours === 168) { const sm = M[start.getMonth()], em = M[end.getMonth()]; return start.getMonth() === end.getMonth() ? `${sm} ${start.getDate()} – ${end.getDate()}` : `${sm} ${start.getDate()} – ${em} ${end.getDate()}`; }
  if (rangeHours === 720) return M[start.getMonth()] + " " + start.getFullYear();
  return `${M[start.getMonth()]} – ${M[end.getMonth()]} ${end.getFullYear()}`;
}

// ── Metric Detail Modal ───────────────────────────────────────────────────────
// FIX: accepts displayLatest, displayAvg, displayMin, displayMax already converted
function MetricDetailModal({ metric, displayAvg, displayLatest, displayMin, displayMax, pct, visible, onClose, theme, isDark }) {
  if (!metric) return null;
  const rs = getRangeStatus(displayLatest, metric.normalRange);
  const rsc = rs === "high" ? "#ef4444" : rs === "low" ? "#45B7D1" : "#22c55e";
  const rsl = rs === "high" ? "Above Normal Range" : rs === "low" ? "Below Normal Range" : "Within Normal Range";
  const isUp = pct != null && pct >= 0;
  return (
    <Modal visible={visible} animationType="slide" transparent presentationStyle="overFullScreen">
      <TouchableOpacity style={mst.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}}>
          <View style={[mst.card, { backgroundColor: theme.card }]}>
            <View style={mst.handle} />
            <View style={mst.header}>
              <View style={[mst.iconBg, { backgroundColor: metric.color + "20" }]}><Ionicons name={metric.icon} size={24} color={metric.color} /></View>
              <View style={{ flex: 1 }}><Text style={[mst.title, { color: theme.text }]}>{metric.label}</Text><Text style={[mst.unit, { color: theme.subtext }]}>{metric.unit}</Text></View>
              <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={theme.subtext} /></TouchableOpacity>
            </View>
            <View style={[mst.latestCard, { backgroundColor: metric.color }]}>
              <Text style={mst.latestLabel}>Latest Reading</Text>
              <Text style={mst.latestValue}>{displayLatest != null ? `${displayLatest.toFixed(metric.decimals ?? 1)}${metric.unit}` : "—"}</Text>
              <View style={[mst.rsBadge, { backgroundColor: "rgba(255,255,255,0.25)" }]}>
                <Ionicons name={rs === "normal" ? "checkmark-circle" : "warning"} size={12} color="#fff" />
                <Text style={mst.rsText}>{rsl}</Text>
              </View>
            </View>
            <View style={[mst.statsGrid, { backgroundColor: theme.inputBg }]}>
              <View style={mst.statCell}><Text style={[mst.statLabel, { color: theme.subtext }]}>Average</Text><Text style={[mst.statValue, { color: theme.text }]}>{displayAvg != null ? `${displayAvg.toFixed(metric.decimals ?? 1)}${metric.unit}` : "—"}</Text></View>
              <View style={[mst.statDivV, { backgroundColor: theme.divider }]} />
              <View style={mst.statCell}><Text style={[mst.statLabel, { color: theme.subtext }]}>Min</Text><Text style={[mst.statValue, { color: "#45B7D1" }]}>{displayMin != null ? `${displayMin.toFixed(metric.decimals ?? 1)}${metric.unit}` : "—"}</Text></View>
              <View style={[mst.statDivV, { backgroundColor: theme.divider }]} />
              <View style={mst.statCell}><Text style={[mst.statLabel, { color: theme.subtext }]}>Max</Text><Text style={[mst.statValue, { color: "#ef4444" }]}>{displayMax != null ? `${displayMax.toFixed(metric.decimals ?? 1)}${metric.unit}` : "—"}</Text></View>
            </View>
            {pct != null && (
              <View style={[mst.changeRow, { backgroundColor: isDark ? "#1a2035" : "#f8f9fa", borderColor: theme.border }]}>
                <Ionicons name={isUp ? "trending-up" : "trending-down"} size={18} color={isUp ? "#f59e0b" : "#45B7D1"} />
                <Text style={[mst.changeText, { color: theme.text }]}><Text style={{ fontWeight: "800", color: isUp ? "#f59e0b" : "#45B7D1" }}>{isUp ? "+" : ""}{pct.toFixed(1)}%</Text>{" "}vs previous period</Text>
              </View>
            )}
            <View style={[mst.normalRangeRow, { borderColor: theme.border }]}>
              <Text style={[mst.nrLabel, { color: theme.subtext }]}>Normal range</Text>
              <Text style={[mst.nrValue, { color: theme.text }]}>{metric.normalRange[0]}{metric.unit} – {metric.normalRange[1]}{metric.unit}</Text>
            </View>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

// ── Advanced HVAC Modal ───────────────────────────────────────────────────────
function AdvancedModal({ visible, onClose, averages, ductArea, theme, isDark }) {
  const hvac = averages.temp_c != null ? computeHvacMetrics(averages, ductArea) : null;
  const entries = hvac ? Object.values(hvac) : [];
  return (
    <Modal visible={visible} animationType="slide" transparent presentationStyle="overFullScreen">
      <View style={adv.overlay}>
        <View style={[adv.card, { backgroundColor: theme.bg }]}>
          <View style={[adv.header, { backgroundColor: theme.card, borderBottomColor: theme.divider }]}>
            <View>
              <Text style={[adv.title, { color: theme.text }]}>Advanced HVAC</Text>
              <Text style={[adv.subtitle, { color: theme.subtext }]}>Derived from current sensor averages</Text>
            </View>
            <TouchableOpacity style={[adv.closeBtn, { backgroundColor: theme.inputBg }]} onPress={() => { haptic(); onClose(); }}>
              <Ionicons name="close" size={20} color={theme.subtext} />
            </TouchableOpacity>
          </View>
          {hvac == null ? (
            <View style={adv.empty}>
              <Ionicons name="calculator-outline" size={40} color={theme.border} />
              <Text style={[adv.emptyText, { color: theme.subtext }]}>No data available yet</Text>
            </View>
          ) : (
            <ScrollView contentContainerStyle={adv.scroll} showsVerticalScrollIndicator={false}>
              <View style={[adv.infoBox, { backgroundColor: theme.inputBg, borderColor: theme.border }]}>
                <Ionicons name="information-circle" size={16} color={theme.subtext} />
                <Text style={[adv.infoText, { color: theme.subtext }]}>
                  All values derived from sensor data. Duct area: {ductArea} m² (set in Account).
                </Text>
              </View>
              {entries.map((item, i) => (
                <View key={i} style={[adv.row, { backgroundColor: theme.card, borderColor: theme.border }]}>
                  <View style={[adv.rowIcon, { backgroundColor: theme.inputBg }]}><Ionicons name={item.icon} size={20} color="#6366f1" /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={[adv.rowLabel, { color: theme.subtext }]}>{item.label}</Text>
                    <Text style={[adv.rowValue, { color: theme.text }]}>{item.value}<Text style={[adv.rowUnit, { color: theme.subtext }]}>{item.unit}</Text></Text>
                    <Text style={[adv.rowDesc, { color: theme.subtext }]}>{item.description}</Text>
                  </View>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

export default function DashboardScreen() {
  const { session } = useAuth();
  const { theme, isDark } = useTheme();
  const router = useRouter();

  const [devices, setDevices] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [selectedRangeIndex, setSelectedRangeIndex] = useState(0);
  const [offsetMultiplier, setOffsetMultiplier] = useState(0);
  const [selectedMetric, setSelectedMetric] = useState(METRICS[0]);
  const [chartData, setChartData] = useState([]);
  const [rawStats, setRawStats] = useState({ min: null, max: null, lastTs: null });
  const [latestReadings, setLatestReadings] = useState({});
  const [averages, setAverages] = useState({});
  const [prevAverages, setPrevAverages] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showDevicePicker, setShowDevicePicker] = useState(false);
  // FIX: track selected bar by index, not object reference, to avoid stale closures
  const [selectedBarIndex, setSelectedBarIndex] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [expandedMetric, setExpandedMetric] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [ductArea, setDuctArea] = useState(0.1);
  const [activeCardKeys, setActiveCardKeys] = useState(DEFAULT_CARD_KEYS);
  const [showEditCards, setShowEditCards] = useState(false);
  const [metricStats, setMetricStats] = useState({});

  const [chartError, setChartError] = useState(null);
  const [avgError, setAvgError] = useState(null);

  const [aiInsight, setAiInsight] = useState(null);
  const [aiInsightLoading, setAiInsightLoading] = useState(false);

  const [filterChanges, setFilterChanges] = useState([]);
  const [filterRange, setFilterRange] = useState("M");
  const [showFilterHistory, setShowFilterHistory] = useState(false);
  const [filterBarData, setFilterBarData] = useState([]);
  const [currentRfid, setCurrentRfid] = useState(null);
  const [filterInstalledAt, setFilterInstalledAt] = useState(null);
  const [lastFilterChange, setLastFilterChange] = useState(null);

  const [predictedDaysLeft, setPredictedDaysLeft] = useState(null);
  const [avgFilterLifespan, setAvgFilterLifespan] = useState(null);

  const selectedRange = TIME_RANGES[selectedRangeIndex];
  const isLineChart = selectedRange.hours === 24;

  useFocusEffect(useCallback(() => {
  if (!session?.user?.id) return; // ← guard
  fetchDevices();
  fetchFilterData();
  fetchLatestReadings();
  loadDuctArea();
  loadCardKeys();
}, [session?.user?.id])); // ← add session as dependency

  useEffect(() => { fetchData(); fetchAverages(); setSelectedBarIndex(null); }, [selectedDevice, selectedRangeIndex, offsetMultiplier, selectedMetric]);
  useEffect(() => { buildFilterBarData(); }, [filterChanges, filterRange]);
  useEffect(() => {
    if (GEMINI_API_KEY && Object.keys(averages).length > 0) { setAiInsight(null); runAiInsight(); }
  }, [averages, selectedRangeIndex]);
  useEffect(() => { computePrediction(); }, [filterChanges, filterInstalledAt]);

  // FIX: clear selectedBar when switching chart types to avoid stale touch state
  const handleRangeChange = (i) => {
    haptic();
    setSelectedRangeIndex(i);
    setOffsetMultiplier(0);
    setSelectedBarIndex(null);
    setChartData([]);  // clear immediately so chart remounts cleanly
  };

  const loadDuctArea = async () => {
    try {
      const AsyncStorage = require("@react-native-async-storage/async-storage").default;
      const val = await AsyncStorage.getItem("duct_area");
      if (val) setDuctArea(parseFloat(val));
    } catch (_) {}
  };

  const loadCardKeys = async () => {
    try {
      const AsyncStorage = require("@react-native-async-storage/async-storage").default;
      const val = await AsyncStorage.getItem(CARDS_STORAGE_KEY);
      if (val) {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed) && parsed.length > 0) setActiveCardKeys(parsed);
      }
    } catch (_) {}
  };

  const saveCardKeys = async (keys) => {
    setActiveCardKeys(keys);
    try {
      const AsyncStorage = require("@react-native-async-storage/async-storage").default;
      await AsyncStorage.setItem(CARDS_STORAGE_KEY, JSON.stringify(keys));
    } catch (_) {}
  };

  const getTimeWindow = () => {
    const rangeMs = selectedRange.hours * 3600000;
    const offsetMs = offsetMultiplier * rangeMs;
    const now = Date.now();
    const windowEnd = now - offsetMs;
    const windowStart = windowEnd - rangeMs;
    return { start: new Date(windowStart).toISOString(), end: new Date(windowEnd).toISOString(), windowStart: new Date(windowStart).toISOString() };
  };

  const getUserDeviceIds = async () => {
    const userId = session?.user?.id;
    if (!userId) return [];
    const { data, error } = await supabase.from("devices").select("id").eq("owner_id", userId);
    if (error) console.warn("getUserDeviceIds:", error.message);
    return (data || []).map((d) => d.id);
  };

  const fetchDevices = async () => {
    const userId = session?.user?.id;
    if (!userId) return;
    const { data, error } = await supabase
      .from("devices")
      .select("id, name, hvac_location, tenant_email, filter_interval_days")
      .eq("owner_id", userId);
    if (error) { console.warn("fetchDevices:", error.message); return; }
    const list = data || [];
    setDevices(list);
    if (list.length > 0) {
      setSelectedDevice(prev => prev ?? list[0].id);
    }
  };

  // FIX: added battery to the latest readings fetch
  const fetchLatestReadings = async () => {
    const deviceIds = await getUserDeviceIds();
    if (deviceIds.length === 0) return;
    const { data, error } = await supabase.from("sensor_logs")
      .select("temp_c, humidity, pressure_pa, windSpeed, recorded_at")
      .in("device_id", deviceIds)
      .order("recorded_at", { ascending: false })
      .limit(1);
    if (error) { console.warn("fetchLatestReadings:", error.message); return; }
    if (data && data.length > 0) {
      setLatestReadings({
        temp_c: parseFloat(data[0].temp_c),
        humidity: parseFloat(data[0].humidity),
        pressure_pa: parseFloat(data[0].pressure_pa),
        windSpeed: parseFloat(data[0].windSpeed),
        recorded_at: data[0].recorded_at,
      });
    }
  };

  const fetchFilterData = async () => {
    const deviceIds = await getUserDeviceIds();
    if (deviceIds.length === 0) return;
    const { data, error } = await supabase.from("sensor_logs").select("recorded_at, rfid, device_id")
      .in("device_id", deviceIds).not("rfid", "is", null).neq("rfid", "").order("recorded_at", { ascending: true });
    if (error) { console.warn("fetchFilterData:", error.message); return; }
    if (!data || data.length === 0) return;
    const latest = [...data].reverse().find((r) => r.rfid);
    const currRfid = latest?.rfid || null;
    setCurrentRfid(currRfid);
    if (currRfid) {
      setFilterInstalledAt(data.find((r) => r.rfid === currRfid)?.recorded_at || null);
      setLastFilterChange([...data].reverse().find((r) => r.rfid && r.rfid !== currRfid)?.recorded_at || null);
    }
    const changes = []; let lastRfid = null;
    data.forEach((row) => {
      if (row.rfid && row.rfid !== lastRfid) {
        if (lastRfid !== null) changes.push({ changed_at: row.recorded_at, rfid: row.rfid, device_id: row.device_id });
        lastRfid = row.rfid;
      }
    });
    setFilterChanges(changes.reverse());
  };

  const computePrediction = () => {
    if (!filterInstalledAt) { setPredictedDaysLeft(null); setAvgFilterLifespan(null); return; }
    const daysSinceInstall = Math.floor(
      (Date.now() - new Date(filterInstalledAt.replace(" ", "T")).getTime()) / 86400000
    );
    if (filterChanges.length >= 2) {
      const lifespans = [];
      for (let i = 0; i < filterChanges.length - 1; i++) {
        const curr = new Date(filterChanges[i].changed_at.replace(" ", "T"));
        const next = new Date(filterChanges[i + 1].changed_at.replace(" ", "T"));
        const days = Math.abs(Math.floor((curr - next) / 86400000));
        if (days > 0 && days < 730) lifespans.push(days);
      }
      if (lifespans.length > 0) {
        const avg = Math.round(lifespans.reduce((s, v) => s + v, 0) / lifespans.length);
        setAvgFilterLifespan(avg);
        setPredictedDaysLeft(Math.max(0, avg - daysSinceInstall));
        return;
      }
    }
    const intervalDays = devices[0]?.filter_interval_days || DEFAULT_FILTER_INTERVAL_DAYS;
    setAvgFilterLifespan(intervalDays);
    setPredictedDaysLeft(Math.max(0, intervalDays - daysSinceInstall));
  };

  const buildFilterBarData = () => {
    const now = new Date(); let slots = []; let bucketFn;
    if (filterRange === "D") { for (let i = 6; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i); slots.push({ label: `${d.getMonth()+1}/${d.getDate()}`, key: d.toDateString(), count: 0 }); } bucketFn = (c) => new Date(c.changed_at.replace(" ", "T")).toDateString(); }
    else if (filterRange === "W") { for (let i = 7; i >= 0; i--) { const d = new Date(now); d.setDate(d.getDate() - i * 7); const wk = `W${getWeekNumber(d)}`; slots.push({ label: wk, key: wk, count: 0 }); } bucketFn = (c) => `W${getWeekNumber(new Date(c.changed_at.replace(" ", "T")))}`; }
    else if (filterRange === "M") { for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); const key = `${d.getFullYear()}-${d.getMonth()}`; slots.push({ label: d.toLocaleString("en-US", { month: "short" }), key, count: 0 }); } bucketFn = (c) => { const d = new Date(c.changed_at.replace(" ", "T")); return `${d.getFullYear()}-${d.getMonth()}`; }; }
    else { for (let i = 4; i >= 0; i--) { const yr = now.getFullYear() - i; slots.push({ label: `${yr}`, key: `${yr}`, count: 0 }); } bucketFn = (c) => `${new Date(c.changed_at.replace(" ", "T")).getFullYear()}`; }
    filterChanges.forEach((c) => { const key = bucketFn(c); const slot = slots.find((s) => s.key === key); if (slot) slot.count++; });
    setFilterBarData(slots.map((s) => ({ value: s.count, label: s.label, frontColor: s.count > 0 ? "#007BFF" : (isDark ? "#2a2d3e" : "#e5e7eb"), labelTextStyle: { color: theme.subtext, fontSize: 9 } })));
  };

  const fetchData = async () => {
    setLoading(true);
    setChartError(null);
    try {
      let deviceIds = selectedDevice ? [selectedDevice] : await getUserDeviceIds();
      if (deviceIds.length === 0) { setChartData([]); setLoading(false); return; }
      const { start, end } = getTimeWindow();

      if (isLineChart) {
        const { data, error } = await supabase.from("sensor_logs")
          .select(`recorded_at, ${selectedMetric.key}`)
          .in("device_id", deviceIds).gte("recorded_at", start).lte("recorded_at", end)
          .order("recorded_at", { ascending: true }).limit(500);
        if (error) { setChartError(error.message); setLoading(false); return; }
        if (!data || data.length === 0) { setChartData([]); setRawStats({ min: null, max: null, lastTs: null }); setLoading(false); return; }

        // Convert raw values to display units before charting
        const rawVals = data.map(r => parseFloat(r[selectedMetric.key])).filter(v => !isNaN(v));
        const displayVals = rawVals.map(v => toDisplay(selectedMetric.key, v));
        const minRaw = rawVals.length ? Math.min(...rawVals) : null;
        const maxRaw = rawVals.length ? Math.max(...rawVals) : null;
        setRawStats({
          min: toDisplay(selectedMetric.key, minRaw),
          max: toDisplay(selectedMetric.key, maxRaw),
          lastTs: data[data.length - 1]?.recorded_at || null,
        });
        setLastUpdated(new Date().toISOString());

        const mean = displayVals.reduce((s, v) => s + v, 0) / displayVals.length;
        const stdDev = Math.sqrt(displayVals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / displayVals.length);
        const step = Math.max(1, Math.floor(data.length / 80));
        const sampled = data.filter((_, i) => i % step === 0);

        setChartData(sampled.map((row, i) => {
          const rawVal = parseFloat(row[selectedMetric.key]) || 0;
          const val = toDisplay(selectedMetric.key, rawVal) ?? rawVal;
          const z = stdDev > 0 ? (val - mean) / stdDev : 0;
          const isAnomaly = Math.abs(z) > 1.5;
          const d = new Date(row.recorded_at.replace ? row.recorded_at.replace(" ", "T") : row.recorded_at);
          return {
            value: val,
            dataPointColor: isAnomaly ? (z > 0 ? "#ef4444" : "#45B7D1") : selectedMetric.color,
            dataPointRadius: isAnomaly ? 5 : 3,
            label: i % Math.ceil(sampled.length / 6) === 0 ? `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}` : "",
            labelTextStyle: { color: theme.subtext, fontSize: 9, width: 36, textAlign: "center" },
          };
        }));
      } else {
        const { data, error } = await supabase.rpc("get_chart_data", {
          p_device_ids: deviceIds,
          p_metric: selectedMetric.key,
          p_start: start,
          p_end: end,
          p_bucket: selectedRange.bucket,
        });
        if (error) { setChartError(error.message); setLoading(false); return; }
        if (!data || data.length === 0) { setChartData([]); setRawStats({ min: null, max: null, lastTs: null }); setLoading(false); return; }

        // Convert to display units
        const allDisplayAvgs = data.map(r => toDisplay(selectedMetric.key, r.avg_val)).filter(v => v != null);
        const mean = allDisplayAvgs.reduce((s, v) => s + v, 0) / allDisplayAvgs.length;
        const stdDev = Math.sqrt(allDisplayAvgs.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / allDisplayAvgs.length);

        setRawStats({
          min: toDisplay(selectedMetric.key, Math.min(...data.map(r => r.min_val).filter(v => v != null))),
          max: toDisplay(selectedMetric.key, Math.max(...data.map(r => r.max_val).filter(v => v != null))),
          lastTs: data[data.length - 1]?.bucket || null,
        });
        setLastUpdated(new Date().toISOString());

        setChartData(data.map(r => {
          const val = toDisplay(selectedMetric.key, r.avg_val) ?? 0;
          const z = stdDev > 0 ? (val - mean) / stdDev : 0;
          const barColor = Math.abs(z) > 1.5 ? (z > 0 ? "#ef4444" : "#45B7D1") : selectedMetric.color;
          const d = new Date(r.bucket);
          const label = selectedRange.hours === 168
            ? ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()]
            : `${d.getMonth()+1}/${d.getDate()}`;
          return { value: val, label, frontColor: barColor, labelTextStyle: { color: theme.subtext, fontSize: 10 } };
        }));
      }
    } catch (e) { setChartError(e.message || "Failed to load chart data"); }
    setLoading(false);
  };

  const fetchAverages = async () => {
    setAvgError(null);
    try {
      let deviceIds = selectedDevice ? [selectedDevice] : await getUserDeviceIds();
      if (deviceIds.length === 0) return;
      const { start, end } = getTimeWindow();
      const rangeMs = selectedRange.hours * 3600000;
      const prevStart = new Date(new Date(start).getTime() - rangeMs).toISOString();
      const { data: current, error } = await supabase.from("sensor_logs")
        .select("temp_c, humidity, pressure_pa, windSpeed")
        .in("device_id", deviceIds).gte("recorded_at", start).lte("recorded_at", end);
      if (error) { setAvgError(error.message); return; }
      if (!current || current.length === 0) { setAverages({}); setMetricStats({}); return; }

      const avg = (arr, key) => { const vals = arr.map(r => parseFloat(r[key])).filter(v => !isNaN(v) && v !== 0); return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null; };
      const minV = (arr, key) => { const vals = arr.map(r => parseFloat(r[key])).filter(v => !isNaN(v)); return vals.length ? Math.min(...vals) : null; };
      const maxV = (arr, key) => { const vals = arr.map(r => parseFloat(r[key])).filter(v => !isNaN(v)); return vals.length ? Math.max(...vals) : null; };

      // Raw SI averages (used for HVAC calculations internally)
      const avgs = {
        temp_c: avg(current, "temp_c"),
        pressure_pa: avg(current, "pressure_pa"),
        humidity: avg(current, "humidity"),
        windSpeed: avg(current, "windSpeed"),
      };
      setAverages(avgs);

      // metricStats stores DISPLAY values
      const stats = {};
      ["temp_c", "pressure_pa", "humidity", "windSpeed"].forEach(key => {
        const rawAvg = avgs[key];
        const rawMin = minV(current, key);
        const rawMax = maxV(current, key);
        stats[key] = {
          avg: toDisplay(key, rawAvg),
          min: toDisplay(key, rawMin),
          max: toDisplay(key, rawMax),
        };
      });

      if (avgs.temp_c != null && avgs.humidity != null && avgs.pressure_pa != null && avgs.windSpeed != null) {
        const hvac = computeHvacMetrics(avgs, ductArea);
        if (hvac) {
          stats["volumetricAirflow"] = { avg: parseFloat(hvac.volumetricAirflow.value), min: null, max: null };
          stats["airDensity"]        = { avg: parseFloat(hvac.airDensity.value),        min: null, max: null };
          stats["dewPoint"]          = { avg: parseFloat(hvac.dewPoint.value),           min: null, max: null };
          stats["comfortIndex"]      = { avg: parseFloat(hvac.comfortIndex.value),       min: null, max: null };
        }
      }
      setMetricStats(stats);

      const { data: prev } = await supabase.from("sensor_logs")
        .select("temp_c, humidity, pressure_pa, windSpeed")
        .in("device_id", deviceIds).gte("recorded_at", prevStart).lt("recorded_at", start);
      if (prev && prev.length > 0) {
        setPrevAverages({
          temp_c: avg(prev, "temp_c"),
          pressure_pa: avg(prev, "pressure_pa"),
          humidity: avg(prev, "humidity"),
          windSpeed: avg(prev, "windSpeed"),
        });
      } else setPrevAverages({});
    } catch (e) { setAvgError(e.message || "Failed to load averages"); }
  };

  const runAiInsight = async () => {
    if (!averages.temp_c || aiInsightLoading) return;
    setAiInsightLoading(true);
    try {
      const result = await callGemini(`You are an HVAC data analyst. Given these sensor averages for the last ${selectedRange.label}, write a 2-sentence plain English insight. Be specific with numbers. Be concise and friendly. Mention if anything looks unusual.\n\nAverages: Temp ${cToF(averages.temp_c)?.toFixed(1)}°F, Humidity ${averages.humidity?.toFixed(1)}%, Pressure ${paToHpa(averages.pressure_pa)?.toFixed(1)} hPa, Wind Speed ${averages.windSpeed?.toFixed(1)} m/s\nPrevious: Temp ${cToF(prevAverages.temp_c)?.toFixed(1) || "N/A"}°F, Humidity ${prevAverages.humidity?.toFixed(1) || "N/A"}%, Pressure ${paToHpa(prevAverages.pressure_pa)?.toFixed(1) || "N/A"} hPa\n\n2 sentences max. No bullet points.`);
      setAiInsight(result);
    } catch (e) { console.error(e); }
    setAiInsightLoading(false);
  };

  // Percent change is computed on raw values (dimensionless ratio — same in any unit)
  const getPercentChange = (key) => {
    const curr = averages[key], prev = prevAverages[key];
    if (curr == null || prev == null || prev === 0) return null;
    return ((curr - prev) / Math.abs(prev)) * 100;
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true); setAiInsight(null);
    await Promise.all([fetchData(), fetchAverages(), fetchFilterData(), fetchLatestReadings()]);
    setLastUpdated(new Date().toISOString());
    setRefreshing(false);
  }, [selectedDevice, selectedRangeIndex, offsetMultiplier, selectedMetric]);

  const currentDeviceName = devices.find((d) => d.id === selectedDevice)?.name || "—";
  const overallStatus = getStatusLabel(averages[selectedMetric.key], prevAverages[selectedMetric.key]);
  const statusColor = getStatusColor(overallStatus);
  const intervalLabel = formatIntervalLabel(selectedRange.hours, offsetMultiplier);
  const vals = chartData.map(d => d.value).filter(v => v > 0);
  const minVal = vals.length ? Math.min(...vals) : 0;
  const maxVal = vals.length ? Math.max(...vals) : 100;
  const yPadding = (maxVal - minVal) * 0.2 || 1;
  const barMinVal = Math.max(0, minVal - yPadding * 2);
  const barMaxVal = maxVal + yPadding;
  const barWidth = selectedRange.hours === 168 ? 40 : selectedRange.hours === 720 ? 52 : 72;
  const chartLegend = isLineChart ? "" : selectedRange.hours === 168 ? "Daily averages" : selectedRange.hours === 720 ? "Weekly averages" : "Monthly averages";
  const daysSinceInstall = filterInstalledAt ? Math.floor((Date.now() - new Date(filterInstalledAt.replace(" ", "T"))) / 86400000) : null;
  const expandedMetricObj = ALL_METRICS.find(m => m.key === expandedMetric?.key);

  const predColor = predictedDaysLeft != null
    ? predictedDaysLeft <= 7 ? "#ef4444" : predictedDaysLeft <= 30 ? "#f97316" : predictedDaysLeft <= 60 ? "#f59e0b" : "#22c55e"
    : "#9ca3af";

  // FIX: derive selectedBar from index to avoid stale object references
  const selectedBar = selectedBarIndex != null ? chartData[selectedBarIndex] : null;

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={[styles.header, { backgroundColor: theme.bg }]}>
        <View>
          <Text style={[styles.greeting, { color: theme.subtext }]}>Good {getTimeOfDay()}</Text>
          <Text style={[styles.headerTitle, { color: theme.text }]}>Dashboard</Text>
        </View>
        <TouchableOpacity
          style={[styles.devicePill, { backgroundColor: isDark ? "#1c2a3a" : "#EBF5FF" }]}
          onPress={() => { if (devices.length > 1) { haptic(); setShowDevicePicker(!showDevicePicker); } }}
          activeOpacity={devices.length > 1 ? 0.7 : 1}
        >
          <Ionicons name="hardware-chip-outline" size={14} color="#007BFF" />
          <Text style={styles.devicePillText} numberOfLines={1}>{currentDeviceName}</Text>
          {devices.length > 1 && <Ionicons name="chevron-down" size={14} color="#007BFF" />}
        </TouchableOpacity>
      </View>

      {showDevicePicker && devices.length > 1 && (
        <View style={[styles.pickerDropdown, { backgroundColor: theme.card, borderColor: theme.border }]}>
          {devices.map((d) => (
            <TouchableOpacity key={d.id} style={[styles.pickerItem, { borderBottomColor: theme.divider }]} onPress={() => { haptic(); setSelectedDevice(d.id); setShowDevicePicker(false); }}>
              <Text style={[styles.pickerItemText, { color: theme.subtext }, selectedDevice === d.id && { color: "#007BFF", fontWeight: "700" }]}>{d.name}{d.hvac_location ? ` · ${d.hvac_location}` : ""}</Text>
              {selectedDevice === d.id && <Ionicons name="checkmark" size={16} color="#007BFF" />}
            </TouchableOpacity>
          ))}
        </View>
      )}

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        // FIX: key forces the outer ScrollView to remount when range changes,
        // clearing any stale gesture recognizer state from nested ScrollViews
        key={`scroll-${selectedRangeIndex}`}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#007BFF" />}
      >



        {/* AI Insight */}
        {(aiInsight || aiInsightLoading) && (
          <View style={[styles.insightCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <View style={styles.insightHeader}>
              <View style={[styles.insightBadge, { backgroundColor: isDark ? "#2a2d3e" : "#f1f5f9" }]}><Ionicons name="sparkles" size={12} color={theme.subtext} /><Text style={[styles.insightBadgeText, { color: theme.subtext }]}>AI Insight · {selectedRange.label}</Text></View>
              {lastUpdated && <Text style={[styles.lastUpdated, { color: theme.subtext }]}>Updated {timeAgo(lastUpdated)}</Text>}
            </View>
            {aiInsightLoading ? (
              <View style={styles.insightLoading}><ActivityIndicator size="small" color="#6366f1" /><Text style={[styles.insightLoadingText, { color: theme.subtext }]}>Analyzing your data...</Text></View>
            ) : (
              <Text style={[styles.insightText, { color: theme.text }]}>{aiInsight}</Text>
            )}
          </View>
        )}

        {/* Range pills */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.timeRow}>
          {TIME_RANGES.map((t, i) => (
            <TouchableOpacity key={t.label} style={[styles.timePill, { backgroundColor: theme.pillBg }, selectedRangeIndex === i && { backgroundColor: theme.pillActiveBg }]} onPress={() => handleRangeChange(i)}>
              <Text style={[styles.timePillText, { color: theme.subtext }, selectedRangeIndex === i && { color: theme.pillActiveText }]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Interval nav */}
        <View style={[styles.intervalNav, { backgroundColor: theme.card }]}>
          <TouchableOpacity style={styles.arrowBtn} onPress={() => { haptic(); setOffsetMultiplier(o => o + 1); }}>
            <Ionicons name="chevron-back" size={20} color="#007BFF" />
          </TouchableOpacity>
          <Text style={[styles.intervalLabel, { color: theme.text }]}>{intervalLabel}</Text>
          <TouchableOpacity style={[styles.arrowBtn, offsetMultiplier === 0 && styles.arrowDisabled]} onPress={() => { haptic(); setOffsetMultiplier(o => Math.max(0, o - 1)); }} disabled={offsetMultiplier === 0}>
            <Ionicons name="chevron-forward" size={20} color={offsetMultiplier === 0 ? theme.subtext : "#007BFF"} />
          </TouchableOpacity>
        </View>

        {/* Metric selector */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.metricRow}>
          {METRICS.map((m) => (
            <TouchableOpacity key={m.key} style={[styles.metricPill, { backgroundColor: theme.pillBg, borderColor: theme.border }, selectedMetric.key === m.key && { backgroundColor: m.color, borderColor: m.color }]} onPress={() => { haptic(); setSelectedMetric(m); }}>
              <Ionicons name={m.icon} size={14} color={selectedMetric.key === m.key ? "#fff" : theme.subtext} />
              <Text style={[styles.metricPillText, { color: theme.subtext }, selectedMetric.key === m.key && { color: "#fff" }]}>{m.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Chart */}
        {loading ? (
          <ChartSkeleton theme={theme} />
        ) : chartError ? (
          <ErrorCard message={chartError} onRetry={fetchData} theme={theme} />
        ) : (
          <View style={[styles.chartCard, { backgroundColor: theme.card }]}>
            <View style={styles.chartHeader}>
              <View style={[styles.chartDot, { backgroundColor: selectedMetric.color }]} />
              <Text style={[styles.chartTitle, { color: theme.text }]}>{selectedMetric.label}</Text>
              <View style={[styles.statusBadge, { backgroundColor: statusColor + "20" }]}>
                <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                <Text style={[styles.statusBadgeText, { color: statusColor }]}>{overallStatus}</Text>
              </View>
            </View>

            {chartData.length > 0 ? (
              <>
                {/*
                  FIX: key on the inner ScrollView forces it to remount when
                  isLineChart or selectedRangeIndex changes. This releases any
                  captured gesture recognizers that were preventing touch
                  propagation to the outer ScrollView and sibling touchables.
                */}
                <ScrollView
                  key={`chart-scroll-${isLineChart}-${selectedRangeIndex}`}
                  horizontal
                  showsHorizontalScrollIndicator={false}
                >
                  {isLineChart ? (
                    <LineChart
                      data={chartData}
                      width={Math.max(SCREEN_WIDTH - 80, chartData.length * 14)}
                      height={220}
                      color={selectedMetric.color}
                      thickness={2}
                      curved
                      dataPointsColor={selectedMetric.color}
                      dataPointsRadius={3}
                      startFillColor={selectedMetric.color}
                      endFillColor={theme.card}
                      startOpacity={0.15}
                      endOpacity={0}
                      areaChart
                      backgroundColor={theme.card}
                      yAxisColor="transparent"
                      xAxisColor={theme.divider}
                      yAxisTextStyle={{ color: theme.subtext, fontSize: 10 }}
                      xAxisLabelTextStyle={{ color: theme.subtext, fontSize: 9 }}
                      rulesColor={theme.divider}
                      rulesType="dashed"
                      noOfSections={5}
                      showVerticalLines={false}
                      yAxisLabelSuffix={selectedMetric.unit}
                      yAxisLabelWidth={55}
                      maxValue={maxVal + yPadding}
                      minValue={Math.max(0, minVal - yPadding)}
                      initialSpacing={16}
                      endSpacing={16}
                    />
                  ) : (
                    <BarChart
                      data={chartData}
                      width={Math.max(SCREEN_WIDTH - 80, chartData.length * 60)}
                      height={220}
                      barWidth={36}
                      spacing={16}
                      roundedTop={false}
                      xAxisColor="transparent"
                      yAxisColor="transparent"
                      yAxisTextStyle={{ color: theme.subtext, fontSize: 10 }}
                      rulesColor={theme.divider}
                      rulesType="dashed"
                      noOfSections={5}
                      maxValue={barMaxVal}
                      minValue={barMinVal}
                      yAxisLabelSuffix={selectedMetric.unit}
                      yAxisLabelWidth={55}
                      backgroundColor={theme.card}
                      barBorderRadius={8}
                      isAnimated
                      labelsExtraHeight={20}
                      xAxisLabelTextStyle={{ color: theme.subtext, fontSize: 10, textAlign: "center" }}
                      onPress={(item, index) => { haptic(); setSelectedBarIndex(index); }}
                    />
                  )}
                </ScrollView>

                {!isLineChart && selectedBar && (
                  <View style={[styles.barTooltip, { backgroundColor: isDark ? "#2a2d3e" : "#f8f9fa", borderColor: theme.border }]}>
                    <Text style={[styles.barTooltipLabel, { color: theme.subtext }]}>{selectedBar.label}</Text>
                    <Text style={[styles.barTooltipValue, { color: selectedBar.frontColor || selectedMetric.color }]}>{selectedBar.value?.toFixed(2)}{selectedMetric.unit}</Text>
                  </View>
                )}

                <View style={[styles.statsRow, { borderTopColor: theme.divider }]}>
                  <View style={styles.statItem}><Text style={[styles.statItemLabel, { color: theme.subtext }]}>Min</Text><Text style={[styles.statItemValue, { color: "#45B7D1" }]}>{rawStats.min != null ? `${rawStats.min.toFixed(1)}${selectedMetric.unit}` : "—"}</Text></View>
                  <View style={[styles.statDivider, { backgroundColor: theme.divider }]} />
                  <View style={styles.statItem}><Text style={[styles.statItemLabel, { color: theme.subtext }]}>Max</Text><Text style={[styles.statItemValue, { color: "#ef4444" }]}>{rawStats.max != null ? `${rawStats.max.toFixed(1)}${selectedMetric.unit}` : "—"}</Text></View>
                  <View style={[styles.statDivider, { backgroundColor: theme.divider }]} />
                  <View style={styles.statItem}><Text style={[styles.statItemLabel, { color: theme.subtext }]}>Last reading</Text><Text style={[styles.statItemValue, { color: theme.text }]}>{rawStats.lastTs ? timeAgo(rawStats.lastTs) : "—"}</Text></View>
                </View>

                {!isLineChart && (
                  <View style={styles.anomalyLegend}>
                    <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: selectedMetric.color }]} /><Text style={[styles.legendText, { color: theme.subtext }]}>Normal</Text></View>
                    <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: "#ef4444" }]} /><Text style={[styles.legendText, { color: theme.subtext }]}>High</Text></View>
                    <View style={styles.legendItem}><View style={[styles.legendDot, { backgroundColor: "#45B7D1" }]} /><Text style={[styles.legendText, { color: theme.subtext }]}>Low</Text></View>
                    <Text style={[styles.chartLegend, { color: theme.subtext }]}>{chartLegend}</Text>
                  </View>
                )}
                {isLineChart && <Text style={[styles.chartLegend, { color: theme.subtext }]}>{chartLegend}</Text>}
              </>
            ) : (
              <View style={styles.chartPlaceholder}>
                <Ionicons name="bar-chart-outline" size={32} color={theme.border} />
                <Text style={[styles.noDataText, { color: theme.subtext }]}>No data for this period</Text>
              </View>
            )}
          </View>
        )}

        {/* Metrics section header */}
        <View style={styles.metricsSectionHeader}>
          <View>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>My Metrics</Text>
            <Text style={[styles.sectionSubtitle, { color: theme.subtext }]}>Tap any card for details</Text>
          </View>
          <TouchableOpacity style={[styles.editCardsBtn, { backgroundColor: theme.inputBg, borderColor: theme.border }]} onPress={() => { haptic(); setShowEditCards(true); }}>
            <Ionicons name="pencil-outline" size={15} color={theme.subtext} />
            <Text style={[styles.editCardsBtnText, { color: theme.subtext }]}>Edit</Text>
          </TouchableOpacity>
        </View>

        {/* Metric cards — 2-column square grid */}
        <View style={styles.metricsGrid}>
          {loading ? (
            Array.from({ length: activeCardKeys.length || 4 }).map((_, i) => (
              <MetricCardSkeleton key={i} theme={theme} />
            ))
          ) : avgError ? (
            <ErrorCard message={avgError} onRetry={fetchAverages} theme={theme} />
          ) : (
            activeCardKeys.map((key) => {
              const m = ALL_METRICS.find(x => x.key === key);
              if (!m) return null;
              const stats = metricStats[key]; // already in display units
              const dispAvg = stats?.avg;
              const dispMin = stats?.min;
              const dispMax = stats?.max;
              // FIX: convert latest reading to display unit for the card
              const dispLatest = toDisplay(key, latestReadings[key]);
              const pct = getPercentChange(key);
              const isUp = pct != null && pct >= 0;
              const rangeStatus = getRangeStatus(dispAvg, m.normalRange);
              const showAlert = rangeStatus !== "normal";
              const dec = m.decimals ?? 1;
              const cardSize = (SCREEN_WIDTH - 48) / 2;
              return (
                <TouchableOpacity
                  key={key}
                  style={[styles.metricSquare, { backgroundColor: m.color, width: cardSize, minHeight: cardSize }]}
                  onPress={() => {
                    haptic();
                    // FIX: for computed metrics, open the modal directly without
                    // switching selectedMetric (which only covers DB-backed metrics)
                    const chartM = METRICS.find(x => x.key === key);
                    setExpandedMetric(m);  // always set — use ALL_METRICS entry
                    if (chartM) setSelectedMetric(chartM);
                  }}
                  activeOpacity={0.85}
                >
                  {showAlert && <View style={styles.alertDot} />}
                  <View style={styles.squareTop}>
                    <View style={styles.squareIconBg}>
                      <Ionicons name={m.icon} size={16} color="#fff" />
                    </View>
                    <Text style={styles.squareLabel} numberOfLines={1}>{m.label}</Text>
                    {pct != null && (
                      <View style={[styles.squarePctBadge, { backgroundColor: isUp ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.15)" }]}>
                        <Ionicons name={isUp ? "arrow-up" : "arrow-down"} size={9} color="#fff" />
                        <Text style={styles.squarePctText}>{Math.abs(pct).toFixed(1)}%</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.squareAvgValue} numberOfLines={1} adjustsFontSizeToFit>
                    {dispAvg != null ? dispAvg.toFixed(dec) : "—"}
                  </Text>
                  <Text style={styles.squareUnit}>{m.unit.trim()}<Text style={styles.squareAvgLabel}> avg</Text></Text>
                  <View style={styles.squareMinMax}>
                    <View style={styles.squareMinMaxItem}>
                      <Text style={styles.squareMinMaxLabel}>MIN</Text>
                      <Text style={styles.squareMinMaxValue}>{dispMin != null ? dispMin.toFixed(dec) : "—"}</Text>
                    </View>
                    <View style={styles.squareMinMaxDivider} />
                    <View style={styles.squareMinMaxItem}>
                      <Text style={styles.squareMinMaxLabel}>MAX</Text>
                      <Text style={styles.squareMinMaxValue}>{dispMax != null ? dispMax.toFixed(dec) : "—"}</Text>
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })
          )}
        </View>

        {/* Filter Status */}
        <Text style={[styles.sectionTitle, { color: theme.text, marginTop: 24 }]}>Filter Status</Text>

        {predictedDaysLeft != null && (
          <View style={[styles.predCard, { backgroundColor: theme.card, borderColor: predColor + "40" }]}>
            <View style={[styles.predIconBg, { backgroundColor: predColor + "20" }]}>
              <Ionicons name="time-outline" size={22} color={predColor} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.predTitle, { color: theme.text }]}>
                {predictedDaysLeft === 0 ? "Replace filter now" : `~${predictedDaysLeft} days until replacement`}
              </Text>
              <Text style={[styles.predSub, { color: theme.subtext }]}>
                Based on {filterChanges.length} past filter{filterChanges.length !== 1 ? "s" : ""} · avg lifespan {avgFilterLifespan}d
              </Text>
            </View>
            {predictedDaysLeft <= 7 || predictedDaysLeft <= 30 || predictedDaysLeft > 60 ? (
              <View style={[styles.predBadge, { backgroundColor: predColor }]}>
                <Text style={styles.predBadgeText}>
                  {predictedDaysLeft <= 7 ? "Critical" : predictedDaysLeft <= 30 ? "Soon" : "Good"}
                </Text>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.predBadge, { backgroundColor: predColor }]}
                onPress={() => {
                  haptic();
                  const tenantEmail = selectedDevice
                    ? devices.find(d => d.id === selectedDevice)?.tenant_email
                    : devices[0]?.tenant_email;
                  if (tenantEmail) {
                    const subject = encodeURIComponent("Filter Replacement Reminder");
                    const body = encodeURIComponent(`Hi,\n\nJust a heads up — your HVAC filter has approximately ${predictedDaysLeft} days left before it needs replacing. Please schedule a replacement at your earliest convenience.\n\nThank you.`);
                    Linking.openURL(`mailto:${tenantEmail}?subject=${subject}&body=${body}`);
                  } else {
                    Alert.alert("No Tenant Email", "Add a tenant email in the Devices tab to use this feature.");
                  }
                }}
                activeOpacity={0.75}
              >
                <Text style={styles.predBadgeText}>Watch</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {daysSinceInstall != null && daysSinceInstall > 60 && (
          <View style={[styles.urgencyBanner, { backgroundColor: daysSinceInstall > 180 ? "#fef2f2" : daysSinceInstall > 90 ? "#fff7ed" : "#fffbeb", borderColor: daysSinceInstall > 180 ? "#fecaca" : daysSinceInstall > 90 ? "#fed7aa" : "#fde68a" }]}>
            <Ionicons name="warning" size={16} color={daysSinceInstall > 180 ? "#ef4444" : daysSinceInstall > 90 ? "#f97316" : "#f59e0b"} />
            <Text style={[styles.urgencyText, { color: daysSinceInstall > 180 ? "#ef4444" : daysSinceInstall > 90 ? "#f97316" : "#f59e0b" }]}>
              {daysSinceInstall > 180 ? `Filter installed ${daysSinceInstall} days ago — replace immediately` : daysSinceInstall > 90 ? `Filter installed ${daysSinceInstall} days ago — consider replacing soon` : `Filter installed ${daysSinceInstall} days ago — monitor closely`}
            </Text>
          </View>
        )}

        <View style={[styles.filterCard, { backgroundColor: theme.card }]}>
          <View style={[styles.filterInfoSection, { backgroundColor: theme.inputBg }]}>
            <View style={styles.filterInfoRow}>
              <View style={[styles.filterInfoIconBg, { backgroundColor: theme.divider }]}>
                <Ionicons name="calendar" size={14} color={theme.subtext} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.filterInfoLabel, { color: theme.subtext }]}>Current Filter Installed</Text>
                <Text style={[styles.filterInfoValue, { color: theme.text }]}>
                  {filterInstalledAt
                    ? `${formatTimestamp(filterInstalledAt)} · ${daysSinceInstall}d ago`
                    : "No filter detected yet"}
                </Text>
              </View>
            </View>
            <View style={[styles.filterInfoDivider, { backgroundColor: theme.divider }]} />
            <View style={styles.filterInfoRow}>
              <View style={[styles.filterInfoIconBg, { backgroundColor: theme.divider }]}>
                <Ionicons name="swap-horizontal" size={14} color={theme.subtext} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.filterInfoLabel, { color: theme.subtext }]}>Last Filter Change</Text>
                <Text style={[styles.filterInfoValue, { color: theme.text }]}>
                  {lastFilterChange ? formatTimestamp(lastFilterChange) : "No previous filter detected"}
                </Text>
              </View>
            </View>
            {currentRfid && (
              <>
                <View style={[styles.filterInfoDivider, { backgroundColor: theme.divider }]} />
                <View style={styles.filterInfoRow}>
                  <View style={[styles.filterInfoIconBg, { backgroundColor: theme.divider }]}>
                    <Ionicons name="wifi" size={14} color={theme.subtext} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.filterInfoLabel, { color: theme.subtext }]}>Current RFID Tag</Text>
                    <Text style={[styles.filterInfoValue, { color: theme.text, fontFamily: "monospace" }]}>{currentRfid}</Text>
                  </View>
                </View>
              </>
            )}
          </View>

          <TouchableOpacity
            style={[styles.historyToggleBtn, { borderTopColor: theme.divider }]}
            onPress={() => { haptic(); setShowFilterHistory(!showFilterHistory); }}>
            <Ionicons name={showFilterHistory ? "chevron-up" : "chevron-down"} size={16} color={theme.subtext} />
            <Text style={[styles.historyToggleText, { color: theme.subtext }]}>
              {showFilterHistory ? "Hide" : "Show"} change history ({filterChanges.length})
            </Text>
          </TouchableOpacity>

          {showFilterHistory && (
            <View style={[styles.filterHistory, { borderTopColor: theme.divider }]}>
              <View style={styles.filterRangeRow}>
                {FILTER_RANGES.map((r) => (
                  <TouchableOpacity key={r} style={[styles.filterRangePill, { backgroundColor: theme.inputBg, borderColor: theme.border }, filterRange === r && { backgroundColor: theme.pillActiveBg, borderColor: theme.pillActiveBg }]} onPress={() => setFilterRange(r)}>
                    <Text style={[styles.filterRangeText, { color: theme.subtext }, filterRange === r && { color: theme.pillActiveText }]}>{r}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {filterBarData.length > 0 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <BarChart data={filterBarData} width={Math.max(SCREEN_WIDTH - 80, filterBarData.length * 40)} height={120} barWidth={24} spacing={12} roundedTop hideRules xAxisColor={theme.divider} yAxisColor={theme.divider} yAxisTextStyle={{ color: theme.subtext, fontSize: 9 }} noOfSections={3} maxValue={Math.max(...filterBarData.map(d => d.value), 1) + 1} backgroundColor={theme.card} />
                </ScrollView>
              ) : (
                <View style={styles.noFilterData}><Text style={[styles.noDataText, { color: theme.subtext }]}>No filter changes detected yet</Text></View>
              )}
              {filterChanges.length > 0 && (
                <View style={[styles.filterList, { borderTopColor: theme.divider }]}>
                  <Text style={[styles.filterListTitle, { color: theme.text }]}>Change History</Text>
                  {filterChanges.map((change, i) => {
                    const next = filterChanges[i + 1];
                    const daysUsed = next ? Math.floor((new Date(change.changed_at.replace(" ", "T")) - new Date(next.changed_at.replace(" ", "T"))) / 86400000) : null;
                    return (
                      <View key={i} style={styles.filterListItem}>
                        <View style={styles.filterListDot} />
                        <View style={{ flex: 1 }}>
                          <View style={styles.filterListRow}>
                            <Text style={[styles.filterListDate, { color: theme.text }]}>{formatTimestamp(change.changed_at)}</Text>
                            {daysUsed != null && <Text style={styles.filterListDays}>{daysUsed}d used</Text>}
                          </View>
                          {change.rfid && <Text style={[styles.filterListRfid, { color: theme.subtext }]}>RFID: {change.rfid}</Text>}
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          )}
        </View>
      </ScrollView>

      {/*
        FIX: pass pre-converted display values to MetricDetailModal.
        Latest reading: convert from latestReadings (raw) → display.
        Avg/min/max: already stored as display values in metricStats.
      */}
      <MetricDetailModal
        metric={expandedMetricObj}
        displayLatest={expandedMetric ? toDisplay(expandedMetric.key, latestReadings[expandedMetric.key]) : null}
        displayAvg={expandedMetric ? metricStats[expandedMetric.key]?.avg : null}
        displayMin={expandedMetric ? metricStats[expandedMetric.key]?.min ?? rawStats.min : null}
        displayMax={expandedMetric ? metricStats[expandedMetric.key]?.max ?? rawStats.max : null}
        pct={getPercentChange(expandedMetric?.key)}
        visible={!!expandedMetric}
        onClose={() => setExpandedMetric(null)}
        theme={theme}
        isDark={isDark}
      />
      <AdvancedModal visible={showAdvanced} onClose={() => setShowAdvanced(false)} averages={averages} ductArea={ductArea} theme={theme} isDark={isDark} />
      <EditMetricCardsModal visible={showEditCards} onClose={() => setShowEditCards(false)} activeKeys={activeCardKeys} onSave={saveCardKeys} theme={theme} isDark={isDark} />
    </View>
  );
}

// ── Styles (unchanged from original) ─────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 20, paddingTop: 56, paddingBottom: 16 },
  greeting: { fontSize: 13, fontWeight: "500" },
  headerTitle: { fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  devicePill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, maxWidth: 160 },
  devicePillText: { fontSize: 12, fontWeight: "600", color: "#007BFF", flex: 1 },
  pickerDropdown: { marginHorizontal: 20, borderRadius: 16, borderWidth: 1, shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.1, shadowRadius: 12, elevation: 8, zIndex: 100, marginBottom: 8 },
  pickerItem: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  pickerItemText: { fontSize: 14, fontWeight: "500" },
  emptyDeviceCard: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 16, padding: 16, marginBottom: 16 },
  emptyDeviceTitle: { fontSize: 14, fontWeight: "700" },
  emptyDeviceSub: { fontSize: 12, marginTop: 2 },
  insightCard: { borderRadius: 20, padding: 16, marginBottom: 16, borderWidth: 1 },
  insightHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  insightBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10 },
  insightBadgeText: { fontSize: 11, fontWeight: "700" },
  lastUpdated: { fontSize: 11, fontWeight: "500" },
  insightLoading: { flexDirection: "row", alignItems: "center", gap: 8 },
  insightLoadingText: { fontSize: 13 },
  insightText: { fontSize: 14, lineHeight: 22, fontWeight: "500" },
  scroll: { paddingHorizontal: 20, paddingBottom: 60 },
  timeRow: { marginBottom: 12 },
  timePill: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, marginRight: 8, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 1 },
  timePillText: { fontSize: 13, fontWeight: "600" },
  intervalNav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderRadius: 16, padding: 12, marginBottom: 16, shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 6, elevation: 1 },
  arrowBtn: { padding: 8 },
  arrowDisabled: { opacity: 0.3 },
  intervalLabel: { fontSize: 15, fontWeight: "700", flex: 1, textAlign: "center" },
  metricRow: { marginBottom: 16 },
  metricPill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, marginRight: 8, borderWidth: 1.5 },
  metricPillText: { fontSize: 13, fontWeight: "600" },
  chartCard: { borderRadius: 24, padding: 20, marginBottom: 24, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 12, elevation: 3 },
  chartHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 },
  chartDot: { width: 10, height: 10, borderRadius: 5 },
  chartTitle: { fontSize: 16, fontWeight: "700", flex: 1 },
  statusBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusBadgeText: { fontSize: 11, fontWeight: "700" },
  chartPlaceholder: { height: 200, justifyContent: "center", alignItems: "center", gap: 8 },
  noDataText: { fontSize: 13 },
  barTooltip: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderRadius: 12, padding: 12, marginTop: 12, borderWidth: 1 },
  barTooltipLabel: { fontSize: 13, fontWeight: "600" },
  barTooltipValue: { fontSize: 16, fontWeight: "800" },
  statsRow: { flexDirection: "row", alignItems: "center", marginTop: 12, paddingTop: 12, borderTopWidth: 1 },
  statItem: { flex: 1, alignItems: "center", gap: 3 },
  statDivider: { width: 1, height: 30 },
  statItemLabel: { fontSize: 10, fontWeight: "600" },
  statItemValue: { fontSize: 14, fontWeight: "800" },
  anomalyLegend: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 10, flexWrap: "wrap" },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 11, fontWeight: "500" },
  chartLegend: { fontSize: 11, fontWeight: "500", marginLeft: "auto" },
  metricsSectionHeader: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 12 },
  sectionTitle: { fontSize: 20, fontWeight: "800", letterSpacing: -0.3 },
  sectionSubtitle: { fontSize: 12, fontWeight: "500", marginTop: 2 },
  editCardsBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 12, borderWidth: 1 },
  editCardsBtnText: { fontSize: 13, fontWeight: "700" },
  metricsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  metricSquare: { borderRadius: 20, padding: 14, shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 5, position: "relative", justifyContent: "flex-end" },
  squareTop: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: "auto", paddingBottom: 8 },
  squareIconBg: { width: 30, height: 30, borderRadius: 9, backgroundColor: "rgba(255,255,255,0.25)", justifyContent: "center", alignItems: "center" },
  squareLabel: { fontSize: 11, fontWeight: "700", color: "rgba(255,255,255,0.85)", flex: 1 },
  squarePctBadge: { flexDirection: "row", alignItems: "center", gap: 2, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 8 },
  squarePctText: { fontSize: 9, fontWeight: "800", color: "#fff" },
  squareAvgValue: { fontSize: 34, fontWeight: "900", color: "#fff", letterSpacing: -1, lineHeight: 38 },
  squareUnit: { fontSize: 12, fontWeight: "600", color: "rgba(255,255,255,0.75)", marginBottom: 10 },
  squareAvgLabel: { fontSize: 10, fontWeight: "500", color: "rgba(255,255,255,0.6)" },
  squareMinMax: { flexDirection: "row", backgroundColor: "rgba(0,0,0,0.15)", borderRadius: 10, padding: 8 },
  squareMinMaxItem: { flex: 1, alignItems: "center" },
  squareMinMaxDivider: { width: 1, backgroundColor: "rgba(255,255,255,0.2)", marginVertical: 2 },
  squareMinMaxLabel: { fontSize: 8, fontWeight: "800", color: "rgba(255,255,255,0.6)", letterSpacing: 0.5, marginBottom: 2 },
  squareMinMaxValue: { fontSize: 12, fontWeight: "700", color: "#fff" },
  alertDot: { position: "absolute", top: 12, right: 12, width: 8, height: 8, borderRadius: 4, backgroundColor: "#fff" },
  predCard: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 18, padding: 16, marginBottom: 12, borderWidth: 1.5, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
  predIconBg: { width: 44, height: 44, borderRadius: 14, justifyContent: "center", alignItems: "center" },
  predTitle: { fontSize: 14, fontWeight: "700" },
  predSub: { fontSize: 12, marginTop: 3 },
  predBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12 },
  predBadgeText: { fontSize: 12, fontWeight: "700", color: "#fff" },
  urgencyBanner: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 14, padding: 12, marginBottom: 12, borderWidth: 1 },
  urgencyText: { fontSize: 13, fontWeight: "600", flex: 1 },
  filterCard: { borderRadius: 24, padding: 20, marginBottom: 24, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 12, elevation: 3 },
  historyToggleBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 14, borderTopWidth: 1, marginTop: 4 },
  historyToggleText: { fontSize: 13, fontWeight: "600" },
  filterInfoSection: { borderRadius: 16, overflow: "hidden" },
  filterInfoRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  filterInfoIconBg: { width: 32, height: 32, borderRadius: 10, justifyContent: "center", alignItems: "center" },
  filterInfoLabel: { fontSize: 11, fontWeight: "700", marginBottom: 3 },
  filterInfoValue: { fontSize: 13, fontWeight: "600" },
  filterInfoDivider: { height: 1, marginLeft: 58 },
  filterHistory: { marginTop: 20, borderTopWidth: 1, paddingTop: 16 },
  filterRangeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 },
  filterRangePill: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, borderWidth: 1.5 },
  filterRangeText: { fontSize: 12, fontWeight: "700" },
  noFilterData: { height: 80, justifyContent: "center", alignItems: "center" },
  filterList: { marginTop: 16, borderTopWidth: 1, paddingTop: 16 },
  filterListTitle: { fontSize: 14, fontWeight: "700", marginBottom: 12 },
  filterListItem: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 14 },
  filterListDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#007BFF", marginTop: 4 },
  filterListRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  filterListDate: { fontSize: 13, fontWeight: "600" },
  filterListDays: { fontSize: 11, fontWeight: "700", color: "#007BFF", backgroundColor: "#EBF5FF", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  filterListRfid: { fontSize: 11, fontFamily: "monospace", marginTop: 2 },
});

const skelStyles = StyleSheet.create({
  squareCard: { borderRadius: 20, padding: 14, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.04, shadowRadius: 8, elevation: 2, justifyContent: "flex-end" },
  chartCard: { borderRadius: 24, padding: 20, marginBottom: 24, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 12, elevation: 3 },
});

const errStyles = StyleSheet.create({
  card: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 18, padding: 16, marginBottom: 12, borderWidth: 1.5 },
  title: { fontSize: 14, fontWeight: "700" },
  msg: { fontSize: 12, marginTop: 2 },
  retryBtn: { backgroundColor: "#007BFF", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  retryText: { color: "#fff", fontWeight: "700", fontSize: 13 },
});

const mst = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  card: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 44 },
  handle: { width: 36, height: 4, backgroundColor: "#e5e7eb", borderRadius: 2, alignSelf: "center", marginBottom: 20 },
  header: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 20 },
  iconBg: { width: 48, height: 48, borderRadius: 16, justifyContent: "center", alignItems: "center" },
  title: { fontSize: 20, fontWeight: "800" },
  unit: { fontSize: 13, fontWeight: "500", marginTop: 2 },
  latestCard: { borderRadius: 20, padding: 20, alignItems: "center", marginBottom: 16 },
  latestLabel: { fontSize: 12, color: "rgba(255,255,255,0.8)", fontWeight: "600", marginBottom: 4 },
  latestValue: { fontSize: 40, fontWeight: "800", color: "#fff" },
  rsBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, marginTop: 8 },
  rsText: { fontSize: 12, color: "#fff", fontWeight: "600" },
  statsGrid: { flexDirection: "row", borderRadius: 16, overflow: "hidden", marginBottom: 12 },
  statCell: { flex: 1, alignItems: "center", padding: 14 },
  statDivV: { width: 1 },
  statLabel: { fontSize: 11, fontWeight: "600", marginBottom: 4 },
  statValue: { fontSize: 18, fontWeight: "800" },
  changeRow: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 14, padding: 14, borderWidth: 1, marginBottom: 12 },
  changeText: { fontSize: 14, fontWeight: "500", flex: 1 },
  normalRangeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderTopWidth: 1, paddingTop: 14 },
  nrLabel: { fontSize: 13, fontWeight: "600" },
  nrValue: { fontSize: 13, fontWeight: "700" },
});

const adv = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  card: { height: "90%", borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: "hidden" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 20, borderBottomWidth: 1 },
  title: { fontSize: 20, fontWeight: "800" },
  subtitle: { fontSize: 13, marginTop: 2 },
  closeBtn: { width: 36, height: 36, borderRadius: 12, justifyContent: "center", alignItems: "center" },
  scroll: { padding: 20, paddingBottom: 40 },
  infoBox: { flexDirection: "row", alignItems: "flex-start", gap: 8, borderRadius: 14, padding: 12, marginBottom: 16, borderWidth: 1 },
  infoText: { fontSize: 12, lineHeight: 18, flex: 1, fontWeight: "500" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 14, borderRadius: 18, padding: 16, marginBottom: 10, borderWidth: 1 },
  rowIcon: { width: 40, height: 40, borderRadius: 12, justifyContent: "center", alignItems: "center", flexShrink: 0 },
  rowLabel: { fontSize: 11, fontWeight: "700", marginBottom: 4 },
  rowValue: { fontSize: 22, fontWeight: "800", marginBottom: 4 },
  rowUnit: { fontSize: 14, fontWeight: "500" },
  rowDesc: { fontSize: 12, lineHeight: 17 },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", gap: 12, paddingTop: 80 },
  emptyText: { fontSize: 15 },
});

const editModal = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 24, paddingBottom: 48, maxHeight: "85%" },
  handle: { width: 36, height: 4, backgroundColor: "#e5e7eb", borderRadius: 2, alignSelf: "center", marginBottom: 20 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  title: { fontSize: 20, fontWeight: "800" },
  sub: { fontSize: 12, fontWeight: "500", marginBottom: 16 },
  sectionLabel: { fontSize: 10, fontWeight: "800", letterSpacing: 1, marginBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 14, padding: 10, marginBottom: 7, borderWidth: 1 },
  colorDot: { width: 7, height: 7, borderRadius: 4 },
  iconBg: { width: 28, height: 28, borderRadius: 8, justifyContent: "center", alignItems: "center" },
  rowLabel: { fontSize: 13, fontWeight: "600", flex: 1 },
  rowUnit: { fontSize: 11, fontWeight: "500" },
  rowActions: { flexDirection: "row", alignItems: "center", gap: 4 },
  arrowBtn: { padding: 4 },
  removeBtn: { width: 24, height: 24, borderRadius: 8, justifyContent: "center", alignItems: "center" },
  computedBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginRight: 4 },
  computedBadgeText: { fontSize: 9, fontWeight: "700", color: "#6366f1" },
  saveBtn: { backgroundColor: "#007BFF", borderRadius: 14, paddingVertical: 14, alignItems: "center", marginTop: 16 },
  saveBtnText: { color: "#fff", fontWeight: "800", fontSize: 16 },
});