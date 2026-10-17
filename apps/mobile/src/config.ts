import Constants from "expo-constants";

/**
 * Resolucion de la URL de la API.
 *
 * En un telefono fisico `localhost` apunta al propio telefono, no al PC donde
 * corre la API. Expo publica el host del servidor de desarrollo
 * (`hostUri`, por ejemplo "192.168.1.20:8081"), asi que se reutiliza ese host
 * cambiando el puerto por el de la API. Asi la app funciona en un telefono real
 * sin configuracion manual.
 *
 * Prioridad:
 *   1. EXPO_PUBLIC_API_URL (variable de entorno explicita)
 *   2. host del servidor de desarrollo de Expo -> puerto 3001
 *   3. extra.apiUrl de app.json
 *   4. http://localhost:3001
 */
export const API_PORT = 3001;

export function resolveDefaultApiUrl(): string {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit && explicit.trim().length > 0) return explicit.trim();

  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) {
    const host = hostUri.split(":")[0];
    if (host && host.length > 0) return `http://${host}:${API_PORT}`;
  }

  const fromConfig = (
    Constants.expoConfig?.extra as { apiUrl?: string } | undefined
  )?.apiUrl;
  if (fromConfig) return fromConfig;

  return `http://localhost:${API_PORT}`;
}

/** Frecuencias de envio ofrecidas al usuario, en milisegundos. */
export const INTERVAL_OPTIONS: Array<{ label: string; valueMs: number }> = [
  { label: "5 s (rapido)", valueMs: 5_000 },
  { label: "10 s", valueMs: 10_000 },
  { label: "30 s (recomendado)", valueMs: 30_000 },
  { label: "60 s (ahorra bateria)", valueMs: 60_000 },
  { label: "5 min (bajo consumo)", valueMs: 300_000 },
];

export const DEFAULT_INTERVAL_MS = 30_000;
