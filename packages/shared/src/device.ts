import { z } from "zod";
import { DEVICE_PLATFORMS, DevicePlatform } from "./enums";

export const deviceNameSchema = z
  .string()
  .trim()
  .min(1, "El nombre del dispositivo es obligatorio")
  .max(80, "El nombre del dispositivo es demasiado largo");

export const createDeviceSchema = z.object({
  platform: z.enum(DEVICE_PLATFORMS),
  deviceName: deviceNameSchema,
});
export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;

export const updateDeviceSchema = z.object({
  deviceName: deviceNameSchema,
});
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;

/** Identificador de dispositivo en formato CUID generado por Prisma. */
export const deviceIdSchema = z
  .string()
  .min(1, "El identificador del dispositivo es obligatorio");

/** Dispositivo tal como se expone al cliente. */
export interface PublicDevice {
  id: string;
  userId: string;
  platform: DevicePlatform;
  deviceName: string;
  lastSeenAt: string | null;
  createdAt: string;
}
