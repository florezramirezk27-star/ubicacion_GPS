import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { extractShareToken } from "../common/http.util";
import type { AuthenticatedRequest } from "../common/types";
import { LocationSharesService } from "./location-shares.service";

/**
 * Autoriza la ingesta de coordenadas mediante el token de comparticion
 * (`X-Share-Token`). Este token lo entrega la API una sola vez al iniciar
 * la sesion y solo es valido mientras la sesion siga ACTIVE y no expire.
 *
 * Es intencionadamente independiente del JWT de usuario: asi el dispositivo
 * puede enviar coordenadas sin manejar las credenciales de la cuenta.
 */
@Injectable()
export class ShareTokenGuard implements CanActivate {
  constructor(private readonly shares: LocationSharesService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractShareToken(request);
    if (!token) {
      throw new UnauthorizedException("Falta la cabecera X-Share-Token");
    }

    const share = await this.shares.findUsableByToken(token);
    if (!share) {
      throw new UnauthorizedException("Token de comparticion invalido");
    }

    if (share.status !== "ACTIVE") {
      throw new ForbiddenException(
        `La sesion de comparticion no esta activa (estado: ${share.status})`,
      );
    }

    request.share = { id: share.id, deviceId: share.deviceId };
    return true;
  }
}
