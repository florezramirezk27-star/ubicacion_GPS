import { z } from "zod";
import {
  DEVICE_PLATFORMS,
  LOCATION_FRESHNESS,
  LOCATION_SHARE_STATUSES,
  type DevicePlatform,
  type LocationFreshness,
  type LocationShareStatus,
} from "./enums";
import type { GeocodedAddress } from "./geocoding";
import type { PublicLocation } from "./location";
import type { PublicLocationShare } from "./location-share";

/**
 * Tipos del panel de Superadministrador.
 *
 * El SUPERADMIN ve **todos** los dispositivos registrados y autorizados de la
 * plataforma. Cada consulta queda registrada en la auditoria
 * (`admin.device.view`, `admin.history.view`), de modo que un administrador no
 * puede espiar en silencio: queda constancia de quien miro que y cuando.
 */

/** Contadores del centro de control. */
export interface AdminOverview {
  totalUsers: number;
  totalDevices: number;
  /** Dispositivos con una lectura reciente (CURRENT). */
  onlineDevices: number;
  /** Dispositivos con datos antiguos (STALE). */
  staleDevices: number;
  /** Dispositivos sin datos mas alla del umbral (OFFLINE). */
  offlineDevices: number;
  /** Dispositivos que nunca han reportado (UNKNOWN). */
  unknownDevices: number;
  /** Dispositivos con una sesion de comparticion activa. */
  sharingDevices: number;
  /** Sesiones de comparticion activas ahora mismo. */
  activeShares: number;
  /** Dispositivos que requieren atencion (antiguos, desconectados o sin datos). */
  alerts: number;
  generatedAt: string;
}

/** Fila de dispositivo en el mapa/lista global del administrador. */
export interface AdminDevice {
  id: string;
  userId: string;
  /** Correo del usuario propietario (dato de contacto, no de contenido). */
  userEmail: string;
  platform: DevicePlatform;
  deviceName: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** Metadatos que la app reporta si estan disponibles. */
  appVersion: string | null;
  osVersion: string | null;
  /** Nivel de bateria en porcentaje (0-100), si el dispositivo lo reporta. */
  batteryLevel: number | null;
  /** Estado del permiso de ubicacion detectado por la app, si se conoce. */
  permissionStatus: string | null;
  shareStatus: LocationShareStatus | null;
  shareExpiresAt: string | null;
  lastLocation: PublicLocation | null;
  /** Direccion aproximada de la ultima ubicacion (null si no hay datos). */
  address: GeocodedAddress | null;
  freshness: LocationFreshness;
  ageSeconds: number | null;
}

/** Ficha ampliada de un dispositivo. */
export interface AdminDeviceDetail extends AdminDevice {
  /** Sesiones de comparticion recientes de este dispositivo. */
  shares: PublicLocationShare[];
  locationCount: number;
  firstLocationAt: string | null;
  lastLocationAt: string | null;
}

/** Evento del feed de eventos de seguridad para administradores. */
export interface AdminAuditEntry {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

export const adminDeviceQuerySchema = z.object({
  platform: z.enum(DEVICE_PLATFORMS).optional(),
  status: z.enum(LOCATION_FRESHNESS).optional(),
  /** Busqueda por nombre de dispositivo o correo del propietario. */
  q: z.string().trim().max(120).optional(),
  userId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type AdminDeviceQuery = z.infer<typeof adminDeviceQuerySchema>;

export const adminHistoryQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});
export type AdminHistoryQuery = z.infer<typeof adminHistoryQuerySchema>;

export const adminAuditQuerySchema = z.object({
  action: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdminAuditQuery = z.infer<typeof adminAuditQuerySchema>;

export const adminRevokeSchema = z.object({
  reason: z.string().trim().max(280).optional(),
});
export type AdminRevokeInput = z.infer<typeof adminRevokeSchema>;

/** Reexportado para comodidad de los clientes del panel. */
export { DEVICE_PLATFORMS, LOCATION_FRESHNESS, LOCATION_SHARE_STATUSES };
