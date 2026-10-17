import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  CreatedLocationShare,
  LocationShareStatus,
  PublicLocationShare,
  StartShareInput,
  StopShareInput,
} from "@geo/shared";
import { AdminGateway } from "../admin/admin.gateway";
import { AuditService } from "../audit/audit.service";
import { CryptoService } from "../crypto/crypto.service";
import { DevicesService } from "../devices/devices.service";
import { PrismaService } from "../prisma/prisma.service";

export interface ShareRecord {
  id: string;
  deviceId: string;
  tokenHash: string;
  status: LocationShareStatus;
  startedAt: Date;
  expiresAt: Date;
  stoppedAt: Date | null;
  revokedAt: Date | null;
  stopReason: string | null;
}

@Injectable()
export class LocationSharesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly devices: DevicesService,
    private readonly admin: AdminGateway,
  ) {}

  /**
   * Inicia una sesion de comparticion para un dispositivo propio.
   * Solo puede existir UNA sesion activa por dispositivo: si habia otra,
   * se detiene automaticamente para no dejar flujos zombie.
   *
   * Devuelve el token en claro UNA sola vez; en la base solo queda su hash.
   */
  async start(
    userId: string,
    input: StartShareInput,
    ip: string | null,
  ): Promise<CreatedLocationShare> {
    const device = await this.devices.findOwnedOrThrow(input.deviceId, userId);

    const token = this.crypto.randomToken(32);
    const tokenHash = this.crypto.sha256(token);
    const expiresAt = new Date(Date.now() + input.expiresInMinutes * 60_000);

    const share = await this.prisma.$transaction(async (tx) => {
      await tx.locationShare.updateMany({
        where: { deviceId: device.id, status: "ACTIVE" },
        data: {
          status: "STOPPED",
          stoppedAt: new Date(),
          stopReason: "Reemplazada por una nueva sesion de comparticion",
        },
      });

      return tx.locationShare.create({
        data: { deviceId: device.id, tokenHash, expiresAt },
      });
    });

    await this.audit.record({
      actorId: userId,
      action: "share.start",
      metadata: {
        shareId: share.id,
        deviceId: device.id,
        expiresInMinutes: input.expiresInMinutes,
      },
      ip,
    });

    // El panel de administracion recibe el cambio para refrescar el estado.
    this.admin.emitDeviceChange(device.id, "share.changed", {
      shareId: share.id,
      status: "ACTIVE",
      expiresAt: share.expiresAt.toISOString(),
    });

    return { ...this.toPublic(share), shareToken: token };
  }

  /** Lista las sesiones de un dispositivo propio, marcando las expiradas. */
  async listForDevice(
    userId: string,
    deviceId: string,
  ): Promise<PublicLocationShare[]> {
    await this.devices.findOwnedOrThrow(deviceId, userId);
    const shares = await this.prisma.locationShare.findMany({
      where: { deviceId },
      orderBy: { startedAt: "desc" },
      take: 100,
    });
    return shares.map((share) => this.toPublic(share));
  }

  async getOwnedOrThrow(userId: string, shareId: string): Promise<ShareRecord> {
    const share = await this.prisma.locationShare.findFirst({
      where: { id: shareId, device: { userId } },
    });
    if (!share)
      throw new NotFoundException("Sesion de comparticion no encontrada");
    return share;
  }

  async stop(
    userId: string,
    shareId: string,
    input: StopShareInput,
    ip: string | null,
  ): Promise<PublicLocationShare> {
    const share = await this.getOwnedOrThrow(userId, shareId);
    if (share.status !== "ACTIVE") {
      throw new BadRequestException("La sesion ya no esta activa");
    }

    const updated = await this.prisma.locationShare.update({
      where: { id: share.id },
      data: {
        status: "STOPPED",
        stoppedAt: new Date(),
        stopReason: input.reason ?? null,
      },
    });

    await this.audit.record({
      actorId: userId,
      action: "share.stop",
      metadata: {
        shareId: share.id,
        deviceId: share.deviceId,
        reason: input.reason ?? null,
      },
      ip,
    });

    this.admin.emitDeviceChange(share.deviceId, "share.changed", {
      shareId: share.id,
      status: updated.status,
    });

    return this.toPublic(updated);
  }

  /**
   * Revoca una sesion (por ejemplo si el usuario sospecha un uso indebido).
   * A diferencia de `stop`, deja constancia del motivo y del momento exacto.
   */
  async revoke(
    userId: string,
    shareId: string,
    input: StopShareInput,
    ip: string | null,
  ): Promise<PublicLocationShare> {
    const share = await this.getOwnedOrThrow(userId, shareId);

    const updated = await this.prisma.locationShare.update({
      where: { id: share.id },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
        stopReason: input.reason ?? share.stopReason,
      },
    });

    await this.audit.record({
      actorId: userId,
      action: "share.revoke",
      metadata: {
        shareId: share.id,
        deviceId: share.deviceId,
        reason: input.reason ?? null,
      },
      ip,
    });

    this.admin.emitDeviceChange(share.deviceId, "share.changed", {
      shareId: share.id,
      status: updated.status,
    });

    return this.toPublic(updated);
  }

  /**
   * Busca una sesion por el token en claro enviado por el dispositivo.
   * Marca como EXPIRED las que ya vencieron y devuelve null si no es usable.
   */
  async findUsableByToken(token: string): Promise<ShareRecord | null> {
    const share = await this.prisma.locationShare.findUnique({
      where: { tokenHash: this.crypto.sha256(token) },
    });
    if (!share) return null;

    if (share.status === "ACTIVE" && share.expiresAt.getTime() <= Date.now()) {
      const expired = await this.prisma.locationShare.update({
        where: { id: share.id },
        data: { status: "EXPIRED" },
      });
      return expired;
    }

    return share;
  }

  /** Marca como EXPIRED todas las sesiones vencidas (limpieza periodica). */
  async markExpired(): Promise<number> {
    const result = await this.prisma.locationShare.updateMany({
      where: { status: "ACTIVE", expiresAt: { lte: new Date() } },
      data: { status: "EXPIRED" },
    });
    return result.count;
  }

  /** Estado efectivo considerando la fecha de expiracion. */
  effectiveStatus(share: ShareRecord): LocationShareStatus {
    if (share.status === "ACTIVE" && share.expiresAt.getTime() <= Date.now()) {
      return "EXPIRED";
    }
    return share.status;
  }

  toPublic(share: ShareRecord): PublicLocationShare {
    return {
      id: share.id,
      deviceId: share.deviceId,
      status: this.effectiveStatus(share),
      startedAt: share.startedAt.toISOString(),
      expiresAt: share.expiresAt.toISOString(),
      stoppedAt: share.stoppedAt ? share.stoppedAt.toISOString() : null,
      revokedAt: share.revokedAt ? share.revokedAt.toISOString() : null,
    };
  }
}
