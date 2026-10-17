import {
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type {
  CreateRemoteAccessRequestInput,
  EndMediaSessionInput,
  PublicMediaSession,
  PublicRemoteAccessRequest,
  RemoteAccessListQuery,
  RemoteRequestStatus,
  RemoteSensor,
} from "@geo/shared";
import { AdminGateway } from "../admin/admin.gateway";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { RemoteAccessGateway } from "./remote-access.gateway";

/** Fila de solicitud con las relaciones que usa la API. */
interface RequestRow {
  id: string;
  deviceId: string;
  sensor: RemoteSensor;
  reason: string | null;
  status: RemoteRequestStatus;
  expiresAt: Date;
  respondedAt: Date | null;
  createdAt: Date;
  device?: { id: string; deviceName: string } | null;
  requestedBy?: { email: string } | null;
  session?: SessionRow | null;
}

interface SessionRow {
  id: string;
  requestId: string;
  deviceId: string;
  sensor: RemoteSensor;
  status: "ACTIVE" | "ENDED";
  startedAt: Date;
  endedAt: Date | null;
  endedReason: string | null;
}

/** Quien cierra una sesion de medios. */
export type SessionEndActor = "admin" | "user" | "device" | "system";

/**
 * Acceso remoto a camara y microfono.
 *
 * Este servicio implementa la unica via por la que la plataforma puede
 * llegar a los sensores de un telefono, y esta disenada para que sea
 * **imposible ocultarla**:
 *
 *   1. Solo el SUPERADMIN puede crear una solicitud, y crearla se audita.
 *   2. La solicitud caduca sola: el silencio no es consentimiento.
 *   3. Solo el dueno del dispositivo puede aceptar, y aceptar crea una
 *      sesion de medios que queda registrada.
 *   4. Cualquier cierre de sesion (administrador, usuario o dispositivo)
 *      deja constancia de quien termino y por que.
 *
 * La senalizacion WebRTC pasa por `RemoteAccessGateway`; el audio y el
 * video viajan de extremo a extremo.
 */
@Injectable()
export class RemoteAccessService {
  private readonly logger = new Logger(RemoteAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly admin: AdminGateway,
    private readonly mediaGateway: RemoteAccessGateway,
  ) {}

  // ------------------------------ Administrador -----------------------------

  /**
   * Crea una solicitud de acceso para un dispositivo.
   * Una solicitud pendiente previa del mismo dispositivo se cancela: solo
   * puede haber una petición abierta a la vez.
   */
  async createRequest(
    deviceId: string,
    input: CreateRemoteAccessRequestInput,
    actor: { id: string; email: string },
    ip: string | null,
  ): Promise<PublicRemoteAccessRequest> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true, deviceName: true },
    });
    if (!device) throw new NotFoundException("Dispositivo no encontrado");

    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.remoteAccessRequest.updateMany({
        where: { deviceId, status: "PENDING" },
        data: { status: "CANCELLED", respondedAt: now },
      });
      return tx.remoteAccessRequest.create({
        data: {
          deviceId,
          requestedById: actor.id,
          sensor: input.sensor,
          reason: input.reason ?? null,
          expiresAt: new Date(now.getTime() + input.ttlSeconds * 1_000),
        },
        include: REQUEST_INCLUDE,
      });
    });

    await this.audit.record({
      actorId: actor.id,
      action: "remote.request.create",
      metadata: {
        deviceId,
        deviceName: device.deviceName,
        sensor: input.sensor,
        requestId: row.id,
        ttlSeconds: input.ttlSeconds,
        reason: row.reason,
      },
      ip,
    });

    const request = this.toPublic(row);
    this.admin.emitRemoteRequest(request);
    this.logger.log(
      `Solicitud ${request.id} de ${actor.email} para ${device.deviceName} (${input.sensor})`,
    );
    return request;
  }

  /** Listado de solicitudes para el panel (con su sesion asociada). */
  async list(
    query: RemoteAccessListQuery,
  ): Promise<PublicRemoteAccessRequest[]> {
    await this.expireStale();

    const rows = await this.prisma.remoteAccessRequest.findMany({
      where: {
        ...(query.deviceId ? { deviceId: query.deviceId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: query.limit,
      include: REQUEST_INCLUDE,
    });

    return rows.map((row) => this.toPublic(row));
  }

  /** Cancela una solicitud pendiente (el administrador se echa atras). */
  async cancel(
    requestId: string,
    actorId: string,
    ip: string | null,
  ): Promise<PublicRemoteAccessRequest> {
    const row = await this.prisma.remoteAccessRequest.findUnique({
      where: { id: requestId },
      include: REQUEST_INCLUDE,
    });
    if (!row) throw new NotFoundException("Solicitud no encontrada");
    if (row.status !== "PENDING") {
      throw new ConflictException("La solicitud ya fue resuelta");
    }

    const updated = await this.prisma.remoteAccessRequest.update({
      where: { id: requestId },
      data: { status: "CANCELLED", respondedAt: new Date() },
      include: REQUEST_INCLUDE,
    });

    await this.audit.record({
      actorId,
      action: "remote.request.cancel",
      metadata: {
        requestId,
        deviceId: row.deviceId,
        sensor: row.sensor,
      },
      ip,
    });

    const request = this.toPublic(updated);
    this.admin.emitRemoteRequest(request);
    return request;
  }

  // -------------------------- Dispositivo / usuario -------------------------

  /**
   * Solicitudes pendientes y vigentes de los dispositivos del usuario.
   * Es lo que consulta la app movil mientras esta en ejecucion.
   */
  async pending(userId: string): Promise<PublicRemoteAccessRequest[]> {
    await this.expireStale();

    const rows = await this.prisma.remoteAccessRequest.findMany({
      where: {
        status: "PENDING",
        expiresAt: { gt: new Date() },
        device: { userId },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: REQUEST_INCLUDE,
    });

    return rows.map((row) => this.toPublic(row));
  }

  /**
   * Responde a una solicitud desde el movil.
   *
   * `accept: false` deja constancia del rechazo; `accept: true` crea la
   * sesion de medios. En ningun caso se captura nada antes de esta llamada.
   */
  async respond(
    requestId: string,
    userId: string,
    accept: boolean,
    ip: string | null,
  ): Promise<{ request: PublicRemoteAccessRequest; session: PublicMediaSession | null }> {
    const row = await this.prisma.remoteAccessRequest.findFirst({
      where: { id: requestId, device: { userId } },
      include: REQUEST_INCLUDE,
    });
    if (!row) throw new NotFoundException("Solicitud no encontrada");
    if (row.status !== "PENDING") {
      throw new ConflictException("La solicitud ya fue resuelta");
    }

    const now = new Date();
    if (row.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.remoteAccessRequest.update({
        where: { id: requestId },
        data: { status: "EXPIRED" },
      });
      throw new GoneException("La solicitud ha caducado");
    }

    if (!accept) {
      const updated = await this.prisma.remoteAccessRequest.update({
        where: { id: requestId },
        data: { status: "REJECTED", respondedAt: now },
        include: REQUEST_INCLUDE,
      });
      await this.audit.record({
        actorId: userId,
        action: "remote.request.reject",
        metadata: { requestId, deviceId: row.deviceId, sensor: row.sensor },
        ip,
      });
      const request = this.toPublic(updated);
      this.admin.emitRemoteRequest(request);
      return { request, session: null };
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // Condicion de carrera: gana quien lee PENDING primero.
      const claim = await tx.remoteAccessRequest.updateMany({
        where: { id: requestId, status: "PENDING" },
        data: { status: "ACCEPTED", respondedAt: now },
      });
      if (claim.count === 0) {
        throw new ConflictException("La solicitud ya fue resuelta");
      }
      await tx.mediaSession.create({
        data: {
          requestId,
          deviceId: row.deviceId,
          sensor: row.sensor,
          startedAt: now,
        },
      });
      return tx.remoteAccessRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: REQUEST_INCLUDE,
      });
    });

    const request = this.toPublic(updated);
    const session = request.session;
    // Habilita la retransmision de senales WebRTC para esta sesion.
    if (session) this.mediaGateway.markStarted(session.id);

    await this.audit.record({
      actorId: userId,
      action: "remote.request.accept",
      metadata: {
        requestId,
        deviceId: row.deviceId,
        sensor: row.sensor,
        sessionId: session?.id ?? null,
      },
      ip,
    });
    if (session) {
      await this.audit.record({
        actorId: userId,
        action: "remote.session.start",
        metadata: {
          sessionId: session.id,
          requestId,
          deviceId: row.deviceId,
          sensor: row.sensor,
        },
        ip,
      });
    }

    this.admin.emitRemoteRequest(request);
    if (session) this.admin.emitMediaSession(request);
    return { request, session };
  }

  /** Sesiones de medios actualmente abiertas en los dispositivos del usuario. */
  async active(userId: string): Promise<PublicRemoteAccessRequest[]> {
    const rows = await this.prisma.remoteAccessRequest.findMany({
      where: {
        session: { status: "ACTIVE" },
        device: { userId },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: REQUEST_INCLUDE,
    });
    return rows.map((row) => this.toPublic(row));
  }

  /**
   * Cierra una sesion de medios.
   * Valida la propiedad cuando el cierre lo hace el propio usuario.
   */
  async endSession(
    sessionId: string,
    actor: { id: string; role: string },
    source: SessionEndActor,
    input: EndMediaSessionInput | undefined,
    ip: string | null,
  ): Promise<PublicRemoteAccessRequest> {
    const row = await this.prisma.mediaSession.findUnique({
      where: { id: sessionId },
      include: { request: { include: REQUEST_INCLUDE } },
    });
    if (!row) throw new NotFoundException("Sesion no encontrada");
    if (row.status !== "ACTIVE") {
      throw new ConflictException("La sesion ya esta cerrada");
    }

    if (source !== "admin") {
      const owner = await this.prisma.device.findUnique({
        where: { id: row.deviceId },
        select: { userId: true },
      });
      if (owner?.userId !== actor.id) {
        throw new ForbiddenException("No autorizado para cerrar esta sesion");
      }
    }

    const now = new Date();
    const reason = input?.reason ?? "Finalizada";
    await this.prisma.mediaSession.update({
      where: { id: sessionId },
      data: {
        status: "ENDED",
        endedAt: now,
        endedBy: source === "admin" ? actor.id : source,
        endedReason: reason,
      },
    });

    await this.audit.record({
      actorId: actor.id,
      action: "remote.session.end",
      metadata: {
        sessionId,
        deviceId: row.deviceId,
        sensor: row.sensor,
        source,
        reason,
      },
      ip,
    });

    // Corta cualquier senalizacion en curso y avisa a los dos extremos.
    this.mediaGateway.markEnded(sessionId);

    const request = this.toPublic(row.request);
    if (request.session) {
      request.session = {
        ...request.session,
        status: "ENDED",
        endedAt: now.toISOString(),
        endedReason: reason,
      };
    }
    this.admin.emitRemoteRequest(request);
    this.admin.emitMediaSession(request);
    return request;
  }

  // --------------------------------- Internos --------------------------------

  /**
   * Marca como caducadas las solicitudes pendientes que ya vencieron.
   * Se ejecuta antes de cada lectura, sin temporizador en memoria: tras un
   * reinicio de la API el estado correcto se recalcula igualmente.
   */
  private async expireStale(): Promise<void> {
    const expired = await this.prisma.remoteAccessRequest.updateMany({
      where: { status: "PENDING", expiresAt: { lte: new Date() } },
      data: { status: "EXPIRED" },
    });
    if (expired.count > 0) {
      this.logger.debug(`${expired.count} solicitudes caducadas`);
    }
  }

  private toPublic(row: RequestRow): PublicRemoteAccessRequest {
    return {
      id: row.id,
      deviceId: row.deviceId,
      deviceName: row.device?.deviceName ?? null,
      sensor: row.sensor,
      status: row.status,
      reason: row.reason,
      requestedByEmail: row.requestedBy?.email ?? null,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      respondedAt: row.respondedAt ? row.respondedAt.toISOString() : null,
      session: row.session ? sessionToPublic(row.session) : null,
    };
  }
}

export function sessionToPublic(row: SessionRow): PublicMediaSession {
  return {
    id: row.id,
    requestId: row.requestId,
    deviceId: row.deviceId,
    sensor: row.sensor,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    endedReason: row.endedReason,
  };
}

/** Relaciones incluidas en toda lectura de solicitudes. */
const REQUEST_INCLUDE = {
  device: { select: { id: true, deviceName: true } },
  requestedBy: { select: { email: true } },
  session: true,
} as const;
