import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/**
 * Marca una ruta como publica. El JwtAuthGuard global la deja pasar
 * sin exigir un token de acceso (registro, login, salud).
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
