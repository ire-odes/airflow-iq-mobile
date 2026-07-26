// lib/config.js
// Central app configuration. Values are read from EXPO_PUBLIC_* env vars at
// build time (put them in a .env file — see .env.example). Fallbacks keep the
// app working for existing installs until env vars are configured.

export const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL || "https://hniplnaohvcbtmelatnz.supabase.co";

export const SUPABASE_ANON_KEY =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuaXBsbmFvaHZjYnRtZWxhdG56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1Nzk0MjAsImV4cCI6MjA4MDE1NTQyMH0.g7sgeZBW0RKkMI1lryA96Sym6cnejUAcmIx_npGr1Ko";

// Optional — AI insights on the dashboard are hidden when this is not set.
export const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY || null;

// Device configuration limits (enforced in the Edit Device modal and used as
// fallbacks anywhere an interval is displayed).
export const FILTER_INTERVAL_MIN_DAYS = 1;
export const FILTER_INTERVAL_MAX_DAYS = 30;
export const DEFAULT_FILTER_INTERVAL_DAYS = 30;

export const WAKE_INTERVAL_MIN_SECONDS = 10 * 60; // 10 minutes
export const WAKE_INTERVAL_MAX_SECONDS = 24 * 60 * 60; // 24 hours
export const DEFAULT_WAKE_INTERVAL_SECONDS = 10 * 60;

export const APP_VERSION = "1.0.0";
