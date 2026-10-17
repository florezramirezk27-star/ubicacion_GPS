/**
 * Enumeraciones compartidas entre la API, el panel web y la app movil.
 * Se declaran como `as const` para poder derivar tipos y validarlos con Zod
 * sin depender de la implementacion del ORM.
 */

export const DEVICE_PLATFORMS = ["ANDROID", "IOS"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/**
 * Roles de la plataforma.
 *
 * - USER      : usuario normal. Solo ve sus propios dispositivos y aquellos que
 *               otro usuario le autorice expresamente.
 * - SUPERADMIN: administrador de la plataforma. Puede ver y gestionar todos los
 *               dispositivos registrados, con auditoria de cada consulta.
 *
 * Ser SUPERADMIN **no** otorga acceso ilimitado al contenido del telefono:
 * unicamente a las coordenadas que el dispositivo haya compartido y a los
 * metadatos que la app reporte. Ver docs/privacidad.md.
 */
export const USER_ROLES = ["USER", "SUPERADMIN"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Estados del ciclo de vida de una sesion de ubicacion compartida.
 *
 * - ACTIVE  : el dispositivo esta autorizado a enviar coordenadas.
 * - STOPPED : el usuario detuvo la comparticion de forma voluntaria.
 * - REVOKED : un tercero con autorizacion (o el propio usuario) revoco el acceso.
 * - EXPIRED : se supero la fecha de expiracion configurada al crear la sesion.
 */
export const LOCATION_SHARE_STATUSES = [
  "ACTIVE",
  "STOPPED",
  "REVOKED",
  "EXPIRED",
] as const;
export type LocationShareStatus = (typeof LOCATION_SHARE_STATUSES)[number];

/** Solo estos estados permiten aceptar nuevas coordenadas. */
export const INGESTIBLE_SHARE_STATUSES: readonly LocationShareStatus[] = [
  "ACTIVE",
];

/**
 * Clasificacion de frescura de una ubicacion, usada por el panel web para
 * distinguir ubicacion actual, ubicacion antigua y dispositivo desconectado.
 */
export const LOCATION_FRESHNESS = [
  "CURRENT",
  "STALE",
  "OFFLINE",
  "UNKNOWN",
] as const;
export type LocationFreshness = (typeof LOCATION_FRESHNESS)[number];

/**
 * Umbrales de frescura compartidos por el backend y el panel web.
 *
 * Se centralizan aqui para que ambos calculen el mismo estado y el mapa nunca
 * muestre como "en vivo" un dato que el servidor considera antiguo.
 *
 * - CURRENT            : la lectura llego hace `FRESHNESS_CURRENT_SECONDS` o menos.
 * - STALE              : entre ese umbral y `FRESHNESS_DEFAULT_OFFLINE_MINUTES`.
 * - OFFLINE            : supera el umbral de desconexion.
 * - UNKNOWN            : el dispositivo nunca ha reportado.
 */
export const FRESHNESS_CURRENT_SECONDS = 120;
export const FRESHNESS_DEFAULT_OFFLINE_MINUTES = 15;

/** Calcula la clasificacion de frescura a partir de la antiguedad en segundos. */
export function classifyFreshness(
  ageSeconds: number | null,
  offlineAfterMinutes: number = FRESHNESS_DEFAULT_OFFLINE_MINUTES,
): LocationFreshness {
  if (ageSeconds === null) return "UNKNOWN";
  if (ageSeconds <= FRESHNESS_CURRENT_SECONDS) return "CURRENT";
  if (ageSeconds <= offlineAfterMinutes * 60) return "STALE";
  return "OFFLINE";
}
