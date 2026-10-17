import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Device from "expo-device";
import { createDeviceSchema, type PublicDevice } from "@geo/shared";
import { Alert, Badge, Button, Card, Field } from "../components/ui";
import { ApiError, NetworkError, api } from "../lib/api";
import { authed } from "../lib/authed";
import type { StoredSession } from "../lib/session";
import { PLATFORM_LABEL } from "../lib/format";
import { colors, radius, spacing } from "../theme";

interface DevicesScreenProps {
  session: StoredSession;
  onSessionRefreshed: (next: StoredSession) => void;
  onSelectDevice: (device: PublicDevice) => void;
  onLogout: () => void;
}

/** Nombre y plataforma sugeridos a partir del propio telefono. */
function suggestDevice(): { deviceName: string; platform: "ANDROID" | "IOS" } {
  const platform: "ANDROID" | "IOS" = Platform.OS === "ios" ? "IOS" : "ANDROID";
  const model =
    Device.modelName ??
    Device.deviceName ??
    (platform === "IOS" ? "iPhone" : "Android");
  return { deviceName: model.slice(0, 80), platform };
}

export function DevicesScreen({
  session,
  onSessionRefreshed,
  onSelectDevice,
  onLogout,
}: DevicesScreenProps) {
  const suggestion = suggestDevice();

  const [devices, setDevices] = useState<PublicDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [newName, setNewName] = useState(suggestion.deviceName);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const list = await authed(session, onSessionRefreshed, (token) =>
        api.listDevices(token),
      );
      setDevices(list);
      setShowCreate(list.length === 0);
    } catch (error) {
      if (error instanceof NetworkError) {
        setListError(
          "No hay conexion con la API. Revisa la red y vuelve a intentar.",
        );
      } else if (error instanceof ApiError) {
        setListError(error.message);
      } else {
        setListError("No se pudieron cargar los dispositivos.");
      }
    } finally {
      setLoading(false);
    }
  }, [session, onSessionRefreshed]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createDevice() {
    setCreateError(null);

    const parsed = createDeviceSchema.safeParse({
      deviceName: newName,
      platform: suggestion.platform,
    });
    if (!parsed.success) {
      setCreateError(parsed.error.issues[0]?.message ?? "Datos invalidos");
      return;
    }

    setCreating(true);
    try {
      const device = await authed(session, onSessionRefreshed, (token) =>
        api.createDevice(token, parsed.data),
      );
      setDevices((previous) => [...previous, device]);
      setShowCreate(false);
      setNewName(suggestion.deviceName);
    } catch (error) {
      setCreateError(
        error instanceof ApiError
          ? error.message
          : error instanceof NetworkError
            ? "Sin conexion con la API."
            : "No se pudo vincular el dispositivo.",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>Tus dispositivos</Text>
          <Text style={styles.subtitle}>{session.user.email}</Text>
        </View>
        <Button label="Salir" onPress={onLogout} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.muted}>Cargando dispositivos...</Text>
        </View>
      ) : null}

      {listError ? <Alert message={listError} tone="error" /> : null}

      {!loading && !listError
        ? devices.map((device) => (
            <Card
              key={device.id}
              right={
                <Badge
                  label={PLATFORM_LABEL[device.platform] ?? device.platform}
                  color={colors.accent}
                />
              }
            >
              <Text style={styles.deviceName}>{device.deviceName}</Text>
              <Text style={styles.muted}>
                {device.lastSeenAt
                  ? `Ultima conexion: ${new Date(device.lastSeenAt).toLocaleString()}`
                  : "Sin conexiones registradas"}
              </Text>
              <View style={styles.spacer} />
              <Button
                label="Compartir ubicacion desde este dispositivo"
                variant="primary"
                onPress={() => onSelectDevice(device)}
              />
            </Card>
          ))
        : null}

      {!loading && !showCreate ? (
        <Button
          label="Vincular otro dispositivo"
          onPress={() => setShowCreate(true)}
        />
      ) : null}

      {showCreate ? (
        <Card title="Vincular dispositivo">
          <Text style={styles.muted}>
            Se creara un equipo asociado a tu cuenta. Usa un nombre que
            reconozcas.
          </Text>
          <View style={styles.spacer} />
          <Field
            label="Nombre del dispositivo"
            value={newName}
            onChangeText={setNewName}
            placeholder="Pixel de Juan"
            maxLength={80}
          />
          <Text style={styles.muted}>
            Plataforma detectada:{" "}
            {PLATFORM_LABEL[suggestion.platform] ?? suggestion.platform}
          </Text>
          {createError ? (
            <View style={styles.spacer}>
              <Alert message={createError} tone="error" />
            </View>
          ) : null}
          <View style={styles.spacer} />
          <Button
            label="Vincular"
            variant="primary"
            loading={creating}
            onPress={() => void createDevice()}
          />
          {devices.length > 0 ? (
            <>
              <View style={styles.spacer} />
              <Button label="Cancelar" onPress={() => setShowCreate(false)} />
            </>
          ) : null}
        </Card>
      ) : null}

      <Text style={styles.footnote}>
        Compartir es siempre una accion voluntaria y revocable. Puedes detenerla
        en cualquier momento desde la pantalla de seguimiento.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: spacing.lg,
    gap: spacing.md,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: "700" },
  subtitle: { color: colors.muted, fontSize: 13 },
  center: {
    alignItems: "center",
    paddingVertical: spacing.xl,
    gap: spacing.sm,
  },
  muted: { color: colors.muted, fontSize: 13 },
  deviceName: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
    marginBottom: spacing.xs,
  },
  spacer: { height: spacing.md },
  footnote: {
    color: colors.muted,
    fontSize: 12,
    textAlign: "center",
    marginTop: spacing.lg,
    borderRadius: radius.sm,
  },
});
