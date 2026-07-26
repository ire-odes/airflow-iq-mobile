// Metric definitions, unit conversion and HVAC math.
// Ported 1:1 from the mobile app so both clients report identical numbers.

// ── Unit conversion ──────────────────────────────────────────────────────────
export const cToF = (c) => (c == null ? null : (c * 9) / 5 + 32);
export const paToHpa = (pa) => (pa == null ? null : pa / 100);

// Convert a raw DB value to its display value for a given metric key.
export function toDisplay(key, raw) {
  if (raw == null) return null;
  if (key === "temp_c") return cToF(raw);
  if (key === "pressure_pa") return paToHpa(raw);
  return raw;
}

// ── Metric catalogue (units and normalRange are in DISPLAY units) ────────────
export const ALL_METRICS = [
  { label: "Temperature",        key: "temp_c",            unit: "°F",     icon: "thermometer", color: "#FF6B6B", normalRange: [64, 79],    decimals: 1 },
  { label: "Humidity",           key: "humidity",          unit: "%",      icon: "droplet",     color: "#45B7D1", normalRange: [30, 60],    decimals: 1 },
  { label: "Pressure",           key: "pressure_pa",       unit: " hPa",   icon: "gauge",       color: "#4ECDC4", normalRange: [980, 1020], decimals: 1 },
  { label: "Wind Speed",         key: "windSpeed",         unit: " m/s",   icon: "wind",        color: "#96CEB4", normalRange: [0.5, 5],    decimals: 1 },
  { label: "Volumetric Airflow", key: "volumetricAirflow", unit: " m³/s",  icon: "move-right",  color: "#a78bfa", normalRange: [0.01, 0.5], decimals: 4, computed: true },
  { label: "Air Density",        key: "airDensity",        unit: " kg/m³", icon: "layers",      color: "#34d399", normalRange: [1.1, 1.3],  decimals: 3, computed: true },
  { label: "Dew Point",          key: "dewPoint",          unit: "°F",     icon: "cloud-drizzle", color: "#60a5fa", normalRange: [32, 59],  decimals: 1, computed: true },
  { label: "Comfort Index",      key: "comfortIndex",      unit: "/100",   icon: "smile",       color: "#f472b6", normalRange: [70, 100],   decimals: 0, computed: true },
];

// Metrics that exist as columns on sensor_logs (chartable directly).
export const METRICS = ALL_METRICS.filter((m) => !m.computed);

export const DEFAULT_CARD_KEYS = ["temp_c", "humidity", "pressure_pa", "windSpeed"];
export const CARDS_STORAGE_KEY = "dashboard_metric_card_keys";

export const TIME_RANGES = [
  { label: "24H", hours: 24,  bucket: "hour" },
  { label: "7D",  hours: 168, bucket: "day"  },
  { label: "30D", hours: 720, bucket: "day"  },
];

// ── HVAC calculations (operate on raw SI values) ─────────────────────────────
export function computeHvacMetrics(avg, ductArea = 0.1) {
  const T = avg.temp_c, RH = avg.humidity, P = avg.pressure_pa, v = avg.windSpeed;
  if (T == null || RH == null || P == null || v == null) return null;

  const Psat = 610.78 * Math.exp((17.27 * T) / (T + 237.3));
  const Pv = (RH / 100) * Psat;
  const Pd = P - Pv;
  const specificHumidity = (0.622 * Pv) / Pd;
  const absoluteHumidity = ((Pv * 18.016) / (8.314 * (T + 273.15))) * 1000;
  const Rspecific = (287.058 * (1 + 1.608 * specificHumidity)) / (1 + specificHumidity);
  const airDensity = P / (Rspecific * (T + 273.15));
  const enthalpy = 1.006 * T + specificHumidity * (2501 + 1.86 * T);
  const dewPoint = (237.3 * Math.log(Pv / 610.78)) / (17.27 - Math.log(Pv / 610.78));
  const wetBulb =
    T * Math.atan(0.151977 * Math.sqrt(RH + 8.313659)) +
    Math.atan(T + RH) -
    Math.atan(RH - 1.676331) +
    0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH) -
    4.686035;
  const volumetricAirflow = v * ductArea;
  const massAirflow = airDensity * volumetricAirflow;
  const cp = 1.006 + 1.86 * specificHumidity;
  const sensibleHeatRate = massAirflow * cp * 1.0;
  const comfortScore = Math.max(0, 100 - Math.abs(T - 22) * 4 - Math.abs(RH - 45) * 1.2);

  return {
    dewPoint:          { value: cToF(dewPoint).toFixed(1),               unit: "°F",     label: "Dew Point",          icon: "cloud-drizzle", description: "Temperature at which moisture condenses. If near room temp, humidity is very high." },
    wetBulb:           { value: cToF(wetBulb).toFixed(1),                unit: "°F",     label: "Wet Bulb Temp",      icon: "thermometer",   description: "Lowest temp achievable by evaporative cooling. Key for HVAC system sizing." },
    absoluteHumidity:  { value: absoluteHumidity.toFixed(2),             unit: " g/m³",  label: "Absolute Humidity",  icon: "cloud",         description: "Actual mass of water vapour per cubic metre of air." },
    specificHumidity:  { value: (specificHumidity * 1000).toFixed(2),    unit: " g/kg",  label: "Specific Humidity",  icon: "cloud-sun",     description: "Mass of water vapour per kg of dry air. Used in HVAC load calculations." },
    airDensity:        { value: airDensity.toFixed(4),                   unit: " kg/m³", label: "Air Density",        icon: "layers",        description: "Denser air carries more heat and moisture. Affects fan and duct efficiency." },
    enthalpy:          { value: enthalpy.toFixed(1),                     unit: " kJ/kg", label: "Enthalpy",           icon: "zap",           description: "Total heat content of moist air. Used to size HVAC equipment." },
    volumetricAirflow: { value: volumetricAirflow.toFixed(4),            unit: " m³/s",  label: "Volumetric Airflow", icon: "move-right",    description: `Estimated volume of air moving per second (duct area: ${ductArea} m²).` },
    massAirflow:       { value: massAirflow.toFixed(4),                  unit: " kg/s",  label: "Mass Airflow",       icon: "gauge",         description: "Mass of air moving per second. Determines heating/cooling capacity." },
    sensibleHeat:      { value: sensibleHeatRate.toFixed(4),             unit: " kW",    label: "Sensible Heat Rate", icon: "sun",           description: "Rate of heat transfer for a 1°C delta T. Baseline for system sizing." },
    comfortIndex:      { value: comfortScore.toFixed(0),                 unit: "/100",   label: "Comfort Index",      icon: "smile",         description: "Combined temp + humidity comfort score. 80+ is ideal, below 50 needs attention." },
  };
}

// ── Status helpers ───────────────────────────────────────────────────────────
export function getStatusLabel(curr, prev) {
  if (curr == null || prev == null || prev === 0) return "Normal";
  const pct = ((curr - prev) / Math.abs(prev)) * 100;
  if (Math.abs(pct) < 5) return "Normal";
  return pct > 5 ? "Above Average" : "Below Average";
}

export function getStatusColor(s) {
  if (s === "Normal") return "#22c55e";
  if (s === "Above Average") return "#f59e0b";
  return "#45B7D1";
}

export function getRangeStatus(v, r) {
  if (v == null || !r) return "normal";
  if (v > r[1]) return "high";
  if (v < r[0]) return "low";
  return "normal";
}

export function getOnlineStatus(lastSeen) {
  if (!lastSeen) return "unknown";
  const diff = Date.now() - parseTs(lastSeen).getTime();
  if (diff < 10 * 60 * 1000) return "online";
  if (diff < 60 * 60 * 1000) return "idle";
  return "offline";
}

export function getFilterProgress(installedAt, intervalDays) {
  if (!installedAt || !intervalDays) return null;
  const daysSince = Math.floor((Date.now() - parseTs(installedAt).getTime()) / 86400000);
  const pct = Math.min(100, Math.round((daysSince / intervalDays) * 100));
  const daysLeft = Math.max(0, intervalDays - daysSince);
  return { daysSince, daysLeft, pct, intervalDays };
}

// Supabase returns timestamps as "YYYY-MM-DD HH:MM:SS" or ISO — normalise both.
export function parseTs(ts) {
  if (!ts) return new Date(NaN);
  return new Date(typeof ts === "string" ? ts.replace(" ", "T") : ts);
}
