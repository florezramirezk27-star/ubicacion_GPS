import { z } from "zod";

/**
 * Acceso remoto a camara y microfono.
 *
 * Reglas del producto (y del cumplimiento legal):
 *
 *  1. **No existe activacion silenciosa.** El administrador puede *solicitar*
 *     acceso en cualquier momento; el dispositivo solo empieza a capturar
 *     cuando el usuario acepta de forma explicita.
 *  2. **Cada sesion deja rastro**: quien la pidio, quien la acepto, cuando
 *     empezo y cuando termino (`audit_logs`).
 *  3. **Los permisos de sistema se piden una sola vez.** Si la persona los
 *     concede, no se vuelve a mostrar el dialogo del sistema en cada sesion;
 *     si los revoca, la app lo detecta y explica como habilitarlos.
 *  4. **Los indicadores son visibles**: mientras la camara o el microfono
 *     estan activos, la app muestra una sesion activa con boton de fin.
 *
 * El transporte de audio/video es WebRTC: la senalizacion viaja por el
 * servidor, pero el propio flujo va de extremo a extremo.
 */

// ------------------------------- Enumeraciones -------------------------------

export const REMOTE_SENSORS = [
  "CAMERA",
  "MICROPHONE",
  "CAMERA_AND_MICROPHONE",
] as const;
export type RemoteSensor = (typeof REMOTE_SENSORS)[number];

export const REMOTE_REQUEST_STATUSES = [
  "PENDING",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
] as const;
export type RemoteRequestStatus = (typeof REMOTE_REQUEST_STATUSES)[number];

export const MEDIA_SESSION_STATUSES = ["ACTIVE", "ENDED"] as const;
export type MediaSessionStatus = (typeof MEDIA_SESSION_STATUSES)[number];

/** Nombre en pantalla de cada sensor. */
export const REMOTE_SENSOR_LABELS: Record<RemoteSensor, string> = {
  CAMERA: "Cámara",
  MICROPHONE: "Micrófono",
  CAMERA_AND_MICROPHONE: "Cámara y micrófono",
};

/** Nombre en pantalla de cada estado de solicitud. */
export const REMOTE_REQUEST_STATUS_LABELS: Record<RemoteRequestStatus, string> =
  {
    PENDING: "Esperando consentimiento",
    ACCEPTED: "Aceptada",
    REJECTED: "Rechazada",
    EXPIRED: "Caducada",
    CANCELLED: "Cancelada",
  };

/** El sensor que usa la solicitud: agrupa camara y microfono para pedir una sola vez. */
export function sensorsOf(
  sensor: RemoteSensor,
): Array<"CAMERA" | "MICROPHONE"> {
  if (sensor === "CAMERA") return ["CAMERA"];
  if (sensor === "MICROPHONE") return ["MICROPHONE"];
  return ["CAMERA", "MICROPHONE"];
}

// --------------------------------- Tipos ------------------------------------

export interface PublicMediaSession {
  id: string;
  requestId: string;
  deviceId: string;
  sensor: RemoteSensor;
  status: MediaSessionStatus;
  startedAt: string;
  endedAt: string | null;
  endedReason: string | null;
}

export interface PublicRemoteAccessRequest {
  id: string;
  deviceId: string;
  /** Nombre del dispositivo, para mostrar la solicitud en el panel. */
  deviceName: string | null;
  sensor: RemoteSensor;
  status: RemoteRequestStatus;
  /** Motivo que indico el administrador, si lo hubo. */
  reason: string | null;
  /** Email del administrador que solicita (visibilidad para el usuario). */
  requestedByEmail: string | null;
  expiresAt: string;
  createdAt: string;
  respondedAt: string | null;
  session: PublicMediaSession | null;
}

// --------------------------------- Limites ----------------------------------

/** Validez por defecto de una solicitud mientras nadie responde. */
export const REMOTE_REQUEST_DEFAULT_TTL_SECONDS = 120;
export const REMOTE_REQUEST_MIN_TTL_SECONDS = 15;
export const REMOTE_REQUEST_MAX_TTL_SECONDS = 600;

/**
 * Intervalo con el que el movil consulta solicitudes pendientes.
 * Es una consulta HTTP ligera, no un socket permanente.
 */
export const REMOTE_POLL_INTERVAL_MS = 8_000;

/** Tamano maximo de un SDP aceptado por la senalizacion (evita abusos). */
export const WEBRTC_MAX_SDP_LENGTH = 200_000;

// --------------------------------- Eventos ----------------------------------

/** Eventos WS hacia los administradores (namespace /admin). */
export const ADMIN_REMOTE_EVENTS = {
  request: "admin:remote-request",
  session: "admin:media-session",
} as const;

/** Eventos WS de senalizacion WebRTC (namespace /media, sala `media:<sessionId>`). */
export const MEDIA_WS_EVENTS = {
  offer: "media:offer",
  answer: "media:answer",
  ice: "media:ice",
  end: "media:end",
} as const;

/** Prefijo de sala WebRTC por sesion. */
export const MEDIA_ROOM_PREFIX = "media:";

export function mediaRoom(sessionId: string): string {
  return `${MEDIA_ROOM_PREFIX}${sessionId}`;
}

// ------------------------------- Senalizacion -------------------------------

export const WEBRTC_SIGNAL_TYPES = [
  "offer",
  "answer",
  "candidate",
  "end",
] as const;
export type WebrtcSignalType = (typeof WEBRTC_SIGNAL_TYPES)[number];

export const iceCandidateSchema = z.object({
  candidate: z.string().max(8_192),
  sdpMid: z.string().max(64).nullish(),
  sdpMLineIndex: z.number().int().min(0).max(65_535).nullish(),
  usernameFragment: z.string().max(128).nullish(),
});

export type WebrtcIceCandidate = z.infer<typeof iceCandidateSchema>;

export const webrtcSignalSchema = z
  .object({
    /** Sesion de medios a la que pertenece la senal. */
    sessionId: z.string().min(1).max(64),
    type: z.enum(WEBRTC_SIGNAL_TYPES),
    /** SDP para offer/answer. */
    sdp: z.string().max(WEBRTC_MAX_SDP_LENGTH).optional(),
    /** Candidato ICE para type === "candidate". */
    candidate: iceCandidateSchema.optional(),
  })
  .refine(
    (value) => value.type !== "candidate" || value.candidate !== undefined,
    {
      message: "candidate es obligatorio cuando type es 'candidate'",
    },
  );

export type WebrtcSignal = z.infer<typeof webrtcSignalSchema>;

// -------------------------------- Esquemas ----------------------------------

export const createRemoteAccessRequestSchema = z.object({
  sensor: z.enum(REMOTE_SENSORS),
  reason: z
    .string()
    .trim()
    .min(3, "El motivo debe tener al menos 3 caracteres")
    .max(280)
    .optional(),
  ttlSeconds: z.coerce
    .number()
    .int()
    .min(REMOTE_REQUEST_MIN_TTL_SECONDS)
    .max(REMOTE_REQUEST_MAX_TTL_SECONDS)
    .default(REMOTE_REQUEST_DEFAULT_TTL_SECONDS),
});
export type CreateRemoteAccessRequestInput = z.infer<
  typeof createRemoteAccessRequestSchema
>;

export const respondRemoteAccessSchema = z.object({
  /** true = el usuario acepta abrir la sesion de medios. */
  accept: z.boolean(),
});
export type RespondRemoteAccessInput = z.infer<
  typeof respondRemoteAccessSchema
>;

export const remoteAccessListQuerySchema = z.object({
  deviceId: z.string().min(1).optional(),
  status: z.enum(REMOTE_REQUEST_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type RemoteAccessListQuery = z.infer<typeof remoteAccessListQuerySchema>;

export const endMediaSessionSchema = z
  .object({
    reason: z.string().trim().min(3).max(160).optional(),
  })
  .default({});
export type EndMediaSessionInput = z.infer<typeof endMediaSessionSchema>;
