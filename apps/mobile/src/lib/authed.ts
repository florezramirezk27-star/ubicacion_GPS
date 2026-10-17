import { ApiError, api } from "./api";
import { persistSession, type StoredSession } from "./session";

/**
 * Ejecuta una llamada autenticada renovando el token si el servidor responde 401.
 *
 * El token de acceso dura poco (unos 15 minutos). En lugar de obligar al usuario
 * a volver a escribir la contrasena, se usa el refresh token (de un solo uso, con
 * rotacion) para obtener un par nuevo y se reintenta la llamada una sola vez.
 *
 * @param session    Sesion vigente en memoria.
 * @param onRefresh  Se invoca con la sesion nueva para que la app la conserve.
 * @param operation  Llamada que recibe el token de acceso valido.
 */
export async function authed<T>(
  session: StoredSession,
  onRefresh: (next: StoredSession) => void,
  operation: (accessToken: string) => Promise<T>,
): Promise<T> {
  try {
    return await operation(session.accessToken);
  } catch (error) {
    const isUnauthorized = error instanceof ApiError && error.status === 401;
    if (!isUnauthorized) throw error;

    // Renovacion: si falla, se propaga el error original para no confundir.
    let refreshed;
    try {
      refreshed = await api.refresh(session.refreshToken);
    } catch {
      throw error;
    }

    const next: StoredSession = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      user: refreshed.user,
    };

    await persistSession(next);
    onRefresh(next);

    return operation(next.accessToken);
  }
}
