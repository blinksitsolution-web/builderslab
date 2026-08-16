import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { fetchCurrentUser, login as loginRequest, logout as logoutRequest, classifyAuthError } from "../api/auth";

/**
 * AuthContext — session state (Phase 2 foundation, completed in Phase 4).
 *
 * Holds the same session shape the legacy dashboard.html keeps in its
 * global `user` variable, sourced from GET /api/auth/me (see Phase 1:
 * server/src/utils/userView.js -> getFullUser/toPublicUser). The backend
 * remains the sole authority on identity and access; this context does not
 * add, infer, or cache anything beyond what /api/auth/me already returns.
 *
 * `status` distinguishes "still checking" from "checked, signed out" so
 * consumers (e.g. ProtectedRoute) can avoid a flash-redirect before the
 * initial session-restoration request resolves.
 *
 * `authError` is the classified result of the most recent failed login
 * attempt (see api/auth.js classifyAuthError) — invalid credentials,
 * restricted/suspended account, a generic API error, or a network/backend
 * failure. It's cleared automatically on the next login attempt or by
 * calling `clearAuthError`; nothing here re-derives *why* an account is
 * restricted beyond what the server's response already said.
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState("loading"); // "loading" | "authenticated" | "unauthenticated"
  const [authError, setAuthError] = useState(null);

  const refresh = useCallback(async () => {
    const current = await fetchCurrentUser();
    setUser(current);
    setStatus(current ? "authenticated" : "unauthenticated");
    return current;
  }, []);

  // Session restoration on mount — the React equivalent of dashboard.html's
  // boot() calling DTL.currentUser() before route(). A failure here (e.g.
  // the backend being briefly unreachable) must never be treated as "signed
  // in" — fetchCurrentUser() already resolves to null rather than throwing,
  // so this can only ever land on "unauthenticated", never a false positive.
  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (email, password) => {
    setAuthError(null);
    try {
      const loggedInUser = await loginRequest(email, password);
      setUser(loggedInUser);
      setStatus("authenticated");
      return loggedInUser;
    } catch (err) {
      setAuthError(classifyAuthError(err));
      throw err;
    }
  }, []);

  const clearAuthError = useCallback(() => setAuthError(null), []);

  const logout = useCallback(async () => {
    await logoutRequest();
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  const value = useMemo(
    () => ({
      user,
      status,
      isLoading: status === "loading",
      isAuthenticated: status === "authenticated",
      authError,
      clearAuthError,
      login,
      logout,
      refresh,
    }),
    [user, status, authError, clearAuthError, login, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
