import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { loginSchema, registerSchema } from "@geo/shared";
import { Alert, Button, Card, Field } from "../components/ui";
import { DEFAULT_INTERVAL_MS } from "../config";
import { ApiError, NetworkError, api, setApiBaseUrl } from "../lib/api";
import { saveServerUrl, type StoredSession } from "../lib/session";
import { colors, radius, spacing } from "../theme";

interface LoginScreenProps {
  /** URL de la API detectada automaticamente al arrancar. */
  initialServerUrl: string;
  onLoggedIn: (session: StoredSession) => void;
}

export function LoginScreen({
  initialServerUrl,
  onLoggedIn,
}: LoginScreenProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  const [showServer, setShowServer] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError(null);

    // Validacion en cliente con los mismos esquemas que usa el backend.
    const schema = mode === "register" ? registerSchema : loginSchema;
    const parsed = schema.safeParse({ email, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Datos invalidos");
      return;
    }

    setBusy(true);
    try {
      const url = serverUrl.trim();
      if (url.length > 0) {
        setApiBaseUrl(url);
        await saveServerUrl(url);
      }

      const response =
        mode === "register"
          ? await api.register(parsed.data.email, parsed.data.password)
          : await api.login(parsed.data.email, parsed.data.password);

      onLoggedIn({
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
        user: response.user,
      });
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
      } else if (caught instanceof NetworkError) {
        setError(
          `No se pudo conectar con ${serverUrl}.\nVerifica que la API este en marcha y que el telefono este en la misma red.`,
        );
      } else {
        setError("Error inesperado al iniciar sesion.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <View style={styles.dot} />
          <Text style={styles.brandText}>Geolocalizador Movil</Text>
        </View>

        <Text style={styles.title}>
          {mode === "login" ? "Iniciar sesion" : "Crear cuenta"}
        </Text>
        <Text style={styles.subtitle}>
          Comparte tu ubicacion solo cuando tu lo decidas, desde este
          dispositivo.
        </Text>

        <View style={styles.tabs}>
          {(["login", "register"] as const).map((option) => (
            <Text
              key={option}
              onPress={() => {
                setMode(option);
                setError(null);
              }}
              style={[styles.tab, mode === option && styles.tabActive]}
            >
              {option === "login" ? "Entrar" : "Registrarme"}
            </Text>
          ))}
        </View>

        <Card>
          <Field
            label="Correo electronico"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            textContentType="emailAddress"
            placeholder="tu@correo.com"
          />

          <Field
            label="Contrasena"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="Minimo 8 caracteres"
            hint={
              mode === "register"
                ? "Debe incluir mayuscula, minuscula y un numero."
                : undefined
            }
          />

          {error ? <Alert message={error} tone="error" /> : null}

          <Button
            label={mode === "login" ? "Entrar" : "Crear cuenta y entrar"}
            variant="primary"
            loading={busy}
            onPress={() => void submit()}
          />

          <View style={styles.spacer} />

          <Button
            label="Usar cuenta de demostracion"
            onPress={() => {
              setMode("login");
              setEmail("demo@geo.test");
              setPassword("Demo1234");
            }}
          />

          <View style={styles.spacer} />

          <Text
            style={styles.link}
            onPress={() => setShowServer((value) => !value)}
          >
            {showServer ? "Ocultar servidor" : "Cambiar direccion del servidor"}
          </Text>

          {showServer ? (
            <View style={styles.spacer}>
              <Field
                label="Direccion de la API"
                value={serverUrl}
                onChangeText={setServerUrl}
                keyboardType="url"
                placeholder="http://192.168.1.20:3001"
                hint="Se detecta automaticamente a partir del servidor de Expo. Cambiala si usas otro equipo o un tunel."
              />
            </View>
          ) : null}
        </Card>

        <Text style={styles.footnote}>
          La ubicacion se envia cada {Math.round(DEFAULT_INTERVAL_MS / 1000)}{" "}
          segundos por defecto y solo mientras la comparticion este activa.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.xl, paddingBottom: spacing.xxl },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.xl,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    marginRight: spacing.sm,
  },
  brandText: { color: colors.text, fontWeight: "700", fontSize: 16 },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "700",
    marginBottom: spacing.xs,
  },
  subtitle: { color: colors.muted, fontSize: 14, marginBottom: spacing.lg },
  tabs: {
    flexDirection: "row",
    backgroundColor: colors.surfaceSoft,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xs,
    marginBottom: spacing.lg,
  },
  tab: {
    flex: 1,
    textAlign: "center",
    paddingVertical: spacing.sm,
    color: colors.muted,
    fontWeight: "600",
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  tabActive: { backgroundColor: colors.accent, color: colors.onAccent },
  spacer: { height: spacing.md },
  link: {
    color: colors.accent,
    textAlign: "center",
    paddingVertical: spacing.sm,
  },
  footnote: {
    color: colors.muted,
    fontSize: 12,
    textAlign: "center",
    marginTop: spacing.md,
  },
});
