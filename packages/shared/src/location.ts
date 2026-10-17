import { z } from "zod";
import { LocationFreshness } from "./enums";
import type { GeocodedAddress } from "./geocoding";

/** Rangos fisicos validos para una coordenada. */
export const LATITUDE_MIN = -90;
export const LATITUDE_MAX = 90;
export const LONGITUDE_MIN = -180;
export const LONGITUDE_MAX = 180;

/**
 * Precisión maxima aceptada en metros. Valores mas altos suelen indicar una
 * lectura poco fiable (solo antena) y se rechazan para no contaminar el historial.
 */
export const MAX_ACCURACY_METERS = 5000;

/** Numero maximo de posiciones devueltas por consulta de historial. */
export const HISTORY_PAGE_SIZE_DEFAULT = 100;
export const HISTORY_PAGE_SIZE_MAX = 1000;

export const ingestLocationSchema = z.object({
  latitude: z
    .number()
    .gte(LATITUDE_MIN, "La latitud debe ser mayor o igual a -90")
    .lte(LATITUDE_MAX, "La latitud debe ser menor o igual a 90"),
  longitude: z
    .number()
    .gte(LONGITUDE_MIN, "La longitud debe ser mayor o igual a -180")
    .lte(LONGITUDE_MAX, "La longitud debe ser menor o igual a 180"),
  accuracyMeters: z
    .number()
    .nonnegative("La precision no puede ser negativa")
    .lte(
      MAX_ACCURACY_METERS,
      `La precision no puede superar ${MAX_ACCURACY_METERS} metros`,
    ),
  altitudeMeters: z.number().nullable().optional(),
  speedMps: z.number().nonnegative().nullable().optional(),
  headingDegrees: z.number().min(0).max(360).nullable().optional(),
  /**
   * Momento en que el dispositivo obtuvo la coordenada (ISO 8601).
   * Si se omite, el backend usa la hora de recepcion.
   */
  recordedAt: z
    .string()
    .datetime({
      offset: true,
      message: "recordedAt debe ser una fecha ISO 8601 valida",
    })
    .optional(),

  // ---------------------------------------------------------------------------
  // Metadatos opcionales del dispositivo.
  //
  // La app los adjunta "si los tiene" en cada envio: bateria, version de la
  // aplicacion, version del sistema operativo y estado del permiso de ubicacion.
  // Sirven para el panel de administracion. Todos son opcionales: si no llegan,
  // el campo queda en null y el panel muestra "no reportado" (nunca un valor
  // inventado).
  // ---------------------------------------------------------------------------

  /** Nivel de bateria en porcentaje (0-100). */
  batteryLevel: z.number().int().min(0).max(100).nullable().optional(),
  /** Version de la app movil (p. ej. "0.1.0"). */
  appVersion: z.string().trim().max(40).optional(),
  /** Version del sistema operativo (p. ej. "Android 9"). */
  osVersion: z.string().trim().max(80).optional(),
  /** Estado del permiso de ubicacion detectado por la app. */
  permissionStatus: z.string().trim().max(40).optional(),
});
export type IngestLocationInput = z.infer<typeof ingestLocationSchema>;

export const historyQuerySchema = z.object({
  deviceId: z
    .string()
    .min(1, "El identificador del dispositivo es obligatorio"),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(HISTORY_PAGE_SIZE_MAX)
    .default(HISTORY_PAGE_SIZE_DEFAULT),
});
export type HistoryQueryInput = z.infer<typeof historyQuerySchema>;

/** Punto geografico tal como se expone al cliente. */
export interface PublicLocation {
  id: string;
  deviceId: string;
  shareId: string | null;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  altitudeMeters: number | null;
  speedMps: number | null;
  headingDegrees: number | null;
  recordedAt: string;
  receivedAt: string;
}

/** Resultado de la consulta de ultima ubicacion conocida de un dispositivo. */
export interface DeviceLocationSummary {
  deviceId: string;
  lastLocation: PublicLocation | null;
  freshness: LocationFreshness;
  /** Segundos transcurridos desde la ultima lectura (null si no hay datos). */
  ageSeconds: number | null;
  /**
   * Direccion aproximada de la ultima ubicacion (geocodificacion inversa).
   * Es `null` cuando no hay datos suficientes, el proveedor no responde o la
   * geocodificacion esta desactivada. Nunca se inventa una direccion.
   */
  address?: GeocodedAddress | null;
}
