import type { LocationFreshness } from "@geo/shared";

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Hora local en formato HH:MM:SS. */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Fecha y hora local legibles. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${formatTime(iso)}`;
}

/** Antiguedad en texto ("hace 8 s", "hace 3 min"). */
export function formatAge(seconds: number | null): string {
  if (seconds === null) return "sin datos";
  if (seconds < 5) return "ahora mismo";
  if (seconds < 60) return `hace ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

export function formatMeters(meters: number): string {
  if (!Number.isFinite(meters)) return "-";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}

/** Duracion breve en texto ("cada 20 s", "cada 4 min"). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "sin definir";
  if (ms < 60_000) return `${Math.round(ms / 1_000)} s`;
  const minutes = ms / 60_000;
  return Number.isInteger(minutes)
    ? `${minutes} min`
    : `${minutes.toFixed(1)} min`;
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

export const PLATFORM_LABEL: Record<string, string> = {
  ANDROID: "Android",
  IOS: "iPhone",
};

/** Antiguedad en segundos a partir de una marca de tiempo ISO. */
export function ageSecondsFrom(iso: string, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
}
