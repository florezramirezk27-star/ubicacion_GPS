import type { GeocodedAddress, LocationFreshness } from "@geo/shared";

/** Formatea una fecha ISO como hora local legible. */
export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(iso));
}

/** Convierte segundos en un texto tipo "hace 12 s", "hace 3 min". */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return "sin datos";
  if (seconds < 5) return "ahora mismo";
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} d`;
}

export function formatMeters(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

export function formatCoordinates(latitude: number, longitude: number): string {
  const lat = `${Math.abs(latitude).toFixed(5)}° ${latitude >= 0 ? "N" : "S"}`;
  const lng = `${Math.abs(longitude).toFixed(5)}° ${longitude >= 0 ? "E" : "O"}`;
  return `${lat}, ${lng}`;
}

export const FRESHNESS_LABEL: Record<LocationFreshness, string> = {
  CURRENT: "En vivo",
  STALE: "Datos antiguos",
  OFFLINE: "Desconectado",
  UNKNOWN: "Sin datos",
};

export const FRESHNESS_HINT: Record<LocationFreshness, string> = {
  CURRENT: "El dispositivo reporto hace muy poco.",
  STALE: "El dispositivo lleva un rato sin enviar coordenadas.",
  OFFLINE:
    "Se supero el umbral sin recibir datos: la ubicacion puede ser obsoleta.",
  UNKNOWN: "El dispositivo nunca ha enviado una ubicacion.",
};

export const PLATFORM_LABEL: Record<string, string> = {
  ANDROID: "Android",
  IOS: "iPhone",
};

export const SHARE_STATUS_LABEL: Record<string, string> = {
  ACTIVE: "Activa",
  STOPPED: "Detenida",
  REVOKED: "Revocada",
  EXPIRED: "Expirada",
};

export const ROLE_LABEL: Record<string, string> = {
  USER: "Usuario",
  SUPERADMIN: "Superadministrador",
};

/**
 * Etiquetas legibles de las acciones registradas en la auditoria.
 * Si una accion no figura aqui se muestra su identificador tecnico, de modo
 * que nunca se oculta un evento por falta de traduccion.
 */
export const ACTION_LABEL: Record<string, string> = {
  "admin.device.view": "Consulto la ficha de un dispositivo",
  "admin.history.view": "Consulto el historial de un dispositivo",
  "admin.share.revoke_all": "Revoco las sesiones de un dispositivo",
  "admin.device.unlink": "Desvinculo un dispositivo",
  "share.start": "Inicio una sesion de comparticion",
  "share.stop": "Detuvo una sesion de comparticion",
  "share.revoke": "Revoco una sesion de comparticion",
  "device.create": "Vinculo un dispositivo",
  "device.delete": "Elimino un dispositivo",
  "auth.register": "Creo una cuenta",
  "auth.login": "Inicio de sesion",
  "auth.logout": "Cerro sesion",
  "auth.refresh": "Renovo la sesion",
};

/** Texto legible de una accion de auditoria. */
export function formatAction(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

/** Porcentaje de bateria o un guion si el dispositivo no lo reporta. */
export function formatBattery(level: number | null): string {
  if (level === null) return "Sin dato";
  return `${Math.round(level)}%`;
}

/**
 * Direccion corta para listas y fichas.
 * Se prefiere la etiqueta del proveedor (calle + numero); si no hay, se usa la
 * linea completa. Si no hay direccion, se devuelve un guion.
 */
export function formatAddress(address: GeocodedAddress | null): string {
  if (!address) return "Sin direccion";
  if (address.label) return address.label;
  return address.formattedAddress;
}

/** Descripcion de una ubicacion en lenguaje humano (sin inventar datos). */
export function describePlace(address: GeocodedAddress | null): string {
  if (!address) return "";
  const parts = [address.neighborhood, address.city, address.region].filter(
    (part): part is string => Boolean(part),
  );
  return parts.join(", ");
}
