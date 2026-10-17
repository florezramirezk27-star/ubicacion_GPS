import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Reflector } from "@nestjs/core";
import type { AccessTokenPayload } from "@geo/shared";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { extractBearerToken } from "../http.util";
import type { AuthenticatedRequest } from "../types";

/**
 * Guard global de autenticacion por JWT (Bearer token).
 *
 * - Deja pasar las rutas marcadas con `@Public()`.
 * - Ignora contextos WebSocket: el gateway valida su propio handshake.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException("Falta el token de acceso");
    }

    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.getOrThrow<string>("JWT_ACCESS_SECRET"),
      });
      if (payload.type !== "access") {
        throw new UnauthorizedException("Tipo de token incorrecto");
      }
      request.user = {
        id: payload.sub,
        email: payload.email,
        // Los tokens antiguos (sin rol) se tratan como usuario normal.
        role: payload.role ?? "USER",
      };
      return true;
    } catch {
      throw new UnauthorizedException("Token de acceso invalido o expirado");
    }
  }
}
