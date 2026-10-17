import type { PublicLocation } from "@geo/shared";

/**
 * Registro de ubicacion tal como lo devuelve Prisma (capa de persistencia).
 * Se declara aparte para no acoplar los servicios al cliente generado.
 */
export interface LocationRecord {
  id: string;
  deviceId: string;
  shareId: string | null;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  altitudeMeters: number | null;
  speedMps: number | null;
  headingDegrees: number | null;
  recordedAt: Date;
  receivedAt: Date;
}

/**
 * Convierte un registro en la representacion publica que se envia al cliente.
 * Lo comparten el modulo de ubicaciones y el modulo de administracion para que
 * ambos expongan exactamente la misma forma.
 */
export function toPublicLocation(location: LocationRecord): PublicLocation {
  return {
    id: location.id,
    deviceId: location.deviceId,
    shareId: location.shareId,
    latitude: location.latitude,
    longitude: location.longitude,
    accuracyMeters: location.accuracyMeters,
    altitudeMeters: location.altitudeMeters,
    speedMps: location.speedMps,
    headingDegrees: location.headingDegrees,
    recordedAt: location.recordedAt.toISOString(),
    receivedAt: location.receivedAt.toISOString(),
  };
}
