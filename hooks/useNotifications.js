// hooks/useNotifications.js
// Call this once inside _layout.js to bootstrap the whole notification system

import { useEffect } from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  requestNotificationPermissions,
  registerBackgroundFetch,
  runNotificationChecks,
} from "../lib/notifications";

export function useNotifications(userId) {
  useEffect(() => {
    if (!userId) return;

    const bootstrap = async () => {
      // Store userId so background task can access it
      await AsyncStorage.setItem("current_user_id", userId);

      // Request permissions
      const granted = await requestNotificationPermissions();
      if (!granted) {
        console.warn("Notification permissions denied");
        return;
      }

      // Register background fetch
      try {
  await registerBackgroundFetch();
} catch (e) {
  // Expected in Expo Go — works in standalone builds
  console.log("Background fetch unavailable in Expo Go");
}
      // Run an immediate check on app open
      await runNotificationChecks(userId);
    };

    bootstrap();

    // Also run checks whenever app comes back to foreground
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        runNotificationChecks(userId);
      }
    });

    return () => subscription.remove();
  }, [userId]);
}