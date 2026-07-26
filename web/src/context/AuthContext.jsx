import { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

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

  const signIn = (email, password) =>
    supabase.auth.signInWithPassword({ email, password });

  const signUp = (email, password) =>
    supabase.auth.signUp({ email, password });

  const resetPassword = (email) =>
    supabase.auth.resetPasswordForEmail(email);

  const signOut = async () => {
    setTechnicianAssignments([]);
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider
      value={{
        session, loading, signIn, signUp, signOut, resetPassword,
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
