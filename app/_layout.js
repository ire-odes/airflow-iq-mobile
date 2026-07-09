import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { AuthProvider, useAuth } from "../context/AuthContext";
import { ThemeProvider } from "../context/ThemeContext";
import { useNotifications } from "../hooks/useNotifications";

function NotificationBootstrap() {
  const { session } = useAuth();
  useNotifications(session?.user?.id);
  return null;
}

function RouteGuard() {
  const { session, loading } = useAuth();
  const router = useRouter();
  const segments = useSegments();

  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === "(auth)";

    if (!session && !inAuthGroup) {
      // Not logged in — send to login
      router.replace("/(auth)/login");
    } else if (session && inAuthGroup) {
      // Logged in — send to dashboard
      router.replace("/(tabs)/dashboard");
    }
  }, [session, loading]);

  return null;
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <RouteGuard />
        <NotificationBootstrap />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(tabs)" />
        </Stack>
      </ThemeProvider>
    </AuthProvider>
  );
}