import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import type { IngestLocationInput, PublicLocation } from "@geo/shared";
import { ApiError, NetworkError, api, setApiBaseUrl } from "./api";
import {
  foregroundNotificationBody,
  readBattery,
  type BatterySnapshot,
} from "./battery";
import { collectDeviceMetadata, type DeviceMetadata } from "./device-metadata";
import {
  clearTrackingSession,
  loadQueue,
  loadStats,
  loadTrackingSession,
  saveQueue,
  updateStats,
  type TrackingSession,
} from "./tracking-store";

/**
 * Seguimiento de ubicacion en segundo plano.
 *
 * Como funciona:
 *   `Location.startLocationUpdatesAsync` registra una tarea del sistema
 *   (`expo-task-manager`). El sistema operativo entrega las coordenadas a la
 *   tarea, que se ejecuta:
 *     - con la app en primer plano,
 *     - con la app minimizada o la pantalla bloqueada, y
 *     - en Android, dentro de un servicio en primer plano con una notificacion
 *       permanente visible mientras el seguimiento esta activo.
 *   La tarea NO depende de que la pantalla de React este montada: lee la
 *   configuracion desde `tracking-store` y envia con `fetch`.
 *
 * Bateria (requisito explicito):
 *   El seguimiento **nunca se detiene por bateria baja**. Lo que cambia es el
 *   consumo: con poca bateria se amplia el intervalo y se baja la precision
 *   (politica compartida en `@geo/shared/battery`). En primer plano ese cambio
 *   se reaplica al servicio; en segundo plano no se renegocia el intervalo,
 *   porque reiniciar el servicio desde una tarea del sistema puede impedir que
 *   Android arranque el servicio en primer plano. Alli lo que se espacia es el
 *   envio (`coalescePositions`): se conserva la lectura mas reciente y se
 *   descartan las intermedias que ya quedaron superadas por ella.
 *
 * Limites reales (no se ocultan):
 *   - Si el usuario fuerza la detencion de la app, el sistema puede no volver a
 *     lanzar la tarea. Android e iOS pueden suspender o terminar la app por
 *     bateria, privacidad o configuracion. No se puede garantizar el envio tras
 *     un cierre forzado, con el telefono apagado o si se revoca el permiso.
 *   - La frecuencia real de entrega la decide el sistema; `intervalMs` es una
 *     peticion, no una promesa.
 */

export const BACKGROUND_LOCATION_TASK = "geo-background-location";

export const SHARE_INVALID_MESSAGE =
  "La sesion de comparticion ya no es valida (detenida, revocada o expirada).";

/** Limite de lecturas guardadas sin conexion (evita crecer sin control). */
export const MAX_QUEUE = 50;

/** Maximo de posiciones procesadas por lote entregado por el sistema. */
const MAX_BATCH = 20;

/**
 * Convierte una lectura de `expo-location` al formato validado por el backend.
 *
 * `expo-location` devuelve -1 en `speed`/`heading` cuando no puede determinarlos
 * y `null` en `accuracy` en algunos equipos; aqui se normaliza a null o a un
 * rango valido, porque el esquema compartido rechaza valores fuera de rango.
 */
export function toIngestInput(
  position: Location.LocationObject,
  metadata: DeviceMetadata,
): IngestLocationInput {
  const { coords, timestamp } = position;

  const accuracy = Number.isFinite(coords.accuracy)
    ? Math.max(0, coords.accuracy as number)
    : 0;

  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracyMeters: accuracy,
    altitudeMeters:
      typeof coords.altitude === "number" ? coords.altitude : null,
    speedMps:
      typeof coords.speed === "number" && coords.speed >= 0
        ? coords.speed
        : null,
    headingDegrees:
      typeof coords.heading === "number" &&
      coords.heading >= 0 &&
      coords.heading <= 360
        ? coords.heading
        : null,
    // Se registra el instante de captura, no el de envio: asi un dato que estuvo
    // retenido se muestra como antiguo en el panel, no como recien llegado.
    recordedAt: new Date(timestamp).toISOString(),
    ...metadata,
  };
}

// ---------------------------------------------------------------------------
// Serializacion de envios: la tarea y la pantalla pueden coincidir.
// ---------------------------------------------------------------------------
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

function isExpired(iso: string): boolean {
  return new Date(iso).getTime() <= Date.now();
}

/**
 * Intervalo minimo entre envios cuando la bateria obliga a espaciarlos.
 *
 * Devuelve 0 en el tramo optimo (o cuando no hay dato de bateria): en ese caso
 * el comportamiento es exactamente el de antes de existir esta politica.
 */
function sendIntervalFor(battery: BatterySnapshot): number {
  return battery.policy.intervalMultiplier > 1 ? battery.effectiveIntervalMs : 0;
}

/**
 * Espacia las lecturas segun el intervalo efectivo de la bateria.
 *
 * Como se decide: se recorre la lista en orden y se conserva un punto solo si
 * dista al menos `minIntervalMs` del ultimo punto **aceptado por el servidor**
 * (`anchorMs`) o del ultimo punto ya conservado. Las lecturas descartadas NO se
 * guardan para despues: son posiciones ya superadas por la siguiente, y
 * retenerlas gastaria radio y bateria justo cuando lo que se busca es lo
 * contrario.
 *
 * Consecuencia asumida y documentada: en los tramos bajos el panel puede ver la
 * ultima posicion con mas antiguedad que antes (por eso el panel distingue
 * "bateria baja" de "datos desactualizados").
 */
export function coalescePositions(
  points: IngestLocationInput[],
  minIntervalMs: number,
  anchorMs: number | null = null,
): IngestLocationInput[] {
  if (points.length === 0 || minIntervalMs <= 0) return points;

  const kept: IngestLocationInput[] = [];
  let lastMs = anchorMs;

  for (const point of points) {
    const capturedMs = point.recordedAt ? Date.parse(point.recordedAt) : Number.NaN;
    if (!Number.isFinite(capturedMs)) {
      // Sin fecha utilizable no se puede decidir: se envia (mejor de mas que
      // perder una lectura valida).
      kept.push(point);
      continue;
    }
    if (lastMs === null || capturedMs - lastMs >= minIntervalMs) {
      kept.push(point);
      lastMs = capturedMs;
    }
  }

  return kept;
}

/** Marca la sesion como invalida, detiene el servicio y limpia la sesion. */
async function handleInvalid(message: string): Promise<void> {
  await stopBackgroundTracking();
  await clearTrackingSession();
  await updateStats({
    shareInvalid: true,
    offline: false,
    pendingCount: 0,
    lastError: message,
    lastAttemptAt: new Date().toISOString(),
  });
}

/**
 * Envia al backend una tanda de posiciones (las nuevas mas lo que quedo
 * pendiente). Si no hay conexion, lo pendiente vuelve a la cola.
 */
export async function flushPositions(
  positions: Location.LocationObject[],
  origin: "background" | "foreground",
): Promise<void> {
  return serialize(async () => {
    if (positions.length === 0) return;

    const session = await loadTrackingSession();
    if (!session) return;

    if (isExpired(session.expiresAt)) {
      await handleInvalid("La sesion de comparticion expiro.");
      return;
    }

    // En un proceso headless el modulo `api` puede tener otra URL base: se
    // restablece con la que se guardo al iniciar el seguimiento.
    setApiBaseUrl(session.apiUrl);

    // La bateria se lee en cada envio: se adjunta al panel como contexto y, si
    // esta en los tramos bajos, espacia los envios (nunca detiene el rastreo).
    const battery = await readBattery(session.intervalMs);
    const metadata = collectDeviceMetadata(
      "granted_background",
      battery.percent,
    );
    const queued = await loadQueue();
    const incoming = positions
      .slice(-MAX_BATCH)
      .map((position) => toIngestInput(position, metadata));

    // El intervalo efectivo se mide desde el ultimo punto aceptado por el
    // servidor, no desde el ultimo capturado: asi el espaciado se mantiene
    // aunque el sistema entregue las lecturas a rafagas.
    const stats = await loadStats();
    const anchorMs = stats.lastSent
      ? Date.parse(stats.lastSent.recordedAt)
      : null;
    const batch = coalescePositions(
      [...queued, ...incoming],
      sendIntervalFor(battery),
      Number.isFinite(anchorMs) ? anchorMs : null,
    ).slice(-MAX_QUEUE);

    const remaining: IngestLocationInput[] = [];
    let accepted = 0;
    let lastStored: PublicLocation | null = null;
    let lastFailure: string | null = null;
    let offline = false;

    for (let index = 0; index < batch.length; index += 1) {
      const point = batch[index]!;
      try {
        const stored = await api.ingestLocation(session.shareToken, point);
        accepted += 1;
        lastStored = stored;
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          await handleInvalid(SHARE_INVALID_MESSAGE);
          return;
        }
        if (error instanceof NetworkError) {
          // Sin red: se conserva este punto y todos los siguientes.
          offline = true;
          remaining.push(...batch.slice(index));
          break;
        }
        // Error de validacion: el punto no sirve, se descarta pero se informa.
        lastFailure =
          error instanceof Error ? error.message : "Lectura rechazada.";
      }
    }

    await saveQueue(remaining);
    await updateStats((previous) => ({
      sentCount: previous.sentCount + accepted,
      pendingCount: remaining.length,
      offline,
      lastError: offline
        ? "Sin conexion: las lecturas se guardan y se reenviaran."
        : lastFailure,
      lastSent: lastStored
        ? {
            latitude: lastStored.latitude,
            longitude: lastStored.longitude,
            accuracyMeters: lastStored.accuracyMeters,
            recordedAt: lastStored.recordedAt,
            sentAt: lastStored.receivedAt,
            background: origin === "background",
          }
        : previous.lastSent,
      lastAttemptAt: new Date().toISOString(),
    }));
  });
}

// ---------------------------------------------------------------------------
// Registro de la tarea.
//
// `defineTask` DEBE ejecutarse en el ambito global del bundle (no dentro de un
// componente): cuando el sistema despierta la app en segundo plano no se monta
// ninguna pantalla, pero el modulo si se evalua. `index.js` importa este archivo
// para garantizarlo.
// ---------------------------------------------------------------------------
try {
  TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(
    BACKGROUND_LOCATION_TASK,
    async ({ data, error }) => {
      if (error) {
        await updateStats({
          lastError: `Servicio de ubicacion: ${error.message}`,
          lastAttemptAt: new Date().toISOString(),
        });
        return;
      }
      const locations = data?.locations ?? [];
      if (locations.length === 0) return;
      await flushPositions(locations, "background");
    },
  );
} catch {
  // En web `expo-task-manager` no esta soportado; la app movil es la unica que
  // usa el seguimiento en segundo plano.
}

// ---------------------------------------------------------------------------
// Arranque / parada del servicio
// ---------------------------------------------------------------------------
export async function isBackgroundTrackingRegistered(): Promise<boolean> {
  if (Platform.OS === "web") return false;
  try {
    return await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
  } catch {
    return false;
  }
}

/**
 * Arranca (o reinicia) las actualizaciones de ubicacion en segundo plano.
 *
 * `battery` es opcional: la pantalla ya tiene una lectura reciente y no hace
 * falta volver a consultar el nativo. Si no se pasa, se lee aqui.
 */
export async function startBackgroundTracking(
  session: TrackingSession,
  battery?: BatterySnapshot,
): Promise<void> {
  if (Platform.OS === "web") {
    throw new Error(
      "El seguimiento en segundo plano solo esta disponible en la app movil.",
    );
  }

  await stopBackgroundTracking();
  setApiBaseUrl(session.apiUrl);

  // La frecuencia y la precision se ajustan al nivel de bateria. El intervalo
  // se espacia, nunca se cancela: si el telefono se apaga, el panel vera los
  // datos como desactualizados.
  const snapshot = battery ?? (await readBattery(session.intervalMs));

  const options: Location.LocationTaskOptions = {
    accuracy:
      snapshot.precision === "high"
        ? Location.Accuracy.High
        : Location.Accuracy.Balanced,
    // Frecuencia solicitada (ya adaptada a la bateria). Android la respeta;
    // iOS la aproxima segun el movimiento y la decision del sistema.
    timeInterval: snapshot.effectiveIntervalMs,
    // Sin filtro por distancia: se quiere un latido temporal constante para que
    // el panel pueda distinguir "quieto" de "sin datos".
    distanceInterval: 0,
    deferredUpdatesInterval: snapshot.effectiveIntervalMs,
    // No pausar automaticamente: se quiere un rastro continuo mientras el
    // usuario comparte de forma explicita.
    pausesUpdatesAutomatically: false,
    // iOS muestra el indicador azul del sistema (transparencia para el usuario).
    showsBackgroundLocationIndicator: true,
    activityType: Location.LocationActivityType.Other,
    ...(Platform.OS === "android"
      ? {
          foregroundService: {
            notificationTitle: "Geolocalizador: compartiendo ubicacion",
            notificationBody: foregroundNotificationBody(snapshot),
            notificationColor: "#0b1120",
            killServiceOnDestroy: false,
          },
        }
      : {}),
  };

  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, options);
}

/** Detiene el servicio de ubicacion en segundo plano si esta activo. */
export async function stopBackgroundTracking(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    }
  } catch {
    /* si ya estaba detenido, no hay nada que hacer */
  }
}

/** Una lectura puntual en primer plano, para dar feedback inmediato al iniciar. */
export async function readCurrentPosition(): Promise<Location.LocationObject | null> {
  try {
    return await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });
  } catch {
    return null;
  }
}
