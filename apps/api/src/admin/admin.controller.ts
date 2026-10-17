import {
  Body,
  Controller,
  Delete,
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
  adminAuditQuerySchema,
  adminDeviceQuerySchema,
  adminHistoryQuerySchema,
  adminRevokeSchema,
  type AdminAuditEntry,
  type AdminDevice,
  type AdminDeviceDetail,
  type AdminDeviceQuery,
  type AdminHistoryQuery,
  type AdminOverview,
  type AdminRevokeInput,
  type PublicLocation,
} from "@geo/shared";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { clientIp } from "../common/http.util";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { AuthenticatedRequest, AuthenticatedUser } from "../common/types";
import { AdminGuard } from "./admin.guard";
import { AdminService } from "./admin.service";

/**
 * Panel de Superadministrador.
 *
 * Todas las rutas exigen el rol SUPERADMIN (`AdminGuard`). El guard global de
 * JWT se ejecuta antes, de modo que `user` siempre esta disponible.
 */
@Controller("admin")
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /** Contadores: dispositivos totales, conectados, compartiendo y alertas. */
  @Get("overview")
  overview(): Promise<AdminOverview> {
    return this.admin.overview();
  }

  /** Lista global de dispositivos con ultima ubicacion, estado y direccion. */
  @Get("devices")
  listDevices(
    @Query(new ZodValidationPipe(adminDeviceQuerySchema))
    query: AdminDeviceQuery,
  ): Promise<AdminDevice[]> {
    return this.admin.listDevices(query);
  }

  /** Ficha ampliada (queda auditada). */
  @Get("devices/:id")
  detail(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminDeviceDetail> {
    return this.admin.detail(id, user.id, clientIp(request));
  }

  /** Historial de un dispositivo (queda auditado). */
  @Get("devices/:id/history")
  history(
    @Param("id") id: string,
    @Query(new ZodValidationPipe(adminHistoryQuerySchema))
    query: AdminHistoryQuery,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<PublicLocation[]> {
    return this.admin.history(id, query, user.id, clientIp(request));
  }

  /** Revoca las sesiones de comparticion activas del dispositivo. */
  @Post("devices/:id/revoke")
  @HttpCode(HttpStatus.OK)
  revoke(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(adminRevokeSchema)) input: AdminRevokeInput,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ revoked: number }> {
    return this.admin.revokeAccess(
      id,
      input.reason,
      user.id,
      clientIp(request),
    );
  }

  /** Desvincula (elimina) el dispositivo de la plataforma. */
  @Delete("devices/:id")
  unlink(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ success: true }> {
    return this.admin.unlinkDevice(id, user.id, clientIp(request));
  }

  /** Feed de eventos de seguridad (auditoria administrativa). */
  @Get("audit")
  audit(
    @Query(new ZodValidationPipe(adminAuditQuerySchema))
    query: {
      action?: string;
      limit: number;
    },
  ): Promise<AdminAuditEntry[]> {
    return this.admin.listAudit(query);
  }
}
