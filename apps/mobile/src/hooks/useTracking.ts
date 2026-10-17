import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import * as Location from "expo-location";
import {
  flushPositions,
  isBackgroundTrackingRegistered,
  readCurrentPosition,
  startBackgroundTracking,
  stopBackgroundTracking,
  SHARE_INVALID_MESSAGE,
} from "../lib/background-location";
import {
  clearTrackingSession,
  loadStats,
  loadTrackingSession,
  resetTrackingStats,
  saveTrackingSession,
  subscribeToTracking,
  type SentPoint,
  type TrackingSession,
  type TrackingStats,
} from "../lib/tracking-store";
import {
  ensureTrackingPermissions,
  readPermissions,
  type PermissionsSnapshot,
} from "../lib/permissions";
import { getApiBaseUrl } from "../lib/api";
import {
  readBattery,
  subscribeBatteryChanges,
  type BatterySnapshot,
} from "../lib/battery";

export type TrackingStatus = "idle" | "starting" | "tracking" | "error";

export interface TrackingState {
  status: TrackingStatus;
  /** Ultima coordenada aceptada por el servidor. */
  lastSent: SentPoint | null;
  /** Lecturas guardadas por falta de conexion. */
  pendingCount: number;
  /** Total de lecturas aceptadas por el servidor en esta sesion. */
  sentCount: number;
  /** Ultimo mensaje de error legible. */
  lastError: string | null;
  /** Estado del GPS del telefono. */
  servicesEnabled: boolean;
  /** true cuando falta conexion con la API. */
  offline: boolean;
  /** La tarea de ubicacion esta registrada en el sistema operativo. */
  registered: boolean;
  /** Hay una sesion de comparticion guardada (aunque el servicio este parado). */
  sessionActive: boolean;
  /** Permiso de segundo plano concedido: sigue con la pantalla bloqueada. */
  backgroundEnabled: boolean;
  /** Falta que el usuario conceda algo desde los ajustes del sistema. */
  needsSettings: boolean;
  /** Momento en que se inicio el seguimiento. */
  startedAt: string | null;
  /** Ultimo intento de envio (para indicar actividad real). */
  lastAttemptAt: string | null;
  /** Instantanea de permisos para la pantalla. */
  permissions: PermissionsSnapshot | null;
  /**
   * Estado de bateria y politica aplicada. Es lo que permite mostrar "bateria
   * baja: se reduce la frecuencia" sin detener nunca el seguimiento.
   */
  battery: BatterySnapshot | null;
}

export interface TrackingConfig {
  deviceId: string;
  shareId: string;
  shareToken: string;
  expiresAt: string;
  intervalMs: number;
  /** Se invoca cuando la sesion de comparticion deja de ser valida. */
  onShareInvalid?: (message: string) => void;
}

const INITIAL_STATE: TrackingState = {
  status: "idle",
  lastSent: null,
  pendingCount: 0,
  sentCount: 0,
  lastError: null,
  servicesEnabled: true,
  offline: false,
  registered: false,
  sessionActive: false,
  backgroundEnabled: false,
  needsSettings: false,
  startedAt: null,
  lastAttemptAt: null,
  permissions: null,
  battery: null,
};

/** Frecuencia minima efectiva, para no castigar la bateria ni la red. */
const MIN_INTERVAL_MS = 3_000;
/** Cada cuanto se relee el estado persistido mientras se comparte. */
const POLL_INTERVAL_MS = 4_000;

/**
 * Orquesta el seguimiento de ubicacion (primer plano y segundo plano).
 *
 * El trabajo pesado vive en `background-location.ts` (tarea del sistema). Este
 * hook solo decide cuando arrancar/parar, gestiona los permisos y mantiene el
 * estado visible para la pantalla leyendo el almacen persistente.
 */
export function useTracking() {
  const [state, setState] = useState<TrackingState>(INITIAL_STATE);

  const mountedRef = useRef(true);
  const invalidNotifiedRef = useRef(false);
  const onShareInvalidRef = useRef<TrackingConfig["onShareInvalid"]>(undefined);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const batteryRef = useRef<BatterySnapshot | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  /** Marca la sesion como invalida una sola vez y avisa a la pantalla. */
  const handleShareInvalid = useCallback(async () => {
    if (invalidNotifiedRef.current) return;
    invalidNotifiedRef.current = true;

    await stopBackgroundTracking();
    await clearTrackingSession();
    stopPolling();

    if (!mountedRef.current) return;
    setState((previous) => ({
      ...previous,
      status: "error",
      registered: false,
      sessionActive: false,
      backgroundEnabled: false,
      offline: false,
      pendingCount: 0,
      lastError: SHARE_INVALID_MESSAGE,
    }));
    onShareInvalidRef.current?.(SHARE_INVALID_MESSAGE);
  }, [stopPolling]);

  /** Relee el estado persistido y los permisos, y actualiza la pantalla. */
  const refresh = useCallback(async () => {
    const [session, stats, registered, permissions, servicesEnabled] =
      await Promise.all([
        loadTrackingSession(),
        loadStats(),
        isBackgroundTrackingRegistered(),
        readPermissions(),
        Location.hasServicesEnabledAsync().catch(() => true),
      ]);

    if (!mountedRef.current) return;

    // Se relee en cada refresco (llamada nativa barata) para que la pantalla no
    // muestre nunca un nivel de bateria viejo.
    const battery = await readBattery(session?.intervalMs ?? MIN_INTERVAL_MS);
    batteryRef.current = battery;

    if (stats.shareInvalid) {
      await handleShareInvalid();
      return;
    }

    const tracking = registered && session !== null;

    setState((previous) => ({
      ...previous,
      status: tracking ? "tracking" : previous.status === "error" ? "error" : "idle",
      lastSent: stats.lastSent,
      pendingCount: stats.pendingCount,
      sentCount: stats.sentCount,
      offline: stats.offline,
      lastError: stats.lastError,
      lastAttemptAt: stats.lastAttemptAt,
      servicesEnabled,
      registered,
      sessionActive: session !== null,
      backgroundEnabled: permissions.backgroundGranted,
      permissions,
      startedAt: session?.startedAt ?? previous.startedAt,
      battery,
    }));
  }, [handleShareInvalid]);

  /**
   * Reacciona a un cambio de bateria.
   *
   * Hace dos cosas, y ninguna detiene el seguimiento: refrescar el nivel que ve
   * el usuario y, si cambio el **tramo** de politica, volver a negociar con el
   * sistema la frecuencia y la precision. Eso ultimo solo se hace en primer
   * plano: reiniciar el servicio desde una tarea en segundo plano puede impedir
   * que Android lo arranque y se perderia el seguimiento.
   */
  const applyBattery = useCallback(async () => {
    const session = await loadTrackingSession();
    const snapshot = await readBattery(session?.intervalMs ?? MIN_INTERVAL_MS);
    const previousTier = batteryRef.current?.policy.tier ?? null;
    batteryRef.current = snapshot;

    if (mountedRef.current) {
      setState((previous) => ({ ...previous, battery: snapshot }));
    }

    if (
      !session ||
      previousTier === null ||
      previousTier === snapshot.policy.tier
    ) {
      return;
    }

    const registered = await isBackgroundTrackingRegistered();
    if (!registered) return;
    try {
      await startBackgroundTracking(session, snapshot);
    } catch {
      // Si el sistema rechaza el reinicio, nada se rompe: sigue con la
      // frecuencia anterior. Lo que nunca se hace es detener el seguimiento.
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
  }, [refresh, stopPolling]);

  // Arranque: estado inicial, suscripcion a cambios y refresco al volver a foco.
  useEffect(() => {
    mountedRef.current = true;
    void refresh();

    const unsubscribe = subscribeToTracking((stats: TrackingStats) => {
      if (!mountedRef.current) return;
      if (stats.shareInvalid) {
        void handleShareInvalid();
        return;
      }
      setState((previous) => ({
        ...previous,
        sentCount: stats.sentCount,
        pendingCount: stats.pendingCount,
        offline: stats.offline,
        lastSent: stats.lastSent,
        lastError: stats.lastError,
        lastAttemptAt: stats.lastAttemptAt,
      }));
    });

    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void refresh();
    });

    // La bateria se vigila tambien entre refrescos: los avisos del sistema
    // llegan antes que el sondeo periodico.
    const unsubscribeBattery = subscribeBatteryChanges(() => {
      void applyBattery();
    });

    return () => {
      mountedRef.current = false;
      unsubscribe();
      subscription.remove();
      unsubscribeBattery();
      stopPolling();
    };
  }, [refresh, handleShareInvalid, stopPolling, applyBattery]);

  /** Solicita permisos y arranca el seguimiento (servicio en segundo plano). */
  const start = useCallback(
    async (
      config: TrackingConfig,
    ): Promise<{ ok: boolean; error?: string; needsSettings?: boolean }> => {
      setState((previous) => ({
        ...previous,
        status: "starting",
        lastError: null,
        needsSettings: false,
      }));

      if (Platform.OS === "web") {
        const message =
          "El seguimiento en segundo plano solo esta disponible en la app movil (build nativo).";
        setState((previous) => ({
          ...previous,
          status: "error",
          lastError: message,
        }));
        return { ok: false, error: message };
      }

      try {
        const servicesEnabled = await Location.hasServicesEnabledAsync();
        if (!servicesEnabled) {
          const message =
            "El GPS del telefono esta desactivado. Activalo para compartir tu posicion.";
          setState((previous) => ({
            ...previous,
            status: "error",
            servicesEnabled: false,
            lastError: message,
          }));
          return { ok: false, error: message };
        }

        const permission = await ensureTrackingPermissions();
        const permissions = await readPermissions();

        if (!permission.ok) {
          const message =
            permission.message ??
            "Faltan permisos para el seguimiento en segundo plano.";
          setState((previous) => ({
            ...previous,
            status: "error",
            permissions,
            needsSettings: permission.needsSettings,
            lastError: message,
          }));
          return { ok: false, error: message, needsSettings: permission.needsSettings };
        }

        const session: TrackingSession = {
          deviceId: config.deviceId,
          shareId: config.shareId,
          shareToken: config.shareToken,
          expiresAt: config.expiresAt,
          intervalMs: Math.max(MIN_INTERVAL_MS, config.intervalMs),
          apiUrl: getApiBaseUrl(),
          startedAt: new Date().toISOString(),
        };

        await resetTrackingStats();
        await saveTrackingSession(session);
        onShareInvalidRef.current = config.onShareInvalid;
        invalidNotifiedRef.current = false;

        // La frecuencia inicial ya tiene en cuenta la bateria. Nunca la
        // desactiva: solo espacia las actualizaciones.
        const battery = await readBattery(session.intervalMs);
        batteryRef.current = battery;
        await startBackgroundTracking(session, battery);

        // Primer envio inmediato, para no esperar a la primera entrega del SO.
        const current = await readCurrentPosition();
        if (current) await flushPositions([current], "foreground");

        const stats = await loadStats();

        if (!mountedRef.current) return { ok: true };

        setState({
          status: "tracking",
          lastSent: stats.lastSent,
          pendingCount: stats.pendingCount,
          sentCount: stats.sentCount,
          lastError: stats.offline
            ? "Sin conexion: las lecturas se guardan y se reenviaran."
            : stats.lastError,
          servicesEnabled: true,
          offline: stats.offline,
          registered: true,
          sessionActive: true,
          backgroundEnabled: true,
          needsSettings: false,
          startedAt: session.startedAt,
          lastAttemptAt: stats.lastAttemptAt,
          permissions,
          battery,
        });

        startPolling();
        return { ok: true };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "No se pudo iniciar el seguimiento en segundo plano.";
        setState((previous) => ({
          ...previous,
          status: "error",
          lastError: message,
        }));
        return { ok: false, error: message };
      }
    },
    [startPolling],
  );

  /** Detiene el servicio y descarta la sesion local (no toca el servidor). */
  const stop = useCallback(async () => {
    await stopBackgroundTracking();
    await clearTrackingSession();
    await resetTrackingStats();
    invalidNotifiedRef.current = false;
    stopPolling();

    if (!mountedRef.current) return;
    setState((previous) => ({
      ...previous,
      status: "idle",
      lastSent: null,
      pendingCount: 0,
      sentCount: 0,
      offline: false,
      registered: false,
      sessionActive: false,
      backgroundEnabled: false,
      startedAt: null,
      lastAttemptAt: null,
      needsSettings: false,
      lastError: null,
    }));
  }, [stopPolling]);

  return { state, start, stop, refresh };
}
