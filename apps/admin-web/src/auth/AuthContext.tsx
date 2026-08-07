import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiRequest, clearStoredToken, getStoredToken, setStoredToken } from "../api/client";
import type { AdminUser } from "../types";

interface AuthContextValue {
  admin: AdminUser | null;
  /** 起動直後、保存済みトークンの有効性を確認している間はtrue（画面のちらつき防止）。 */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, inviteCode: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setLoading(false);
      return;
    }
    apiRequest<{ admin: AdminUser }>("/admin/auth/me")
      .then((res) => setAdmin(res.admin))
      .catch(() => clearStoredToken())
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await apiRequest<{ token: string; admin: AdminUser }>("/admin/auth/login", {
      method: "POST",
      body: { email, password },
      auth: false,
    });
    setStoredToken(res.token);
    setAdmin(res.admin);
  }, []);

  const signup = useCallback(async (email: string, password: string, inviteCode: string) => {
    const res = await apiRequest<{ token: string; admin: AdminUser }>("/admin/auth/signup", {
      method: "POST",
      body: { email, password, inviteCode },
      auth: false,
    });
    setStoredToken(res.token);
    setAdmin(res.admin);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    await apiRequest("/admin/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });
  }, []);

  const logout = useCallback(() => {
    clearStoredToken();
    setAdmin(null);
  }, []);

  const value = useMemo(() => ({ admin, loading, login, signup, changePassword, logout }), [admin, loading, login, signup, changePassword, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuthはAuthProviderの内側で使う必要があります");
  return ctx;
}
