import { Injectable, Logger } from "@nestjs/common";
import type { AdminAuditEntry } from "@geo/shared";
import { CryptoService } from "../crypto/crypto.service";
import { PrismaService } from "../prisma/prisma.service";

export interface AuditRecordInput {
  actorId?: string | null;
  action: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  action: string;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

/**
 * Registro de auditoria.
 *
 * Cada accion sensible (inicio/cierre de sesion, vinculacion de dispositivo,
 * inicio/parada/revocacion de comparticion, ingesta de coordenadas) queda
 * registrada. Los metadatos se cifran con AES-256-GCM antes de persistirse.
 *
 * El registro nunca debe tumbar la peticion del usuario: si falla, se registra
 * en el log del servidor y se continua.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async record(input: AuditRecordInput): Promise<void> {
    try {
      const metadata =
        input.metadata && Object.keys(input.metadata).length > 0
          ? this.crypto.encrypt(JSON.stringify(input.metadata))
          : null;

      await this.prisma.auditLog.create({
        data: {
          actorId: input.actorId ?? null,
          action: input.action,
          metadata,
          ip: input.ip ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        `No se pudo registrar la auditoria "${input.action}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Lista los ultimos eventos de un actor, descifrando los metadatos. */
  async listForActor(actorId: string, limit = 50): Promise<AuditLogEntry[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { actorId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
    });

    return rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      action: row.action,
      metadata: this.decodeMetadata(row.metadata),
      ip: row.ip,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Feed global de eventos para el panel de administracion: incluye el correo
   * del actor (dato de contexto, no de contenido) y admite filtrar por accion.
   */
  async listRecent(options: {
    action?: string;
    limit: number;
  }): Promise<AdminAuditEntry[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: options.action ? { action: options.action } : undefined,
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(options.limit, 1), 200),
      include: { actor: { select: { email: true } } },
    });

    return rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorEmail: row.actor?.email ?? null,
      action: row.action,
      metadata: this.decodeMetadata(row.metadata),
      ip: row.ip,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private decodeMetadata(value: string | null): Record<string, unknown> | null {
    if (!value) return null;
    const json = this.crypto.decrypt(value);
    if (!json) return null;
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
