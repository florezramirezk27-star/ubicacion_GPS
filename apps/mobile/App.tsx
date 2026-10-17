import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { PublicDevice } from "@geo/shared";
import { RemoteAccessOverlay } from "./src/components/RemoteAccessOverlay";
import { useRemoteAccess } from "./src/hooks/useRemoteAccess";
import { DevicesScreen } from "./src/screens/DevicesScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { TrackingScreen } from "./src/screens/TrackingScreen";
import {
  ApiError,
  NetworkError,
  api,
  getApiBaseUrl,
  setApiBaseUrl,
} from "./src/lib/api";
import { authed } from "./src/lib/authed";
import {
  clearSession,
  clearShare,
  loadServerUrl,
  loadSession,
  persistSession,
  type StoredSession,
} from "./src/lib/session";
import { colors, spacing } from "./src/theme";

type Screen = "booting" | "login" | "devices" | "tracking";

/**
 * Componente raiz: decide que pantalla mostrar segun haya sesion y dispositivo
 * elegido, y comprueba al arrancar si la sesion guardada sigue siendo valida.
 */
export default function App() {
  const [screen, setScreen] = useState<Screen>("booting");
  const [session, setSession] = useState<StoredSession | null>(null);
  const [device, setDevice] = useState<PublicDevice | null>(null);
  const [serverUrl, setServerUrl] = useState(() => getApiBaseUrl());

  // Acceso remoto a camara/microfono: se mantiene vivo en toda la app (no solo
  // en la pantalla de seguimiento) para que una solicitud no pase inadvertida y
  // para poder cortar la emision desde cualquier sitio.
  const remoteAccess = useRemoteAccess(session, setSession);

  // Arranque: recuperar la direccion del servidor y la sesion guardada.
  useEffect(() => {
    let active = true;

    void (async () => {
      const storedUrl = await loadServerUrl();
      if (storedUrl) {
        setApiBaseUrl(storedUrl);
        if (active) setServerUrl(storedUrl);
      }

      const stored = await loadSession();
      if (!active) return;

      if (!stored) {
        setScreen("login");
        return;
      }

      // Se comprueba que la sesion siga siendo util (renueva el token si caduco).
      try {
        const user = await authed(
          stored,
          (next) => setSession(next),
          (token) => api.me(token),
        );
        if (!active) return;
        const refreshed: StoredSession = { ...stored, user };
        await persistSession(refreshed);
        setSession(refreshed);
        setScreen("devices");
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) {
          // Sesion caducada de verdad: volver a pedir credenciales.
          await clearSession();
          setScreen("login");
        } else if (error instanceof NetworkError) {
          // Sin red no se puede validar: se conserva la sesion y se intenta igual.
          setSession(stored);
          setScreen("devices");
        } else {
          await clearSession();
          setScreen("login");
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const handleLoggedIn = useCallback((next: StoredSession) => {
    void persistSession(next);
    setSession(next);
    setDevice(null);
    setScreen("devices");
  }, []);

  const handleLogout = useCallback(async () => {
    if (session) {
      try {
        await api.logout(session.refreshToken);
      } catch {
        // Si no hay red, la sesion del servidor expirara por si sola.
      }
    }
    await clearSession();
    await clearShare();
    setSession(null);
    setDevice(null);
    setScreen("login");
  }, [session]);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.root}>
          {screen === "booting" ? (
            <View style={styles.booting}>
              <ActivityIndicator color={colors.accent} size="large" />
              <Text style={styles.bootingText}>Preparando la app...</Text>
            </View>
          ) : null}

          {screen === "login" ? (
            <LoginScreen
              initialServerUrl={serverUrl}
              onLoggedIn={handleLoggedIn}
            />
          ) : null}

          {screen === "devices" && session ? (
            <DevicesScreen
              session={session}
              onSessionRefreshed={setSession}
              onSelectDevice={(selected) => {
                setDevice(selected);
                setScreen("tracking");
              }}
              onLogout={() => void handleLogout()}
            />
          ) : null}

          {screen === "tracking" && session && device ? (
            <TrackingScreen
              session={session}
              device={device}
              onSessionRefreshed={setSession}
              onBack={() => {
                setDevice(null);
                setScreen("devices");
              }}
            />
          ) : null}

          {/*
            El consentimiento del acceso remoto se monta en la raiz, no dentro
            de una pantalla: una solicitud debe verse este donde este el usuario.
          */}
          {session ? <RemoteAccessOverlay controller={remoteAccess} /> : null}
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  root: { flex: 1, backgroundColor: colors.background },
  booting: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
  },
  bootingText: { color: colors.muted, fontSize: 14 },
});
