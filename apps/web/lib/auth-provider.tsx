"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { PublicUser } from "@geo/shared";
import { api, getSession, setSession, subscribeSession } from "./api";

interface AuthContextValue {
  user: PublicUser | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [ready, setReady] = useState(false);

  // Sincroniza el estado de React con el almacen de sesion.
  useEffect(() => {
    const sync = (session: ReturnType<typeof getSession>) =>
      setUser(session?.user ?? null);
    sync(getSession());
    setReady(true);
    return subscribeSession(sync);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const response = await api.login(email, password);
    setSession({
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      user: response.user,
    });
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const response = await api.register(email, password);
    setSession({
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      user: response.user,
    });
  }, []);

  const logout = useCallback(async () => {
    const session = getSession();
    if (session) {
      // Si falla (por ejemplo, red caida), cerramos sesion localmente igualmente.
      await api.logout(session.refreshToken).catch(() => undefined);
    }
    setSession(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ user, ready, login, register, logout }),
    [user, ready, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  }
  return context;
}
