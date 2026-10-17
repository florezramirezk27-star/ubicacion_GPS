import AsyncStorage from "@react-native-async-storage/async-storage";
import type { IngestLocationInput } from "@geo/shared";

/**
 * Almacen persistente del seguimiento.
 *
 * Por que existe:
 *   La captura en segundo plano corre dentro de una tarea del sistema
 *   (`expo-task-manager`). Esa tarea puede ejecutarse en un contexto de JS
 *   distinto al de la pantalla, o incluso con la app cerrada. Por eso TODO lo
 *   que la tarea necesita (la sesion de comparticion, la cola de lecturas sin
 *   enviar y las estadisticas) tiene que vivir en almacenamiento persistente,
 *   no en memoria.
 *
 * Que se guarda:
 *   - `session`: datos de la comparticion activa (dispositivo, token, expira,
 *     frecuencia, URL de la API). El token es un secreto, asi que se guarda con
 *     `expo-secure-store` (ver `session.ts`); aqui solo se guarda la parte no
 *     sensible con AsyncStorage para poder leerla desde la tarea.
 *   - `queue`: lecturas obtenidas sin conexion, a la espera de reenvio.
 *   - `stats`: contadores y ultimo estado, para que la pantalla los muestre
 *     aunque la tarea los haya generado en segundo plano.
 *   - `permPrimed`: recuerdo de que ya se explico/pregunto por los permisos,
 *     para no volver a pedirlos en cada arranque.
 *
 * Concurrencia: la tarea y la pantalla pueden escribir a la vez. Todas las
 * mutaciones pasan por una cadena de promesas para no pisarse.
 */

const KEY_SESSION = "geo.bg.session";
const KEY_QUEUE = "geo.bg.queue";
const KEY_STATS = "geo.bg.stats";
const KEY_PRIMED = "geo.bg.permPrimed";
/**
 * Recuerdo de que los permisos de camara/microfono ya se gestionaron.
 *
 * Es la pieza que garantiza el requisito "los permisos de sistema se piden una
 * sola vez": en cada sesion posterior solo se consulta el estado
 * (`PermissionsAndroid.check` / `expo-camera`), sin volver a mostrar el dialogo
 * del sistema.
 */
const KEY_MEDIA_PRIMED = "geo.media.permPrimed";

/** Sesion de comparticion que el servicio de segundo plano debe obedecer. */
export interface TrackingSession {
  deviceId: string;
  shareId: string;
  shareToken: string;
  /** Momento en que la sesion deja de ser valida (ISO 8601). */
  expiresAt: string;
  /** Frecuencia de captura elegida por el usuario, en milisegundos. */
  intervalMs: number;
  /** URL base de la API con la que hablar desde la tarea. */
  apiUrl: string;
  /** Momento en que se inicio el seguimiento. */
  startedAt: string;
}

/** Ultima coordenada aceptada por el servidor, lista para mostrar en pantalla. */
export interface SentPoint {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  /** Instante en que el GPS obtuvo la coordenada. */
  recordedAt: string;
  /** Instante en que el servidor confirmo su almacenamiento. */
  sentAt: string;
  /** true cuando la lectura llego desde el servicio en segundo plano. */
  background: boolean;
}

export interface TrackingStats {
  /** Total de lecturas aceptadas por el servidor en esta sesion. */
  sentCount: number;
  /** Lecturas guardadas por falta de conexion. */
  pendingCount: number;
  lastSent: SentPoint | null;
  lastError: string | null;
  /** true cuando no hay conexion con la API. */
  offline: boolean;
  /** true cuando el servidor rechazo la sesion (detenida, revocada o expirada). */
  shareInvalid: boolean;
  /** Ultimo intento de envio, para mostrar "ultima actividad". */
  lastAttemptAt: string | null;
}

export const EMPTY_STATS: TrackingStats = {
  sentCount: 0,
  pendingCount: 0,
  lastSent: null,
  lastError: null,
  offline: false,
  shareInvalid: false,
  lastAttemptAt: null,
};

// ---------------------------------------------------------------------------
// Suscripcion en memoria: la tarea (mismo proceso) avisa a la pantalla en el
// acto. Cuando la tarea corre en un proceso headless no hay oyentes, y la
// pantalla se pondra al dia con `loadStats()` al volver a primer plano.
// ---------------------------------------------------------------------------
type StatsListener = (stats: TrackingStats) => void;
const listeners = new Set<StatsListener>();

export function subscribeToTracking(listener: StatsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(stats: TrackingStats): void {
  for (const listener of listeners) {
    try {
      listener(stats);
    } catch {
      /* un oyente roto no debe romper la tarea */
    }
  }
}

// ---------------------------------------------------------------------------
// Serializacion de escrituras
// ---------------------------------------------------------------------------
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Lectura/escritura generica con JSON tolerante a fallos
// ---------------------------------------------------------------------------
async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* si el almacenamiento falla no se puede hacer mas: se pierde ese guardado */
  }
}

// ---------------------------------------------------------------------------
// Sesion de seguimiento
// ---------------------------------------------------------------------------
export async function loadTrackingSession(): Promise<TrackingSession | null> {
  const session = await readJson<TrackingSession>(KEY_SESSION);
  if (
    !session?.shareToken ||
    !session?.deviceId ||
    !session?.expiresAt ||
    !session?.apiUrl
  ) {
    return null;
  }
  return session;
}

export async function saveTrackingSession(
  session: TrackingSession,
): Promise<void> {
  await writeJson(KEY_SESSION, session);
}

export async function clearTrackingSession(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY_SESSION);
  } catch {
    /* ignorado */
  }
}

// ---------------------------------------------------------------------------
// Cola de lecturas pendientes
// ---------------------------------------------------------------------------
export async function loadQueue(): Promise<IngestLocationInput[]> {
  const queue = await readJson<IngestLocationInput[]>(KEY_QUEUE);
  return Array.isArray(queue) ? queue : [];
}

export async function saveQueue(
  queue: IngestLocationInput[],
): Promise<void> {
  await writeJson(KEY_QUEUE, queue);
}

// ---------------------------------------------------------------------------
// Estadisticas
// ---------------------------------------------------------------------------
export async function loadStats(): Promise<TrackingStats> {
  const stored = await readJson<Partial<TrackingStats>>(KEY_STATS);
  return { ...EMPTY_STATS, ...(stored ?? {}) };
}

/** Fusiona un cambio sobre las estadisticas actuales y avisa a los oyentes. */
export async function updateStats(
  patch:
    | Partial<TrackingStats>
    | ((previous: TrackingStats) => Partial<TrackingStats>),
): Promise<TrackingStats> {
  return serialize(async () => {
    const previous = await loadStats();
    const delta = typeof patch === "function" ? patch(previous) : patch;
    const next: TrackingStats = { ...previous, ...delta };
    await writeJson(KEY_STATS, next);
    emit(next);
    return next;
  });
}

/** Deja las estadisticas y la cola a cero (nuevo seguimiento o parada). */
export async function resetTrackingStats(): Promise<void> {
  await serialize(async () => {
    await writeJson(KEY_STATS, EMPTY_STATS);
    await saveQueue([]);
    emit(EMPTY_STATS);
  });
}

// ---------------------------------------------------------------------------
// Recuerdo de permisos ya gestionados
// ---------------------------------------------------------------------------
export async function loadPermissionsPrimed(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(KEY_PRIMED)) === "1";
  } catch {
    return false;
  }
}

export async function markPermissionsPrimed(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_PRIMED, "1");
  } catch {
    /* ignorado */
  }
}

/** true si los permisos de camara/microfono ya se gestionaron alguna vez. */
export async function loadMediaPermissionsPrimed(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(KEY_MEDIA_PRIMED)) === "1";
  } catch {
    return false;
  }
}

export async function markMediaPermissionsPrimed(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_MEDIA_PRIMED, "1");
  } catch {
    /* ignorado */
  }
}
