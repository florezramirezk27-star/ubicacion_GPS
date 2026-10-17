/**
 * Filtro de "cambio significativo" para la geocodificacion inversa.
 *
 * Motivo de negocio: **no se envia cada coordenada a un servicio de
 * geocodificacion**. Las coordenadas se guardan siempre con su precision; lo
 * que se evita es pedir la calle una y otra vez cuando el dispositivo apenas
 * se ha movido, porque eso genera consultas y consumo innecesarios (y, en el
 * caso de Nominatim, incumple su politica de uso).
 *
 * La decision se toma por dispositivo:
 *
 *   * `first`     -> no habia referencia previa: se resuelve.
 *   * `moved`     -> se ha movido al menos `minMoveMeters`: se resuelve.
 *   * `refresh`   -> ha pasado `refreshMs` sin moverse: se reintenta. Evita
 *                    quedarse para siempre sin direccion si el proveedor
 *                    fallo la primera vez.
 *   * `unchanged` -> ni se ha movido ni ha pasado el tiempo: **no** se pide.
 *
 * El estado vive en memoria: si la API se reinicia, la primera coordenada de
 * cada dispositivo vuelve a resolverse (una sola consulta extra, sin coste).
 */

/** Radio medio terrestre en metros. */
export const EARTH_RADIUS_M = 6_371_000;

/**
 * Valores por defecto de la politica. La API los puede sobreescribir por
 * entorno (`GEOCODING_MIN_MOVE_METERS`, `GEOCODING_REFRESH_MINUTES`).
 */
export const GEOCODE_GATE_DEFAULTS = {
  minMoveMeters: 100,
  refreshMinutes: 10,
} as const;

/** Distancia en metros entre dos coordenadas (formula del semiverseno). */
export function haversineMeters(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
): number {
  const toRad = (degrees: number): number => (degrees * Math.PI) / 180;
  const deltaLat = toRad(latitudeB - latitudeA);
  const deltaLon = toRad(longitudeB - longitudeA);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRad(latitudeA)) *
      Math.cos(toRad(latitudeB)) *
      Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export type GeocodeReason = "first" | "moved" | "refresh" | "unchanged";

export interface GeocodeDecision {
  /** true si hay que (re)consultar la direccion de este punto. */
  shouldResolve: boolean;
  reason: GeocodeReason;
  /** Distancia respecto al ultimo punto resuelto (null la primera vez). */
  distanceMeters: number | null;
  /** Tiempo desde la ultima resolucion (null la primera vez). */
  elapsedMs: number | null;
}

export interface GeocodeGateOptions {
  /** Movimiento minimo que justifica volver a pedir la direccion. */
  minMoveMeters: number;
  /** Tiempo maximo sin resolver antes de reintentar aunque no se mueva. */
  refreshMs: number;
}

interface Reference {
  latitude: number;
  longitude: number;
  at: number;
}

export class GeocodeGate {
  private readonly references = new Map<string, Reference>();

  constructor(private readonly options: GeocodeGateOptions) {}

  /** Decide si merece la pena resolver la direccion de este punto. */
  shouldResolve(
    deviceId: string,
    latitude: number,
    longitude: number,
    now: number = Date.now(),
  ): GeocodeDecision {
    const previous = this.references.get(deviceId);

    if (!previous) {
      this.references.set(deviceId, { latitude, longitude, at: now });
      return {
        shouldResolve: true,
        reason: "first",
        distanceMeters: null,
        elapsedMs: null,
      };
    }

    const distanceMeters = haversineMeters(
      previous.latitude,
      previous.longitude,
      latitude,
      longitude,
    );
    const elapsedMs = now - previous.at;

    if (distanceMeters >= this.options.minMoveMeters) {
      this.references.set(deviceId, { latitude, longitude, at: now });
      return { shouldResolve: true, reason: "moved", distanceMeters, elapsedMs };
    }

    if (elapsedMs >= this.options.refreshMs) {
      this.references.set(deviceId, { latitude, longitude, at: now });
      return {
        shouldResolve: true,
        reason: "refresh",
        distanceMeters,
        elapsedMs,
      };
    }

    return {
      shouldResolve: false,
      reason: "unchanged",
      distanceMeters,
      elapsedMs,
    };
  }

  /** Olvida la referencia de un dispositivo (por ejemplo al revocar su acceso). */
  forget(deviceId: string): void {
    this.references.delete(deviceId);
  }

  /** Numero de dispositivos con referencia en memoria (para diagnostico). */
  get size(): number {
    return this.references.size;
  }
}
