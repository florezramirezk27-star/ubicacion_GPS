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
import {
  MEDIA_WS_EVENTS,
  mediaRoom,
  webrtcSignalSchema,
  type AccessTokenPayload,
  type UserRole,
  type WebrtcSignal,
} from "@geo/shared";
import type { Namespace, Socket } from "socket.io";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Senalizacion WebRTC entre el movil (fuente de audio/video) y el panel del
 * administrador (visor).
 *
 * Namespace propio (`/media`) para no mezclar el flujo de ubicacion con el de
 * los sensores. El servidor **no ve ni almacena audio ni video**: solo valida
 * que el emisor este unido a la sala de su sesion y reenvia las senales SDP e
 * ICE al otro extremo.
 *
 * Autorizacion por sesion:
 *   * `media:join` comprueba que la sesion esta ACTIVE y que el cliente es el
 *     dueno del dispositivo o un SUPERADMIN.
 *   * Cada reenvio se limita a salas en las que el cliente esta realmente
 *     unido, y solo mientras la sesion sigue activa en memoria (el servicio la
 *     marca al iniciarse y la retira al cerrarse).
 */
@WebSocketGateway({ namespace: "/media" })
export class RemoteAccessGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private server!: Namespace;

  private readonly logger = new Logger(RemoteAccessGateway.name);

  /** Sesiones de medios activas conocidas por este proceso. */
  private readonly activeSessions = new Set<string>();

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
      client.data.role = payload.role ?? "USER";
      this.logger.debug(`Cliente de medios conectado: ${payload.email}`);
    } catch {
      this.reject(client, "Token invalido o expirado");
    }
  }

  handleDisconnect(client: Socket): void {
    if (client.data.userId) {
      this.logger.debug(
        `Cliente de medios desconectado: ${client.data.userId as string}`,
      );
    }
  }

  @SubscribeMessage("media:join")
  async onJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { sessionId?: string },
  ): Promise<{ event: string; data: Record<string, unknown> }> {
    const userId = client.data.userId as string | undefined;
    const role = client.data.role as UserRole | undefined;
    const sessionId = body?.sessionId;

    if (!userId) return err("No autorizado");
    if (!sessionId) return err("sessionId es obligatorio");

    const session = await this.prisma.mediaSession.findUnique({
      where: { id: sessionId },
      select: { status: true, device: { select: { userId: true } } },
    });
    if (!session) return err("Sesion no encontrada");
    if (session.status !== "ACTIVE") return err("La sesion ya esta cerrada");
    if (role !== "SUPERADMIN" && session.device.userId !== userId) {
      return err("No autorizado para esta sesion");
    }

    await client.join(mediaRoom(sessionId));
    this.activeSessions.add(sessionId);

    return {
      event: "media:joined",
      data: { sessionId, role: role === "SUPERADMIN" ? "viewer" : "source" },
    };
  }

  @SubscribeMessage(MEDIA_WS_EVENTS.offer)
  onOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() signal: WebrtcSignal,
  ): { event: string; data: Record<string, unknown> } | undefined {
    return this.relay(client, MEDIA_WS_EVENTS.offer, signal);
  }

  @SubscribeMessage(MEDIA_WS_EVENTS.answer)
  onAnswer(
    @ConnectedSocket() client: Socket,
    @MessageBody() signal: WebrtcSignal,
  ): { event: string; data: Record<string, unknown> } | undefined {
    return this.relay(client, MEDIA_WS_EVENTS.answer, signal);
  }

  @SubscribeMessage(MEDIA_WS_EVENTS.ice)
  onIce(
    @ConnectedSocket() client: Socket,
    @MessageBody() signal: WebrtcSignal,
  ): { event: string; data: Record<string, unknown> } | undefined {
    return this.relay(client, MEDIA_WS_EVENTS.ice, signal);
  }

  /** El emisor anuncia que corta la captura: se retransmite y se retira la sala. */
  @SubscribeMessage(MEDIA_WS_EVENTS.end)
  async onEnd(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { sessionId?: string },
  ): Promise<void> {
    const sessionId = body?.sessionId;
    if (!sessionId) return;
    if (!client.rooms.has(mediaRoom(sessionId))) return;
    client.to(mediaRoom(sessionId)).emit(MEDIA_WS_EVENTS.end, { sessionId });
    this.activeSessions.delete(sessionId);
  }

  /** El servicio avisa al arrancar una sesion de medios. */
  markStarted(sessionId: string): void {
    this.activeSessions.add(sessionId);
  }

  /**
   * El servicio avisa al cerrar una sesion: se corta cualquier senalizacion
   * en curso y se avisa a los extremos para que liberen la camara o el visor.
   */
  markEnded(sessionId: string): void {
    this.activeSessions.delete(sessionId);
    this.server?.to(mediaRoom(sessionId)).emit(MEDIA_WS_EVENTS.end, {
      sessionId,
      reason: "session-ended",
    });
  }

  private relay(
    client: Socket,
    event: string,
    signal: WebrtcSignal,
  ): { event: string; data: Record<string, unknown> } | undefined {
    const parsed = webrtcSignalSchema.safeParse(signal);
    if (!parsed.success) return err("Senal WebRTC no valida");

    const { sessionId } = parsed.data;
    if (!client.rooms.has(mediaRoom(sessionId))) {
      return err("No esta unido a la sesion");
    }
    if (!this.activeSessions.has(sessionId)) {
      return err("La sesion no esta activa");
    }

    client.to(mediaRoom(sessionId)).emit(event, parsed.data);
    return undefined;
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
    client.emit("media:error", { message });
    client.disconnect(true);
  }
}

function err(message: string): { event: string; data: Record<string, unknown> } {
  return { event: "media:error", data: { message } };
}
