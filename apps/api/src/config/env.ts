import { GEOCODING_PROVIDERS } from "@geo/shared";
import { z } from "zod";

/**
 * Validacion estricta de variables de entorno al arrancar.
 * Si falta cualquier valor obligatorio, la aplicacion NO arranca:
 * es preferible fallar rapido a correr con configuracion insegura.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  /**
   * Puerto inyectado por la plataforma de despliegue (Render define `PORT`).
   * Tiene prioridad sobre API_PORT; en local no existe y se usa API_PORT.
   */
  PORT: z.coerce.number().int().positive().optional(),
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_HOST: z.string().min(1).default("0.0.0.0"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatoria"),

  JWT_ACCESS_SECRET: z
    .string()
    .min(32, "JWT_ACCESS_SECRET debe tener al menos 32 caracteres"),
  JWT_ACCESS_TTL: z.string().default("900s"),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, "JWT_REFRESH_SECRET debe tener al menos 32 caracteres"),
  JWT_REFRESH_TTL: z.string().default("30d"),

  /** Clave AES-256-GCM en hexadecimal (32 bytes = 64 caracteres hex). */
  DATA_ENCRYPTION_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      "DATA_ENCRYPTION_KEY debe ser hexadecimal de 64 caracteres (32 bytes)",
    ),

  CORS_ORIGINS: z.string().default(""),

  /** Minutos sin recibir coordenadas antes de considerar un dispositivo desconectado. */
  STALE_AFTER_MINUTES: z.coerce.number().int().positive().default(15),

  // ------------------------------ Administracion ------------------------------
  /**
   * Correos que se promueven automaticamente al rol SUPERADMIN (separados por
   * coma). Es una lista de confianza del operador: el usuario no puede
   * auto-promocionarse. Ver docs/seguridad.md y docs/privacidad.md.
   */
  SUPERADMIN_EMAILS: z.string().default(""),

  // --------------------- Geocodificacion inversa (direcciones) ----------------
  /**
   * Proveedor de geocodificacion inversa:
   *   - disabled : no se obtienen direcciones (el panel muestra "no disponible")
   *   - nominatim: OpenStreetMap, sin clave (uso academico, limites de uso)
   *   - google   : Google Maps Platform (requiere GEOCODING_API_KEY)
   *
   * La clave viaja SIEMPRE en el backend; nunca en la app movil.
   */
  GEOCODING_PROVIDER: z.enum(GEOCODING_PROVIDERS).default("nominatim"),
  /** Clave del proveedor (obligatoria si GEOCODING_PROVIDER=google). */
  GEOCODING_API_KEY: z.string().default(""),
  /** URL base alternativa (por ejemplo un proxy propio). Vacio = la oficial. */
  GEOCODING_BASE_URL: z.string().default(""),
  GEOCODING_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
  /**
   * Intervalo minimo entre llamadas al proveedor, en milisegundos.
   * Con Nominatim se respeta su politica de uso (max. 1 peticion/segundo).
   */
  GEOCODING_MIN_INTERVAL_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(1100),
  /** Dias que una direccion se conserva en cache antes de refrescarse. */
  GEOCODING_CACHE_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /**
   * Movimiento minimo (metros) para volver a pedir la direccion de un
   * dispositivo. Evita geocodificar cada coordenada cuando apenas se mueve.
   */
  GEOCODING_MIN_MOVE_METERS: z.coerce.number().positive().default(100),
  /** Minutos sin resolver antes de reintentar aunque no haya movimiento. */
  GEOCODING_REFRESH_MINUTES: z.coerce.number().int().positive().default(10),
  GEOCODING_LANGUAGE: z.string().default("es"),
  GEOCODING_USER_AGENT: z
    .string()
    .default("geolocalizador-movil/0.1 (proyecto academico)"),
});

export type AppEnv = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const detalle = parsed.error.issues
      .map(
        (issue) => `  - ${issue.path.join(".") || "(raiz)"}: ${issue.message}`,
      )
      .join("\n");
    throw new Error(`Configuracion de entorno invalida:\n${detalle}`);
  }
  return parsed.data;
}

export function parseCorsOrigins(origins: string): string[] {
  return origins
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/** Convierte "a@x.com, B@y.com" en ["a@x.com", "b@y.com"] (normalizado). */
export function parseEmailList(raw: string): string[] {
  return raw
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

/**
 * Convierte una duracion tipo "900s", "15m", "12h", "30d" a milisegundos.
 * Se usa para calcular la expiracion de sesiones de refresco.
 */
export function parseDurationToMs(value: string, fallbackMs: number): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(value.trim());
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = match[2] ?? "s";
  const factores: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return amount * (factores[unit] ?? 1000);
}
