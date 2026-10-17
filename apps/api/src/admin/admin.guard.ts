import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { AuthenticatedRequest } from "../common/types";

/**
 * Exige el rol SUPERADMIN.
 *
 * Se aplica a nivel de controlador en el modulo de administracion. El guard
 * global de JWT ya ha validado el token y adjuntado `request.user`; aqui solo
 * se comprueba el privilegio. Si el usuario esta autenticado pero no es
 * administrador se responde 403 (no 404): la existencia del panel es publica,
 * lo que se oculta es su contenido.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.user?.role === "SUPERADMIN") return true;
    throw new ForbiddenException("Se requiere el rol SUPERADMIN");
  }
}
