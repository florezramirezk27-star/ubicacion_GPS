import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { AccessTokenPayload, PublicLocation } from "@geo/shared";
import type { Server, Socket } from "socket.io";
import { PrismaService } from "../prisma/prisma.service";

/** Nombre de la sala por usuario (el panel web se suscribe aqui). */
export const userRoom = (userId: string): string => `user:${userId}`;
/** Nombre de la sala por dispositivo (recibe las coordenadas en vivo). */
export const deviceRoom = (deviceId: string): string => `device:${deviceId}`;

/** Estado de conexion derivado, enviado al panel web. */
export type LiveDeviceStatus = "CONNECTED" | "STALE" | "OFFLINE";

/**
 * Gateway de Socket.IO para el seguimiento en vivo.
 *
 * Flujo:
 *   1. El cliente (panel web) se conecta enviando su access token JWT en el
 *      handshake (`auth.token`). Si es valido, entra a su sala de usuario.
 *   2. Emite `subscribe:device` para cada dispositivo que quiera observar.
 *      El servidor comprueba la propiedad antes de unirlo a la sala del equipo.
 *   3. Cuando el movil envia coordenadas por HTTP, la API emite
 *      `location:update` a la sala del dispositivo.
 *
 * Nota: el movil NO mantiene un socket permanente; envia por HTTP (mas fiable
 * en segundo plano) y el WebSocket sirve para difundir a los observadores.
 */
@WebSocketGateway()
export class LiveGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Server;

  private readonly logger = new Logger(LiveGateway.name);

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

      client.data.userId = payload.sub;
      client.data.email = payload.email;
      await client.join(userRoom(payload.sub));
      client.emit("live:ready", { userId: payload.sub });
      this.logger.debug(`Cliente conectado: ${payload.email}`);
    } catch {
      this.reject(client, "Token invalido o expirado");
    }
  }

  handleDisconnect(client: Socket): void {
    if (client.data.userId) {
      this.logger.debug(
        `Cliente desconectado: ${client.data.userId as string}`,
      );
    }
  }

  @SubscribeMessage("subscribe:device")
  async onSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { deviceId?: string },
  ): Promise<{ event: string; data: Record<string, unknown> }> {
    const userId = client.data.userId as string | undefined;
    const deviceId = body?.deviceId;

    if (!userId)
      return { event: "live:error", data: { message: "No autorizado" } };
    if (!deviceId)
      return {
        event: "live:error",
        data: { message: "deviceId es obligatorio" },
      };

    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, userId },
      select: { id: true },
    });
    if (!device) {
      return {
        event: "live:error",
        data: { message: "Dispositivo no encontrado" },
      };
    }

    await client.join(deviceRoom(deviceId));
    return { event: "live:subscribed", data: { deviceId } };
  }

  @SubscribeMessage("unsubscribe:device")
  async onUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { deviceId?: string },
  ): Promise<{ event: string; data: Record<string, unknown> }> {
    const deviceId = body?.deviceId;
    if (deviceId) await client.leave(deviceRoom(deviceId));
    return { event: "live:unsubscribed", data: { deviceId: deviceId ?? null } };
  }

  /** Difunde una coordenada nueva a todos los observadores del dispositivo. */
  emitLocation(location: PublicLocation): void {
    if (!this.server) return;
    this.server
      .to(deviceRoom(location.deviceId))
      .emit("location:update", location);
  }

  /** Difunde un cambio de estado (conectado / desactualizado / desconectado). */
  emitDeviceStatus(deviceId: string, status: LiveDeviceStatus): void {
    if (!this.server) return;
    this.server.to(deviceRoom(deviceId)).emit("device:status", {
      deviceId,
      status,
      at: new Date().toISOString(),
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
    client.emit("live:error", { message });
    client.disconnect(true);
  }
}
