import type { UserRole } from "@geo/shared";
import type { Request } from "express";

/** Usuario autenticado adjunto a la peticion por el JwtAuthGuard. */
export interface AuthenticatedUser {
  id: string;
  email: string;
  /**
   * Rol del usuario. Los tokens emitidos antes de introducir los roles no lo
   * incluyen; en ese caso el guard asigna `USER` por defecto (nunca eleva
   * privilegios a partir de un token antiguo).
   */
  role: UserRole;
}

/** Sesion de comparticion adjunta por el ShareTokenGuard. */
export interface AuthenticatedShare {
  id: string;
  deviceId: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  share?: AuthenticatedShare;
}
