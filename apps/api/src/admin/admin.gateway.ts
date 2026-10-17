import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { ADMIN_REMOTE_EVENTS } from "@geo/shared";
import type {
  AccessTokenPayload,
  PublicLocation,
  PublicRemoteAccessRequest,
} from "@geo/shared";
import type { Namespace, Socket } from "socket.io";
import { PrismaService } from "../prisma/prisma.service";

/** Sala unica donde entran los administradores autenticados. */
export const ADMIN_ROOM = "admin";

/** Tipo de cambio estructural que se difunde a los administradores. */
export type AdminDeviceChangeKind =
  "device.updated" | "device.removed" | "share.changed";

/**
 * Gateway de Socket.IO para el panel de Superadministrador.
 *
 * Se monta en un **namespace propio** (`/admin`) para no interferir con el
 * gateway de seguimiento por dispositivo (namespace raiz). Asi un usuario
 * normal jamas recibe el flujo global de la plataforma: solo entra aqui quien
 * acredita el rol SUPERADMIN.
 *
 * A diferencia de `LiveGateway`, que difunde por sala de dispositivo previa
 * suscripcion, este gateway emite a la sala `admin` TODOS los eventos, porque
 * el administrador tiene visibilidad global por definicion.
 */
@WebSocketGateway({ namespace: "/admin" })
export class AdminGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Namespace;

  private readonly logger = new Logger(AdminGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) {
      this.reject(client, "Token de acceso ausente");
      return;
    }

    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<string>("JWT_ACCESS_SECRET"),
      });
      if (payload.type !== "access") {
        this.reject(client, "Tipo de token incorrecto");
        return;
      }

      // El rol que viaja en el token puede estar desactualizado (por ejemplo si
      // se revoco el privilegio): se comprueba siempre contra la base de datos.
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { role: true, email: true },
      });
      if (!user || user.role !== "SUPERADMIN") {
        this.reject(client, "Se requiere el rol SUPERADMIN");
        return;
      }

      client.data.userId = payload.sub;
      client.data.email = user.email;
      await client.join(ADMIN_ROOM);
      client.emit("admin:ready", { userId: payload.sub, email: user.email });
      this.logger.debug(`Administrador conectado: ${user.email}`);
    } catch {
      this.reject(client, "Token invalido o expirado");
    }
  }

  handleDisconnect(client: Socket): void {
    if (client.data.userId) {
      this.logger.debug(
        `Administrador desconectado: ${client.data.userId as string}`,
      );
    }
  }

  /** Nueva coordenada de cualquier dispositivo de la plataforma. */
  emitLocation(location: PublicLocation): void {
    this.server?.to(ADMIN_ROOM).emit("admin:location", location);
  }

  /** Cambio de estado de conexion de un dispositivo. */
  emitDeviceStatus(deviceId: string, status: string): void {
    this.server?.to(ADMIN_ROOM).emit("admin:device-status", {
      deviceId,
      status,
      at: new Date().toISOString(),
    });
  }

  /**
   * Nueva solicitud de acceso a camara/micrófono (o un cambio de su estado).
   * El payload incluye la sesion asociada, si existe, para que el panel pueda
   * pintar "esperando consentimiento", "rechazada" o "sesion activa" sin
   * tener que relotear toda la lista.
   */
  emitRemoteRequest(request: PublicRemoteAccessRequest): void {
    this.server?.to(ADMIN_ROOM).emit(ADMIN_REMOTE_EVENTS.request, request);
  }

  /** Cambio de estado de una sesion de medios (inicio o cierre). */
  emitMediaSession(request: PublicRemoteAccessRequest): void {
    this.server?.to(ADMIN_ROOM).emit(ADMIN_REMOTE_EVENTS.session, request);
  }

  /** Cambio estructural: dispositivo dado de baja o sesion de comparticion. */
  emitDeviceChange(
    deviceId: string,
    kind: AdminDeviceChangeKind,
    detail: Record<string, unknown> = {},
  ): void {
    this.server?.to(ADMIN_ROOM).emit("admin:device-change", {
      deviceId,
      kind,
      at: new Date().toISOString(),
      ...detail,
    });
  }

  private extractToken(client: Socket): string | null {
    const fromAuth = client.handshake.auth?.token;
    if (typeof fromAuth === "string" && fromAuth.length > 0) return fromAuth;

    const header = client.handshake.headers.authorization;
    if (typeof header === "string") {
      const [scheme, token] = header.split(" ");
      if (scheme?.toLowerCase() === "bearer" && token) return token.trim();
    }
    return null;
  }

  private reject(client: Socket, message: string): void {
    client.emit("admin:error", { message });
    client.disconnect(true);
  }
}
