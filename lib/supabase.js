import 'react-native-url-polyfill/auto';
import { createClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";

const SUPABASE_URL = "https://hniplnaohvcbtmelatnz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhuaXBsbmFvaHZjYnRtZWxhdG56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ1Nzk0MjAsImV4cCI6MjA4MDE1NTQyMH0.g7sgeZBW0RKkMI1lryA96Sym6cnejUAcmIx_npGr1Ko";

const ExpoSecureStoreAdapter = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: ExpoSecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});