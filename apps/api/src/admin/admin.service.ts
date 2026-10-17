import { Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  FRESHNESS_DEFAULT_OFFLINE_MINUTES,
  classifyFreshness,
  type AdminAuditEntry,
  type AdminDevice,
  type AdminDeviceDetail,
  type AdminDeviceQuery,
  type AdminHistoryQuery,
  type AdminOverview,
  type DevicePlatform,
  type GeocodedAddress,
  type LocationShareStatus,
  type PublicLocation,
  type PublicLocationShare,
} from "@geo/shared";
import { AuditService } from "../audit/audit.service";
import { GeocodingService } from "../geo/geocoding.service";
import {
  toPublicLocation,
  type LocationRecord,
} from "../locations/location.mapper";
import { PrismaService } from "../prisma/prisma.service";
import { AdminGateway } from "./admin.gateway";

/** Campos de dispositivo que necesita el panel. */
interface DeviceRow {
  id: string;
  userId: string;
  platform: DevicePlatform;
  deviceName: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  appVersion: string | null;
  osVersion: string | null;
  batteryLevel: number | null;
  permissionStatus: string | null;
}

interface ShareRow {
  id: string;
  deviceId: string;
  status: LocationShareStatus;
  startedAt: Date;
  expiresAt: Date;
  stoppedAt: Date | null;
  revokedAt: Date | null;
  stopReason: string | null;
}

/**
 * Consultas del panel de Superadministrador.
 *
 * Reglas de diseno:
 *   - El administrador ve TODOS los dispositivos, pero cada consulta de ficha
 *     o historial queda auditada (`admin.device.view`, `admin.history.view`).
 *   - No se inventan datos: si un dispositivo nunca reporto, su frescura es
 *     `UNKNOWN` y su ubicacion/direccion son `null`.
 *   - Un dato antiguo se marca como `STALE`/`OFFLINE`, nunca como "en vivo".
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly geocoding: GeocodingService,
    private readonly gateway: AdminGateway,
  ) {}

  private get offlineAfterMinutes(): number {
    return (
      this.config.get<number>("STALE_AFTER_MINUTES") ??
      FRESHNESS_DEFAULT_OFFLINE_MINUTES
    );
  }

  /** Estado efectivo de una sesion considerando su expiracion. */
  private effectiveShareStatus(share: ShareRow): LocationShareStatus {
    if (share.status === "ACTIVE" && share.expiresAt.getTime() <= Date.now()) {
      return "EXPIRED";
    }
    return share.status;
  }

  private shareToPublic(share: ShareRow): PublicLocationShare {
    return {
      id: share.id,
      deviceId: share.deviceId,
      status: this.effectiveShareStatus(share),
      startedAt: share.startedAt.toISOString(),
      expiresAt: share.expiresAt.toISOString(),
      stoppedAt: share.stoppedAt ? share.stoppedAt.toISOString() : null,
      revokedAt: share.revokedAt ? share.revokedAt.toISOString() : null,
    };
  }

  private buildDevice(params: {
    device: DeviceRow;
    userEmail: string;
    last: LocationRecord | null;
    share: ShareRow | null;
    address: GeocodedAddress | null;
  }): AdminDevice {
    const { device, userEmail, last, share, address } = params;

    const ageSeconds = last
      ? Math.max(0, Math.floor((Date.now() - last.recordedAt.getTime()) / 1000))
      : null;

    return {
      id: device.id,
      userId: device.userId,
      userEmail,
      platform: device.platform,
      deviceName: device.deviceName,
      createdAt: device.createdAt.toISOString(),
      lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
      appVersion: device.appVersion,
      osVersion: device.osVersion,
      batteryLevel: device.batteryLevel,
      permissionStatus: device.permissionStatus,
      shareStatus: share ? this.effectiveShareStatus(share) : null,
      shareExpiresAt: share ? share.expiresAt.toISOString() : null,
      lastLocation: last ? toPublicLocation(last) : null,
      address,
      freshness: classifyFreshness(ageSeconds, this.offlineAfterMinutes),
      ageSeconds,
    };
  }

  /** Contadores del centro de control. */
  async overview(): Promise<AdminOverview> {
    const now = new Date();

    const [
      totalUsers,
      totalDevices,
      activeShares,
      sharingRows,
      devices,
      latest,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.device.count(),
      this.prisma.locationShare.count({
        where: { status: "ACTIVE", expiresAt: { gt: now } },
      }),
      this.prisma.device.findMany({
        where: {
          shares: { some: { status: "ACTIVE", expiresAt: { gt: now } } },
        },
        select: { id: true },
      }),
      this.prisma.device.findMany({ select: { id: true } }),
      this.prisma.location.findMany({
        select: { deviceId: true, recordedAt: true },
        orderBy: { recordedAt: "desc" },
        distinct: ["deviceId"],
      }),
    ]);

    const lastByDevice = new Map(
      latest.map((row) => [row.deviceId, row.recordedAt]),
    );

    let onlineDevices = 0;
    let staleDevices = 0;
    let offlineDevices = 0;
    let unknownDevices = 0;

    for (const device of devices) {
      const at = lastByDevice.get(device.id);
      const ageSeconds = at
        ? Math.max(0, Math.floor((Date.now() - at.getTime()) / 1000))
        : null;
      const freshness = classifyFreshness(ageSeconds, this.offlineAfterMinutes);
      if (freshness === "CURRENT") onlineDevices += 1;
      else if (freshness === "STALE") staleDevices += 1;
      else if (freshness === "OFFLINE") offlineDevices += 1;
      else unknownDevices += 1;
    }

    return {
      totalUsers,
      totalDevices,
      onlineDevices,
      staleDevices,
      offlineDevices,
      unknownDevices,
      sharingDevices: sharingRows.length,
      activeShares,
      // "Alertas": dispositivos que requieren atencion (datos antiguos o sin datos).
      alerts: staleDevices + offlineDevices,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Lista global de dispositivos con filtros por plataforma, estado y busqueda. */
  async listDevices(query: AdminDeviceQuery): Promise<AdminDevice[]> {
    const devices = await this.prisma.device.findMany({
      where: {
        ...(query.platform ? { platform: query.platform } : {}),
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.q
          ? {
              OR: [
                { deviceName: { contains: query.q, mode: "insensitive" } },
                {
                  user: {
                    email: { contains: query.q, mode: "insensitive" },
                  },
                },
              ],
            }
          : {}),
      },
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: "desc" },
      take: query.limit,
    });

    const deviceIds = devices.map((device) => device.id);

    const [latestRows, shareRows] = await Promise.all([
      deviceIds.length > 0
        ? this.prisma.location.findMany({
            where: { deviceId: { in: deviceIds } },
            orderBy: { recordedAt: "desc" },
            distinct: ["deviceId"],
          })
        : Promise.resolve([]),
      deviceIds.length > 0
        ? this.prisma.locationShare.findMany({
            where: { deviceId: { in: deviceIds } },
            orderBy: { startedAt: "desc" },
            distinct: ["deviceId"],
          })
        : Promise.resolve([]),
    ]);

    const lastByDevice = new Map(
      latestRows.map((row) => [row.deviceId, row as LocationRecord]),
    );
    const shareByDevice = new Map(
      shareRows.map((row) => [row.deviceId, row as ShareRow]),
    );

    // Direcciones: solo desde cache (nunca se llama al proveedor en una lista).
    const points = latestRows.map((row) => ({
      latitude: row.latitude,
      longitude: row.longitude,
    }));
    const addressMap = await this.geocoding.lookupMany(points);

    const built = devices.map((device) => {
      const last = lastByDevice.get(device.id) ?? null;
      const address = last
        ? (addressMap.get(
            this.geocoding.keyFor(last.latitude, last.longitude),
          ) ?? null)
        : null;
      return this.buildDevice({
        device,
        userEmail: device.user.email,
        last,
        share: shareByDevice.get(device.id) ?? null,
        address,
      });
    });

    if (!query.status) return built;
    return built.filter((device) => device.freshness === query.status);
  }

  /**
   * Ficha ampliada de un dispositivo. Se audita el acceso: un administrador no
   * puede consultar una ficha sin dejar constancia.
   */
  async detail(
    deviceId: string,
    actorId: string,
    ip: string | null,
  ): Promise<AdminDeviceDetail> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: { user: { select: { email: true } } },
    });
    if (!device) {
      throw new NotFoundException("Dispositivo no encontrado");
    }

    const [last, share, shares, stats] = await Promise.all([
      this.prisma.location.findFirst({
        where: { deviceId },
        orderBy: { recordedAt: "desc" },
      }),
      this.prisma.locationShare.findFirst({
        where: { deviceId },
        orderBy: { startedAt: "desc" },
      }),
      this.prisma.locationShare.findMany({
        where: { deviceId },
        orderBy: { startedAt: "desc" },
        take: 20,
      }),
      this.prisma.location.aggregate({
        where: { deviceId },
        _count: { _all: true },
        _min: { recordedAt: true },
        _max: { recordedAt: true },
      }),
    ]);

    // En la ficha si se permite consultar al proveedor (bajo demanda) para
    // mostrar la mejor direccion disponible; si falla, queda en null.
    const address = last
      ? await this.geocoding.resolve(last.latitude, last.longitude)
      : null;

    await this.audit.record({
      actorId,
      action: "admin.device.view",
      metadata: { deviceId, deviceName: device.deviceName },
      ip,
    });

    const base = this.buildDevice({
      device,
      userEmail: device.user.email,
      last: last ?? null,
      share: share ?? null,
      address,
    });

    return {
      ...base,
      shares: shares.map((row) => this.shareToPublic(row as ShareRow)),
      locationCount: stats._count._all,
      firstLocationAt: stats._min.recordedAt
        ? stats._min.recordedAt.toISOString()
        : null,
      lastLocationAt: stats._max.recordedAt
        ? stats._max.recordedAt.toISOString()
        : null,
    };
  }

  /** Historial de un dispositivo (vision global del administrador). */
  async history(
    deviceId: string,
    query: AdminHistoryQuery,
    actorId: string,
    ip: string | null,
  ): Promise<PublicLocation[]> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true, deviceName: true },
    });
    if (!device) {
      throw new NotFoundException("Dispositivo no encontrado");
    }

    const rows = await this.prisma.location.findMany({
      where: {
        deviceId,
        recordedAt: {
          ...(query.from ? { gte: new Date(query.from) } : {}),
          ...(query.to ? { lte: new Date(query.to) } : {}),
        },
      },
      orderBy: { recordedAt: "desc" },
      take: query.limit,
    });

    await this.audit.record({
      actorId,
      action: "admin.history.view",
      metadata: { deviceId, limit: query.limit, from: query.from ?? null },
      ip,
    });

    return rows.map((row) => toPublicLocation(row as LocationRecord));
  }

  /** Revoca todas las sesiones de comparticion activas de un dispositivo. */
  async revokeAccess(
    deviceId: string,
    reason: string | undefined,
    actorId: string,
    ip: string | null,
  ): Promise<{ revoked: number }> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true, deviceName: true },
    });
    if (!device) {
      throw new NotFoundException("Dispositivo no encontrado");
    }

    const result = await this.prisma.locationShare.updateMany({
      where: { deviceId, status: "ACTIVE" },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
        stopReason: reason ?? "Revocado por un administrador de la plataforma",
      },
    });

    await this.audit.record({
      actorId,
      action: "admin.share.revoke_all",
      metadata: { deviceId, revoked: result.count, reason: reason ?? null },
      ip,
    });

    this.gateway.emitDeviceChange(deviceId, "share.changed", {
      status: "REVOKED",
      revoked: result.count,
    });
    this.gateway.emitDeviceStatus(deviceId, "OFFLINE");

    return { revoked: result.count };
  }

  /**
   * Desvincula (elimina) un dispositivo de la plataforma.
   * Al borrarlo se eliminan en cascada sus sesiones y su historial de
   * ubicaciones (ver `onDelete: Cascade` en el esquema).
   */
  async unlinkDevice(
    deviceId: string,
    actorId: string,
    ip: string | null,
  ): Promise<{ success: true }> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true, deviceName: true, userId: true },
    });
    if (!device) {
      throw new NotFoundException("Dispositivo no encontrado");
    }

    await this.prisma.device.delete({ where: { id: deviceId } });

    await this.audit.record({
      actorId,
      action: "admin.device.unlink",
      metadata: {
        deviceId,
        deviceName: device.deviceName,
        ownerId: device.userId,
      },
      ip,
    });

    this.gateway.emitDeviceChange(deviceId, "device.removed", {
      deviceName: device.deviceName,
    });

    return { success: true };
  }

  /** Feed de eventos de seguridad para el panel de administracion. */
  listAudit(options: {
    action?: string;
    limit: number;
  }): Promise<AdminAuditEntry[]> {
    return this.audit.listRecent(options);
  }
}
