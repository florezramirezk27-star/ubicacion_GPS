import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  createRemoteAccessRequestSchema,
  endMediaSessionSchema,
  remoteAccessListQuerySchema,
  respondRemoteAccessSchema,
  type CreateRemoteAccessRequestInput,
  type EndMediaSessionInput,
  type PublicMediaSession,
  type PublicRemoteAccessRequest,
  type RemoteAccessListQuery,
  type RespondRemoteAccessInput,
} from "@geo/shared";
import { AdminGuard } from "../admin/admin.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { clientIp } from "../common/http.util";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { AuthenticatedRequest, AuthenticatedUser } from "../common/types";
import { RemoteAccessService } from "./remote-access.service";

/**
 * Acceso remoto a camara y microfono.
 *
 * Dos bloques de rutas en un unico controlador para que se lea de un vistazo
 * quien puede hacer que:
 *
 *   * `/admin/**`   -> solo SUPERADMIN (`AdminGuard`): solicitar, cancelar y
 *                      finalizar sesiones. Toda peticion se audita.
 *   * `/remote-access/**` -> cualquier usuario autenticado, y ademas solo
 *                      sobre sus propios dispositivos (lo comprueba el servicio).
 *                      Es lo que usa la app movil.
 *
 * No hay ninguna ruta que active la camara sin pasar por `respond` con
 * `accept: true`, que es donde el usuario da su consentimiento.
 */
@Controller()
export class RemoteAccessController {
  constructor(private readonly remoteAccess: RemoteAccessService) {}

  // ------------------------------ Administrador ------------------------------

  @Post("admin/devices/:id/remote-access")
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param("id") deviceId: string,
    @Body(new ZodValidationPipe(createRemoteAccessRequestSchema))
    input: CreateRemoteAccessRequestInput,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<PublicRemoteAccessRequest> {
    return this.remoteAccess.createRequest(deviceId, input, user, clientIp(req));
  }

  @Get("admin/remote-access")
  @UseGuards(AdminGuard)
  async list(
    @Query(new ZodValidationPipe(remoteAccessListQuerySchema))
    query: RemoteAccessListQuery,
  ): Promise<PublicRemoteAccessRequest[]> {
    return this.remoteAccess.list(query);
  }

  @Post("admin/remote-access/:id/cancel")
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  async cancel(
    @Param("id") requestId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<PublicRemoteAccessRequest> {
    return this.remoteAccess.cancel(requestId, user.id, clientIp(req));
  }

  @Post("admin/media-sessions/:id/end")
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  async adminEndSession(
    @Param("id") sessionId: string,
    @Body(new ZodValidationPipe(endMediaSessionSchema))
    input: EndMediaSessionInput,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<PublicRemoteAccessRequest> {
    return this.remoteAccess.endSession(
      sessionId,
      { id: user.id, role: user.role },
      "admin",
      input,
      clientIp(req),
    );
  }

  // --------------------------- Dispositivo / usuario -------------------------

  @Get("remote-access/pending")
  async pending(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PublicRemoteAccessRequest[]> {
    return this.remoteAccess.pending(user.id);
  }

  @Post("remote-access/:id/respond")
  @HttpCode(HttpStatus.OK)
  async respond(
    @Param("id") requestId: string,
    @Body(new ZodValidationPipe(respondRemoteAccessSchema))
    input: RespondRemoteAccessInput,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ request: PublicRemoteAccessRequest; session: PublicMediaSession | null }> {
    return this.remoteAccess.respond(requestId, user.id, input.accept, clientIp(req));
  }

  @Get("remote-access/sessions/active")
  async active(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PublicRemoteAccessRequest[]> {
    return this.remoteAccess.active(user.id);
  }

  @Post("remote-access/sessions/:id/end")
  @HttpCode(HttpStatus.OK)
  async userEndSession(
    @Param("id") sessionId: string,
    @Body(new ZodValidationPipe(endMediaSessionSchema))
    input: EndMediaSessionInput,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest,
  ): Promise<PublicRemoteAccessRequest> {
    return this.remoteAccess.endSession(
      sessionId,
      { id: user.id, role: user.role },
      "user",
      input,
      clientIp(req),
    );
  }
}
