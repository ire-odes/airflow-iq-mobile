// Central web app configuration.
// Mirrors the mobile app's lib/config.js — keep the two in sync. The interval
// limits below are enforced by CHECK constraints in
// supabase/migrations/20260713000000_orders_and_subscriptions.sql, so the UI
// must not allow values outside them or the write will be rejected.

export const SUPABASE_URL =
  import.meta.env?.VITE_SUPABASE_URL || "https://hniplnaohvcbtmelatnz.supabase.co";

export const SUPABASE_ANON_KEY =
  import.meta.env?.VITE_SUPABASE_ANON_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuaXBsbmFvaHZjYnRtZWxhdG56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1Nzk0MjAsImV4cCI6MjA4MDE1NTQyMH0.g7sgeZBW0RKkMI1lryA96Sym6cnejUAcmIx_npGr1Ko";

// Optional — AI insights are hidden when this is not set.
export const GEMINI_API_KEY = import.meta.env?.VITE_GEMINI_API_KEY || null;

// Device configuration limits (DB-enforced: 1–30 days, 600–86400 seconds).
export const FILTER_INTERVAL_MIN_DAYS = 1;
export const FILTER_INTERVAL_MAX_DAYS = 30;
export const DEFAULT_FILTER_INTERVAL_DAYS = 30;

export const WAKE_INTERVAL_MIN_SECONDS = 10 * 60; // 10 minutes
export const WAKE_INTERVAL_MAX_SECONDS = 24 * 60 * 60; // 24 hours
export const DEFAULT_WAKE_INTERVAL_SECONDS = 10 * 60;

export const APP_VERSION = "1.0.0";
