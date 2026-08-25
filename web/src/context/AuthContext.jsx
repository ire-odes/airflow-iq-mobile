import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

const AuthContext = createContext({});

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [technicianAssignments, setTechnicianAssignments] = useState([]);

  const loadTechnicianAssignments = async (email) => {
    if (!email) { setTechnicianAssignments([]); return; }
    // Lowercased to match how assignments are stored (both write paths --
    // Account.jsx's inviteTechnician and Properties.jsx's addTechnician --
    // normalise before inserting) and how the RLS policies compare them
    // (see supabase/migrations/20260828010000_technician_email_case_
    // insensitive.sql). Without this, a technician whose auth email carries
    // any uppercase would be granted access by RLS but read back zero
    // assignments here, so the app wouldn't know they're a technician.
    const { data } = await supabase
      .from("technician_assignments")
      .select("id, landlord_id, technician_email")
      .eq("technician_email", email.toLowerCase());
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

  const signIn = (email, password) =>
    supabase.auth.signInWithPassword({ email, password });

  const signUp = (email, password) =>
    supabase.auth.signUp({ email, password });

  // Redirects the browser to Google, then back to this same origin — the
  // Supabase client picks up the session from the URL automatically
  // (detectSessionInUrl: true in lib/supabase.js), which flips `session`
  // above and swaps in the app shell. No callback route needed.
  const signInWithGoogle = () =>
    supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });

  const resetPassword = (email) =>
    supabase.auth.resetPasswordForEmail(email);

  const signOut = async () => {
    setTechnicianAssignments([]);
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider
      value={{
        session, loading, signIn, signUp, signOut, resetPassword, signInWithGoogle,
        technicianAssignments, refreshTechnicianAssignments,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
