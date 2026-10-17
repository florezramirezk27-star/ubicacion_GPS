/**
 * Geocodificacion inversa: convertir coordenadas en una direccion legible.
 *
 * Idea clave que se documenta en `docs/investigacion.md`: el **GPS** determina
 * donde esta el dispositivo; la **geocodificacion** es un servicio *externo* que
 * traduce esas coordenadas a una direccion aproximada. Tener el nombre de una
 * calle o un barrio no significa que el GPS conozca la puerta exacta de una
 * vivienda: la direccion es una estimacion del proveedor.
 *
 * Por eso, si no hay datos suficientes o el proveedor no responde, la direccion
 * queda en `null`. El panel nunca inventa una direccion.
 */

/** Proveedores de geocodificacion inversa admitidos. */
export const GEOCODING_PROVIDERS = ["disabled", "nominatim", "google"] as const;
export type GeocodingProvider = (typeof GEOCODING_PROVIDERS)[number];

/**
 * Numero de decimales con el que se redondean las coordenadas antes de
 * consultar y cachear. 4 decimales ≈ 11 m: suficiente para una direccion de
 * calle y evita miles de consultas distintas para el mismo tramo.
 */
export const GEOCODE_CACHE_DECIMALS = 4;

/** Direccion legible asociada a una coordenada. */
export interface GeocodedAddress {
  /** Direccion formateada por el proveedor (linea completa). */
  formattedAddress: string;
  /** Etiqueta corta: calle y numero, si estan disponibles. */
  label: string | null;
  street: string | null;
  number: string | null;
  neighborhood: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  postalCode: string | null;
  /** Proveedor que produjo la direccion (p. ej. "nominatim", "google"). */
  provider: string;
  /** Momento en que se obtuvo del proveedor (ISO 8601). */
  fetchedAt: string;
}

/** Redondea una coordenada a la precision usada como clave de cache. */
export function roundForGeocode(value: number): number {
  const factor = 10 ** GEOCODE_CACHE_DECIMALS;
  return Math.round(value * factor) / factor;
}
