import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  DEFAULT_SHARE_DURATION_MINUTES,
  batteryBadge,
  classifyFreshness,
  type BatteryTone,
  type PublicDevice,
} from "@geo/shared";
import { Alert, Badge, Button, Card, InfoRow } from "../components/ui";
import { INTERVAL_OPTIONS } from "../config";
import { ApiError, NetworkError, api } from "../lib/api";
import { authed } from "../lib/authed";
import {
  ageSecondsFrom,
  formatAge,
  formatCoordinates,
  formatDuration,
  formatMeters,
  formatTime,
  FRESHNESS_LABEL,
} from "../lib/format";
import {
  clearShare,
  loadShare,
  saveShare,
  type StoredSession,
  type StoredShare,
} from "../lib/session";
import { useTracking } from "../hooks/useTracking";
import { colors, freshnessColor, radius, spacing } from "../theme";

interface TrackingScreenProps {
  session: StoredSession;
  device: PublicDevice;
  onSessionRefreshed: (next: StoredSession) => void;
  onBack: () => void;
}

const isExpired = (isoDate: string) =>
  new Date(isoDate).getTime() <= Date.now();

/**
 * Color de cada tono de bateria.
 *
 * Se usa la misma clasificacion que el panel (`batteryBadge` de `@geo/shared`)
 * para que el telefono y el administrador cuenten la misma historia: un 4 % no
 * es "sin datos", es "critico".
 */
const BATTERY_TONE_COLOR: Record<BatteryTone, string> = {
  none: colors.muted,
  ok: colors.ok,
  warn: colors.warn,
  critical: colors.danger,
};

/** Texto legible del permiso, sin tecnicismos. */
function permissionText(
  granted: boolean,
  canAskAgain: boolean,
  onLabel: string,
): string {
  if (granted) return onLabel;
  return canAskAgain ? "No concedido" : "Bloqueado en los ajustes";
}

export function TrackingScreen({
  session,
  device,
  onSessionRefreshed,
  onBack,
}: TrackingScreenProps) {
  const { state, start, stop } = useTracking();

  const [intervalMs, setIntervalMs] = useState(INTERVAL_OPTIONS[2]!.valueMs);
  const [share, setShare] = useState<StoredShare | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Reloj local: recalcula la antiguedad del ultimo envio cada 2 s. */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(timer);
  }, []);

  // Al entrar, se recupera una sesion de comparticion previa si sigue vigente.
  useEffect(() => {
    let active = true;
    void (async () => {
      const stored = await loadShare();
      if (!active || !stored) return;
      if (stored.deviceId !== device.id || isExpired(stored.expiresAt)) {
        await clearShare();
        return;
      }
      setShare(stored);
    })();
    return () => {
      active = false;
    };
  }, [device.id]);

  const handleShareInvalid = useCallback((message: string) => {
    void clearShare();
    setShare(null);
    setError(message);
  }, []);

  /** Abre la sesion en el servidor (si hace falta) y arranca el seguimiento. */
  const startSharing = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      let current = share;

      if (!current || isExpired(current.expiresAt)) {
        const created = await authed(session, onSessionRefreshed, (token) =>
          api.startShare(token, device.id, DEFAULT_SHARE_DURATION_MINUTES),
        );
        current = {
          shareId: created.id,
          deviceId: created.deviceId,
          shareToken: created.shareToken,
          expiresAt: created.expiresAt,
        };
        await saveShare(current);
        setShare(current);
      }

      const result = await start({
        deviceId: device.id,
        shareId: current.shareId,
        shareToken: current.shareToken,
        expiresAt: current.expiresAt,
        intervalMs,
        onShareInvalid: handleShareInvalid,
      });

      if (!result.ok) {
        setError(result.error ?? "No se pudo iniciar el seguimiento.");
      }
    } catch (caught) {
      if (caught instanceof NetworkError) {
        setError(
          "No hay conexion con la API: no se pudo abrir la sesion de comparticion.",
        );
      } else if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError("No se pudo iniciar la comparticion.");
      }
    } finally {
      setBusy(false);
    }
  }, [
    share,
    session,
    onSessionRefreshed,
    device.id,
    start,
    intervalMs,
    handleShareInvalid,
  ]);

  /** Detiene el servicio y cierra la sesion en el servidor. */
  const stopSharing = useCallback(async () => {
    setBusy(true);
    setError(null);
    await stop();

    if (share) {
      try {
        await authed(session, onSessionRefreshed, (token) =>
          api.stopShare(token, share.shareId, "Detenida desde la app movil"),
        );
      } catch {
        // Si no se pudo avisar al servidor, se limpia igualmente en local: la
        // sesion expirara por si sola.
      }
      await clearShare();
      setShare(null);
    }

    setBusy(false);
  }, [stop, share, session, onSessionRefreshed]);

  const tracking = state.status === "tracking";
  const lastSent = state.lastSent;
  const permissions = state.permissions;
  const battery = state.battery;
  const batteryBadgeValue = battery ? batteryBadge(battery.percent) : null;

  const ageSeconds = lastSent ? ageSecondsFrom(lastSent.recordedAt, now) : null;
  const freshness = classifyFreshness(ageSeconds);

  const intervalLabel = useMemo(
    () =>
      INTERVAL_OPTIONS.find((option) => option.valueMs === intervalMs)?.label ??
      `${intervalMs} ms`,
    [intervalMs],
  );

  const backgroundStatus = !state.backgroundEnabled
    ? "Permiso pendiente"
    : tracking
      ? Platform.OS === "android"
        ? "Activo (servicio en primer plano)"
        : "Activo (segundo plano)"
      : state.sessionActive
        ? "Sesion guardada, servicio detenido"
        : "Inactivo";

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>{device.deviceName}</Text>
          <Text style={styles.muted}>
            Compartiendo desde este telefono mientras este activo
          </Text>
        </View>
        <Button label="Atras" onPress={onBack} />
      </View>

      {error ? <Alert message={error} tone="error" /> : null}

      {/* ---------------------------- Estado ---------------------------- */}
      <Card
        title="Estado del seguimiento"
        right={
          <Badge
            label={
              tracking
                ? "Activo"
                : state.status === "error"
                  ? "Detenido"
                  : "Inactivo"
            }
            color={
              tracking
                ? colors.ok
                : state.status === "error"
                  ? colors.danger
                  : colors.muted
            }
          />
        }
      >
        <InfoRow
          label="GPS del telefono"
          value={state.servicesEnabled ? "Activado" : "Desactivado"}
        />
        <InfoRow
          label="Conexion con la API"
          value={state.offline ? "Sin conexion (reintentando)" : "Correcta"}
        />
        <InfoRow label="Frecuencia elegida" value={intervalLabel} />
        <InfoRow label="Lecturas aceptadas" value={String(state.sentCount)} />
        {state.pendingCount > 0 ? (
          <InfoRow
            label="Pendientes por reenviar"
            value={`${state.pendingCount} (se guardan y se reenvian)`}
          />
        ) : null}
        {state.lastAttemptAt ? (
          <InfoRow
            label="Ultimo intento de envio"
            value={formatTime(state.lastAttemptAt)}
          />
        ) : null}
        {share ? (
          <InfoRow
            label="La sesion expira"
            value={new Date(share.expiresAt).toLocaleString()}
          />
        ) : null}
      </Card>

      {/* ------------------------- Segundo plano ------------------------- */}
      <Card
        title="Compartir en segundo plano"
        right={
          <Badge
            label={state.backgroundEnabled ? "Permitido" : "Sin permiso"}
            color={state.backgroundEnabled ? colors.ok : colors.warn}
          />
        }
      >
        <InfoRow
          label={
            Platform.OS === "android"
              ? "Servicio del sistema"
              : "Ubicacion en segundo plano"
          }
          value={backgroundStatus}
        />
        <InfoRow
          label="Permiso"
          value={
            permissions?.backgroundGranted
              ? "Permitir todo el tiempo / Siempre"
              : permissions?.foregroundGranted
                ? "Solo con la app abierta"
                : "No concedido"
          }
        />
        {Platform.OS === "android" ? (
          <InfoRow
            label="Notificacion del servicio"
            value={
              permissions?.notifications === "granted"
                ? "Visible"
                : "No visible (el servicio igual funciona)"
            }
          />
        ) : null}
        <View style={styles.spacer} />
        <Text style={styles.muted}>
          {Platform.OS === "android"
            ? "Con el permiso de segundo plano la app muestra una notificacion permanente y sigue enviando ubicacion aunque cambies de aplicacion o bloquees la pantalla."
            : "Con el permiso 'Siempre' iOS mantiene el seguimiento en segundo plano y muestra el indicador azul del sistema."}
        </Text>
      </Card>

      {/* ------------------------------ Bateria ------------------------------ */}
      <Card
        title="Bateria y consumo"
        right={
          batteryBadgeValue ? (
            <Badge
              label={batteryBadgeValue.label}
              color={BATTERY_TONE_COLOR[batteryBadgeValue.tone]}
            />
          ) : null
        }
      >
        <InfoRow
          label="Tramo aplicado"
          value={battery ? battery.policy.label : "Sin dato"}
        />
        <InfoRow
          label="Frecuencia aplicada"
          value={
            battery
              ? `cada ${formatDuration(battery.effectiveIntervalMs)}`
              : "-"
          }
        />
        <InfoRow
          label="Precision aplicada"
          value={
            battery
              ? battery.precision === "high"
                ? "Alta"
                : "Equilibrada (menos consumo)"
              : "-"
          }
        />
        <InfoRow
          label="Estado de carga"
          value={
            battery ? (battery.charging ? "Cargando" : "Con bateria") : "Sin dato"
          }
        />
        <View style={styles.spacer} />
        <Text style={styles.muted}>
          {battery
            ? battery.policy.description
            : "Todavia no se ha podido leer el nivel de bateria; el seguimiento usa la frecuencia elegida."}
        </Text>
        {battery?.policy.warning ? (
          <Text style={styles.warnText}>
            Con poca bateria se espacian las actualizaciones, pero el
            seguimiento no se detiene. Si el telefono se apaga antes del
            siguiente envio, el panel lo vera como datos desactualizados.
          </Text>
        ) : null}
      </Card>

      {/* ---------------------------- Permisos ---------------------------- */}
      <Card title="Permisos del sistema">
        <InfoRow
          label="Ubicacion (primer plano)"
          value={permissionText(
            permissions?.foregroundGranted ?? false,
            permissions?.foregroundCanAsk ?? true,
            "Concedido",
          )}
        />
        <InfoRow
          label="Ubicacion (segundo plano)"
          value={permissionText(
            permissions?.backgroundGranted ?? false,
            permissions?.backgroundCanAsk ?? true,
            "Concedido",
          )}
        />
        <InfoRow
          label="Precision"
          value={
            permissions?.foregroundGranted
              ? permissions.precise
                ? "Precisa"
                : "Aproximada"
              : "-"
          }
        />
        <View style={styles.spacer} />
        {state.needsSettings ? (
          <Text style={styles.warnText}>
            Falta un permiso que solo se puede activar desde los ajustes del
            sistema. La app no lo volvera a pedir en cada arranque.
          </Text>
        ) : null}
        <Button
          label="Abrir ajustes de permisos"
          onPress={() => void Linking.openSettings()}
        />
      </Card>

      {/* --------------------------- Ultima posicion --------------------------- */}
      <Card
        title="Ultima posicion enviada"
        right={
          lastSent ? (
            <Badge
              label={`${FRESHNESS_LABEL[freshness]} · ${formatAge(ageSeconds)}`}
              color={freshnessColor[freshness] ?? colors.muted}
            />
          ) : null
        }
      >
        {lastSent ? (
          <>
            <InfoRow
              label="Coordenadas"
              value={formatCoordinates(lastSent.latitude, lastSent.longitude)}
              mono
            />
            <InfoRow
              label="Precision"
              value={formatMeters(lastSent.accuracyMeters)}
            />
            <InfoRow
              label="Capturada"
              value={formatTime(lastSent.recordedAt)}
            />
            <InfoRow
              label="Recibida por el servidor"
              value={formatTime(lastSent.sentAt)}
            />
            <InfoRow
              label="Origen de la captura"
              value={
                lastSent.background
                  ? "Servicio en segundo plano"
                  : "App en primer plano"
              }
            />
          </>
        ) : (
          <Text style={styles.muted}>
            Aun no se ha enviado ninguna lectura. Pulsa &quot;Iniciar
            comparticion&quot;.
          </Text>
        )}
      </Card>

      {/* ----------------------------- Controles ----------------------------- */}
      <Card title="Frecuencia de envio">
        <View style={styles.intervalRow}>
          {INTERVAL_OPTIONS.map((option) => {
            const active = option.valueMs === intervalMs;
            return (
              <Text
                key={option.valueMs}
                onPress={() => setIntervalMs(option.valueMs)}
                style={[styles.chip, active && styles.chipActive]}
              >
                {option.label}
              </Text>
            );
          })}
        </View>
        <Text style={styles.muted}>
          La frecuencia es una peticion al sistema: Android la respeta; iOS la
          aproxima segun el movimiento y la bateria. Una frecuencia alta da un
          trazo mas fino pero consume mas bateria y datos.
        </Text>
        <View style={styles.spacer} />
        {tracking ? (
          <Button
            label="Detener comparticion"
            variant="danger"
            loading={busy}
            onPress={() => void stopSharing()}
          />
        ) : (
          <Button
            label={share ? "Reanudar comparticion" : "Iniciar comparticion"}
            variant="primary"
            loading={busy || state.status === "starting"}
            onPress={() => void startSharing()}
          />
        )}
        {state.status === "starting" ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.muted}>Solicitando permisos y GPS...</Text>
          </View>
        ) : null}
      </Card>

      {state.lastError ? <Alert message={state.lastError} tone="info" /> : null}

      {/* ------------------------------- Ayuda ------------------------------- */}
      <Card title="Que ocurre segun el estado del telefono">
        <InfoRow label="App abierta" value="Ubicacion en vivo" />
        <InfoRow
          label="Cambias a otra app"
          value="Sigue compartiendo (con permiso de segundo plano)"
        />
        <InfoRow
          label="Pantalla bloqueada"
          value="Puede seguir en segundo plano"
        />
        <InfoRow
          label="App quitada de recientes"
          value="Depende del sistema y del fabricante"
        />
        <InfoRow
          label="App forzada a detenerse"
          value="No se puede garantizar el envio"
        />
        <InfoRow
          label="Celular sin conexion"
          value="Se guarda y se reenvia cuando vuelva la red"
        />
        <InfoRow label="Celular apagado" value="No envia nuevas ubicaciones" />
        <View style={styles.spacer} />
        <Text style={styles.muted}>
          El seguimiento solo funciona si esta activo y con los permisos
          concedidos. Android e iOS pueden suspender o terminar la app por
          bateria, privacidad o configuracion del sistema; no prometemos envio
          ininterrumpido tras un cierre forzado.
        </Text>
        <View style={styles.spacer} />
        <Text style={styles.muted}>
          La ubicacion no se obtiene a partir de un numero de telefono, y el
          microfono, la camara, las llamadas o las conversaciones nunca se
          consultan. Puedes revocar los permisos en cualquier momento.
        </Text>
      </Card>
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
  headerText: { flexShrink: 1 },
  title: { color: colors.text, fontSize: 22, fontWeight: "700" },
  muted: { color: colors.muted, fontSize: 13 },
  warnText: { color: colors.warn, fontSize: 13, marginBottom: spacing.md },
  intervalRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSoft,
    color: colors.muted,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 13,
    overflow: "hidden",
  },
  chipActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
    color: colors.accent,
    fontWeight: "700",
  },
  spacer: { height: spacing.md },
  center: {
    alignItems: "center",
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
});
