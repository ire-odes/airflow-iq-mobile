import React, { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import AsyncStorage from "@react-native-async-storage/async-storage";

const AuthContext = createContext({});

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [technicianAssignments, setTechnicianAssignments] = useState([]);

  const loadTechnicianAssignments = async (email) => {
    if (!email) { setTechnicianAssignments([]); return; }
    const { data } = await supabase
      .from("technician_assignments")
      .select("id, landlord_id, technician_email")
      .eq("technician_email", email);
    setTechnicianAssignments(data || []);
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
      loadTechnicianAssignments(session?.user?.email);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) loadTechnicianAssignments(session.user.email);
      else setTechnicianAssignments([]);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  const refreshTechnicianAssignments = () =>
    loadTechnicianAssignments(session?.user?.email);

  const signIn = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    return { data, error };
  };

  const signUp = async (email, password) => {
    const { data, error } = await supabase.auth.signUp({ email, password });
    return { data, error };
  };

  const resetPassword = async (email) => {
    const { data, error } = await supabase.auth.resetPasswordForEmail(email);
    return { data, error };
  };

  const signOut = async () => {
    try { await AsyncStorage.removeItem("current_user_id"); } catch (_) {}
    try {
      const BackgroundFetch = require("expo-background-fetch");
      const TaskManager = require("expo-task-manager");
      if (await TaskManager.isTaskRegisteredAsync("AIRFLOW_BACKGROUND_CHECK")) {
        await BackgroundFetch.unregisterTaskAsync("AIRFLOW_BACKGROUND_CHECK");
      }
    } catch (_) {}
    setTechnicianAssignments([]);
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{
      session, loading, signIn, signUp, signOut, resetPassword,
      technicianAssignments, refreshTechnicianAssignments,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
