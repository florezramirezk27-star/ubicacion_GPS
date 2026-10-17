import type { Request } from "express";

/** Extrae el token de `Authorization: Bearer <token>`. */
export function extractBearerToken(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token.trim() || null;
}

/** Cabecera usada por el dispositivo movil para enviar su token de comparticion. */
export const SHARE_TOKEN_HEADER = "x-share-token";

export function extractShareToken(request: Request): string | null {
  const raw = request.headers[SHARE_TOKEN_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || null;
}

/** IP de origen de la peticion (respetando proxies delante de la API). */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return request.ip ?? null;
}
