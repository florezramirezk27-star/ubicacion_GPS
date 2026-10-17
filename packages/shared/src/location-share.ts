import { z } from "zod";
import { LOCATION_SHARE_STATUSES, LocationShareStatus } from "./enums";
import { deviceIdSchema } from "./device";

export const DEFAULT_SHARE_DURATION_MINUTES = 60;
export const MIN_SHARE_DURATION_MINUTES = 5;
export const MAX_SHARE_DURATION_MINUTES = 24 * 60; // 24 horas

/** Crea una sesion de ubicacion compartida para un dispositivo propio. */
export const startShareSchema = z.object({
  deviceId: deviceIdSchema,
  expiresInMinutes: z
    .number()
    .int("La duracion debe ser un numero entero de minutos")
    .min(
      MIN_SHARE_DURATION_MINUTES,
      `La duracion minima es ${MIN_SHARE_DURATION_MINUTES} minutos`,
    )
    .max(
      MAX_SHARE_DURATION_MINUTES,
      `La duracion maxima es ${MAX_SHARE_DURATION_MINUTES} minutos`,
    )
    .default(DEFAULT_SHARE_DURATION_MINUTES),
});
export type StartShareInput = z.infer<typeof startShareSchema>;

/** Motivo opcional al detener o revocar una sesion (queda en la auditoria). */
export const stopShareSchema = z.object({
  reason: z.string().trim().max(280).optional(),
});
export type StopShareInput = z.infer<typeof stopShareSchema>;

export const shareIdSchema = z
  .string()
  .min(1, "El identificador de la sesion es obligatorio");

/** Sesion de ubicacion compartida tal como se expone al cliente. */
export interface PublicLocationShare {
  id: string;
  deviceId: string;
  status: LocationShareStatus;
  startedAt: string;
  expiresAt: string;
  stoppedAt: string | null;
  revokedAt: string | null;
}

/**
 * Respuesta al crear una sesion. El `shareToken` solo se devuelve UNA vez:
 * el backend almacena unicamente su hash, igual que con una contrasena.
 */
export interface CreatedLocationShare extends PublicLocationShare {
  shareToken: string;
}

export const locationShareStatusSchema = z.enum(LOCATION_SHARE_STATUSES);
