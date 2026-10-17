import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  loginSchema,
  refreshSchema,
  registerSchema,
  type AuthResponse,
  type LoginInput,
  type PublicUser,
  type RegisterInput,
} from "@geo/shared";
import { AuditService, type AuditLogEntry } from "../audit/audit.service";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Public } from "../common/decorators/public.decorator";
import { clientIp } from "../common/http.util";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { AuthenticatedRequest, AuthenticatedUser } from "../common/types";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Post("register")
  register(
    @Body(new ZodValidationPipe(registerSchema)) input: RegisterInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<AuthResponse> {
    return this.auth.register(input, clientIp(request));
  }

  /** Inicia sesion. Devuelve 200: es una accion, no la creacion de un recurso. */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post("login")
  login(
    @Body(new ZodValidationPipe(loginSchema)) input: LoginInput,
    @Headers("user-agent") userAgent: string | undefined,
    @Req() request: AuthenticatedRequest,
  ): Promise<AuthResponse> {
    return this.auth.login(input, userAgent ?? null, clientIp(request));
  }

  /** Rota el refresh token. Devuelve 200 (accion, no creacion). */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post("refresh")
  refresh(
    @Body(new ZodValidationPipe(refreshSchema)) input: { refreshToken: string },
  ): Promise<AuthResponse> {
    return this.auth.refresh(input.refreshToken);
  }

  /** Cierra la sesion indicada (idempotente). Devuelve 200. */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post("logout")
  logout(
    @Body(new ZodValidationPipe(refreshSchema)) input: { refreshToken: string },
  ): Promise<{ success: true }> {
    return this.auth.logout(input.refreshToken);
  }

  @Get("me")
  me(@CurrentUser() user: AuthenticatedUser): Promise<PublicUser> {
    return this.auth.me(user.id);
  }

  /** Cierra todas las sesiones activas del usuario autenticado. Devuelve 200. */
  @HttpCode(HttpStatus.OK)
  @Post("logout-all")
  logoutAll(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ revoked: number }> {
    return this.auth.revokeAllSessions(user.id);
  }

  /** Consulta los eventos de auditoria del propio usuario. */
  @Get("audit")
  auditLog(
    @CurrentUser() user: AuthenticatedUser,
    @Query("limit") limit?: string,
  ): Promise<AuditLogEntry[]> {
    const parsed = Number(limit);
    const safeLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
    return this.audit.listForActor(user.id, safeLimit);
  }
}
