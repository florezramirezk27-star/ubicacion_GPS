import type { GeocodedAddress } from "@geo/shared";

/**
 * Traductores de las respuestas de cada proveedor a nuestro tipo comun.
 *
 * Se aislain en funciones puras para poder probarlas con unidades (ver
 * `geocoding.parsers.spec.ts`) sin red ni base de datos: la interpretacion de
 * una respuesta JSON es justo la parte mas fragil ante cambios del proveedor.
 */

type JsonObject = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** Primera clave presente y no vacia. */
function firstText(source: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return null;
}

/** Etiqueta corta: "Calle 93 # 12-34" cuando hay calle y numero. */
function buildLabel(
  street: string | null,
  number: string | null,
): string | null {
  if (street && number) return `${street} ${number}`;
  return street ?? number ?? null;
}

/**
 * Nominatim (OpenStreetMap): https://nominatim.org/release-docs/latest/api/Reverse/
 * Formato `jsonv2` con `addressdetails=1`.
 */
export function parseNominatim(
  payload: unknown,
  fetchedAt: string,
): GeocodedAddress | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as JsonObject;
  if (text(root["error"])) return null;

  const address = (root["address"] ?? {}) as JsonObject;

  const street = firstText(address, [
    "road",
    "pedestrian",
    "footway",
    "residential",
    "path",
    "highway",
  ]);
  const number = firstText(address, ["house_number"]);
  const neighborhood = firstText(address, [
    "neighbourhood",
    "suburb",
    "quarter",
    "city_district",
    "borough",
  ]);
  const city = firstText(address, [
    "city",
    "town",
    "village",
    "municipality",
    "county",
  ]);
  const region = firstText(address, ["state", "region", "state_district"]);
  const country = firstText(address, ["country"]);
  const postalCode = firstText(address, ["postcode"]);

  const formattedAddress =
    text(root["display_name"]) ?? buildLabel(street, number);
  if (!formattedAddress) return null;

  return {
    formattedAddress,
    label: buildLabel(street, number),
    street,
    number,
    neighborhood,
    city,
    region,
    country,
    postalCode,
    provider: "nominatim",
    fetchedAt,
  };
}

function googleComponent(components: unknown, types: string[]): string | null {
  if (!Array.isArray(components)) return null;
  for (const component of components) {
    if (!component || typeof component !== "object") continue;
    const entry = component as JsonObject;
    const entryTypes = entry["types"];
    if (!Array.isArray(entryTypes)) continue;
    if (types.some((type) => entryTypes.includes(type))) {
      const long = text(entry["long_name"]) ?? text(entry["short_name"]);
      if (long) return long;
    }
  }
  return null;
}

/**
 * Google Maps Platform Geocoding:
 * https://developers.google.com/maps/documentation/geocoding/requests-reverse-geocoding
 */
export function parseGoogle(
  payload: unknown,
  fetchedAt: string,
): GeocodedAddress | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as JsonObject;
  if (text(root["status"]) !== "OK") return null;

  const results = root["results"];
  if (!Array.isArray(results) || results.length === 0) return null;

  const first = results[0];
  if (!first || typeof first !== "object") return null;
  const result = first as JsonObject;
  const components = result["address_components"];

  const street = googleComponent(components, ["route"]);
  const number = googleComponent(components, ["street_number"]);
  const neighborhood = googleComponent(components, [
    "neighborhood",
    "sublocality_level_1",
    "sublocality",
  ]);
  const city = googleComponent(components, [
    "locality",
    "administrative_area_level_2",
  ]);
  const region = googleComponent(components, ["administrative_area_level_1"]);
  const country = googleComponent(components, ["country"]);
  const postalCode = googleComponent(components, ["postal_code"]);

  const formattedAddress =
    text(result["formatted_address"]) ?? buildLabel(street, number);
  if (!formattedAddress) return null;

  return {
    formattedAddress,
    label: buildLabel(street, number),
    street,
    number,
    neighborhood,
    city,
    region,
    country,
    postalCode,
    provider: "google",
    fetchedAt,
  };
}
