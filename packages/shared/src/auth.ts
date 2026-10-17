import { z } from "zod";
import type { UserRole } from "./enums";

/** Politica minima de contrasena exigida por el backend. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Reglas de complejidad: al menos una minuscula, una mayuscula y un digito.
 * Se documentan en `docs/privacidad.md` como medida de seguridad.
 */
const passwordSchema = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `La contrasena debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`,
  )
  .max(
    PASSWORD_MAX_LENGTH,
    `La contrasena no puede superar ${PASSWORD_MAX_LENGTH} caracteres`,
  )
  .regex(/[a-z]/, "La contrasena debe incluir al menos una letra minuscula")
  .regex(/[A-Z]/, "La contrasena debe incluir al menos una letra mayuscula")
  .regex(/[0-9]/, "La contrasena debe incluir al menos un numero");

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("El correo electronico no es valido")
  .max(255, "El correo electronico es demasiado largo");

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "La contrasena es obligatoria"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, "El token de refresco es obligatorio"),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

/** Usuario tal como se expone al cliente (nunca incluye el hash de contrasena). */
export interface PublicUser {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResponse extends AuthTokens {
  user: PublicUser;
}

/** Contenido del access token JWT. */
export interface AccessTokenPayload {
  sub: string;
  email: string;
  /**
   * Rol del usuario. Los tokens emitidos antes de introducir los roles no lo
   * incluyen: el backend los interpreta como `USER`.
   */
  role?: UserRole;
  type: "access";
}

/** Contenido del refresh token JWT. */
export interface RefreshTokenPayload {
  sub: string;
  type: "refresh";
  /** Identificador de sesion que permite revocar tokens individualmente. */
  sid: string;
}
