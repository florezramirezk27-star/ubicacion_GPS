import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  REMOTE_POLL_INTERVAL_MS,
  type PublicMediaSession,
  type PublicRemoteAccessRequest,
} from "@geo/shared";
import { ApiError, api, getApiBaseUrl } from "../lib/api";
import { authed } from "../lib/authed";
import {
  startMediaSession,
  type MediaSessionHandle,
} from "../lib/media-session";
import {
  ensureMediaPermissions,
  readMediaPermissions,
  type MediaPermissionsSnapshot,
} from "../lib/permissions";
import {
  dismissRemoteRequestNotification,
  notifyRemoteRequest,
  subscribeToRemoteRequestTaps,
} from "../lib/remote-notify";
import type { StoredSession } from "../lib/session";

/**
 * Acceso remoto a camara y microfono (lado del dispositivo).
 *
 * Reglas que implementa este hook, en el mismo orden en que importan:
 *
 *  1. **Nada ocurre sin aceptacion explicita.** El sondeo solo *descubre*
 *     solicitudes; abrir la camara es consecuencia de que la persona pulse
 *     "Permitir" en la pantalla. No hay camino alternativo.
 *  2. **Los permisos del sistema se piden una sola vez** (`ensureMediaPermissions`
 *     respeta el recuerdo de `tracking-store`). Si estan revocados, se avisa y
 *     se ofrece abrir los ajustes; no se insiste en bucle.
 *  3. **La sesion se puede cortar en cualquier momento** desde el propio
 *     dispositivo, y cortarla cierra la sesion en el servidor (queda auditado).
 *  4. **Limite conocido y documentado**: con la app cerrada no hay entrega. El
 *     sondeo vive en la app; el servidor no empuja nada al telefono.
 */
export interface RemoteAccessController {
  /** Solicitudes esperando respuesta (caducan solas). */
  pending: PublicRemoteAccessRequest[];
  /** Sesiones aceptadas que el servidor considera activas. */
  active: PublicRemoteAccessRequest[];
  /** Ids de sesion que estan emitiendo ahora mismo desde este telefono. */
  broadcasting: string[];
  /** Estado WebRTC por sesion, para el indicador visible. */
  connectionStates: Record<string, string>;
  /** Estado de los permisos de camara/microfono. */
  permissions: MediaPermissionsSnapshot | null;
  /** Error legible pendiente de mostrar. */
  error: string | null;
  /** Solicitud que se esta respondiendo (para desactivar botones). */
  busyRequestId: string | null;
  /** Acepta o rechaza una solicitud. `accept` abre camara/microfono. */
  respond(
    request: PublicRemoteAccessRequest,
    accept: boolean,
  ): Promise<void>;
  /** Reanuda la emision de una sesion ya aceptada (por ejemplo tras reiniciar). */
  resume(request: PublicRemoteAccessRequest): Promise<void>;
  /** Corta la emision y cierra la sesion en el servidor. */
  stop(sessionId: string, reason?: string): Promise<void>;
  /** Limpia el error visible. */
  clearError(): void;
}

/** Mensaje legible de un fallo de la API. */
function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return "La solicitud ya no esta disponible: pudo caducar o resolverse en otro dispositivo.";
    }
    if (error.status === 403) {
      return "Solo un administrador puede gestionar este acceso, o la sesion ya no es valida.";
    }
    return error.message || "No se pudo completar la operacion.";
  }
  return "No se pudo contactar con el servidor.";
}

export function useRemoteAccess(
  session: StoredSession | null,
  onSessionRefreshed: (next: StoredSession) => void,
): RemoteAccessController {
  const [pending, setPending] = useState<PublicRemoteAccessRequest[]>([]);
  const [active, setActive] = useState<PublicRemoteAccessRequest[]>([]);
  const [broadcasting, setBroadcasting] = useState<string[]>([]);
  const [connectionStates, setConnectionStates] = useState<
    Record<string, string>
  >({});
  const [permissions, setPermissions] =
    useState<MediaPermissionsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);

  const mountedRef = useRef(false);
  const sessionRef = useRef<StoredSession | null>(session);
  const refreshRef = useRef(onSessionRefreshed);
  const busyRef = useRef(false);
  /** Sesiones de medios vivas en este telefono, por id de sesion. */
  const handlesRef = useRef<Map<string, MediaSessionHandle>>(new Map());
  /** Solicitudes ya notificadas: evita repetir el aviso local cada 8 s. */
  const notifiedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    refreshRef.current = onSessionRefreshed;
  }, [onSessionRefreshed]);

  /** Llamada autenticada con renovacion de token (una sola a la vez). */
  const withAuth = useCallback(
    <T,>(operation: (accessToken: string) => Promise<T>): Promise<T> => {
      const current = sessionRef.current;
      if (!current) {
        return Promise.reject(new Error("No hay sesion iniciada."));
      }
      return authed(current, refreshRef.current, operation);
    },
    [],
  );

  const refreshPermissions = useCallback(async () => {
    const snapshot = await readMediaPermissions();
    if (mountedRef.current) setPermissions(snapshot);
  }, []);

  /**
   * Abre el flujo de medios para una sesion ya aceptada.
   *
   * Solo se llama despues de que la persona haya aceptado (o de que pulse
   * "Reanudar" tras reiniciar la app). Si falla, se cierra la sesion en el
   * servidor para no dejarla colgada.
   */
  const beginBroadcast = useCallback(
    async (
      request: PublicRemoteAccessRequest,
      mediaSession: PublicMediaSession,
    ): Promise<void> => {
      const current = sessionRef.current;
      if (!current) return;

      try {
        const handle = await startMediaSession({
          sessionId: mediaSession.id,
          sensor: request.sensor,
          accessToken: current.accessToken,
          apiUrl: getApiBaseUrl(),
          onEnded: () => {
            handlesRef.current.delete(mediaSession.id);
            if (mountedRef.current) {
              setBroadcasting(Array.from(handlesRef.current.keys()));
            }
            // La sesion ya se cerro (o se cerrara) en el servidor: se refresca
            // el estado para que la insignia desaparezca.
            void refreshPermissions();
          },
          onError: (message) => {
            if (mountedRef.current) setError(message);
          },
        });

        handlesRef.current.set(mediaSession.id, handle);
        if (mountedRef.current) {
          setBroadcasting(Array.from(handlesRef.current.keys()));
        }
      } catch {
        if (mountedRef.current) {
          setError(
            "No se pudo abrir la camara o el microfono del dispositivo. Comprueba que no los este usando otra aplicacion.",
          );
        }
        try {
          await withAuth((token) =>
            api.endMediaSession(
              token,
              mediaSession.id,
              "No se pudo abrir la camara en el dispositivo",
            ),
          );
        } catch {
          /* el servidor la cerrara por caducidad */
        }
      }
    },
    [refreshPermissions, withAuth],
  );

  /** Descubre solicitudes y sesiones activas. Es el unico origen de verdad. */
  const poll = useCallback(async () => {
    if (!sessionRef.current) return;

    try {
      // En serie a proposito: el refresh token rota y dos renovaciones
      // simultaneas invalidarian la sesion.
      const pendingRequests = await withAuth((token) =>
        api.pendingRemoteAccess(token),
      );
      const activeRequests = await withAuth((token) =>
        api.activeMediaSessions(token),
      );
      if (!mountedRef.current) return;

      setPending(pendingRequests);

      // Aviso local: una vez por solicitud, nunca activa nada.
      for (const request of pendingRequests) {
        if (notifiedRef.current.has(request.id)) continue;
        notifiedRef.current.add(request.id);
        void notifyRemoteRequest(request);
      }

      setActive(activeRequests);

      // Si el servidor ya no la considera activa (caducada o cerrada desde el
      // visor), se corta aqui tambien: no se deja la camara encendida.
      const activeSessionIds = new Set(
        activeRequests
          .map((request) => request.session?.id)
          .filter((value): value is string => Boolean(value)),
      );
      for (const [sessionId, handle] of Array.from(
        handlesRef.current.entries(),
      )) {
        if (activeSessionIds.has(sessionId)) continue;
        handle.stop("La sesion ya no esta activa");
        handlesRef.current.delete(sessionId);
      }
      setBroadcasting(Array.from(handlesRef.current.keys()));
    } catch {
      // Sondeo silencioso: sin red se reintenta en el siguiente ciclo. No se
      // muestra error para no ensuciar la pantalla cada 8 segundos.
    }
  }, [withAuth]);

  // Sondeo periodico mientras la app esta abierta.
  useEffect(() => {
    mountedRef.current = true;

    if (!session) {
      setPending([]);
      setActive([]);
      return () => {
        mountedRef.current = false;
      };
    }

    void poll();
    void refreshPermissions();

    const interval = setInterval(() => {
      void poll();
    }, REMOTE_POLL_INTERVAL_MS);

    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") void poll();
    });

    const unsubscribeTaps = subscribeToRemoteRequestTaps(() => {
      void poll();
    });

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      appState.remove();
      unsubscribeTaps();
    };
  }, [session, poll, refreshPermissions]);

  // Al cerrar sesion (o desmontar) no se deja la camara encendida.
  useEffect(() => {
    return () => {
      for (const handle of Array.from(handlesRef.current.values())) {
        handle.stop("La aplicacion se cerro");
      }
      handlesRef.current.clear();
    };
  }, [session]);

  // Estado de conexion para el indicador visible.
  useEffect(() => {
    if (broadcasting.length === 0) {
      setConnectionStates({});
      return;
    }

    const update = () => {
      const next: Record<string, string> = {};
      for (const [sessionId, handle] of Array.from(
        handlesRef.current.entries(),
      )) {
        next[sessionId] = handle.connectionState();
      }
      setConnectionStates(next);
    };

    update();
    const timer = setInterval(update, 2_000);
    return () => clearInterval(timer);
  }, [broadcasting]);

  const respond = useCallback(
    async (
      request: PublicRemoteAccessRequest,
      accept: boolean,
    ): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusyRequestId(request.id);
      setError(null);

      try {
        if (accept) {
          // Los permisos del sistema se resuelven ANTES de decirle al servidor
          // que si. Si el sistema los bloquea, se rechaza de forma explicita y
          // honesta en lugar de dejar una sesion aceptada que nunca emitira.
          const result = await ensureMediaPermissions(request.sensor);
          await refreshPermissions();

          if (!result.ok) {
            try {
              await withAuth((token) =>
                api.respondRemoteAccess(token, request.id, false),
              );
            } catch {
              /* si falla, la solicitud caduca sola */
            }
            setPending((previous) =>
              previous.filter((item) => item.id !== request.id),
            );
            void dismissRemoteRequestNotification(request.id);
            setError(
              result.message ??
                "No se concedieron los permisos de camara o microfono.",
            );
            return;
          }
        }

        const response = await withAuth((token) =>
          api.respondRemoteAccess(token, request.id, accept),
        );
        void dismissRemoteRequestNotification(request.id);

        setPending((previous) =>
          previous.filter((item) => item.id !== request.id),
        );

        if (!accept) {
          void poll();
          return;
        }

        if (!response.session) {
          setError(
            "El servidor no devolvio la sesion de medios. Intentalo de nuevo.",
          );
          void poll();
          return;
        }

        await beginBroadcast(request, response.session);
        void poll();
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusyRequestId(null);
      }
    },
    [beginBroadcast, poll, refreshPermissions, withAuth],
  );

  const resume = useCallback(
    async (request: PublicRemoteAccessRequest): Promise<void> => {
      if (!request.session) return;
      if (handlesRef.current.has(request.session.id)) return;

      // Reanudar tambien exige permiso vigente: nunca se abre en silencio.
      const result = await ensureMediaPermissions(request.sensor);
      await refreshPermissions();
      if (!result.ok) {
        setError(
          result.message ??
            "No se concedieron los permisos de camara o microfono.",
        );
        return;
      }
      await beginBroadcast(request, request.session);
    },
    [beginBroadcast, refreshPermissions],
  );

  const stop = useCallback(
    async (sessionId: string, reason?: string): Promise<void> => {
      const handle = handlesRef.current.get(sessionId);
      if (handle) {
        handle.stop(reason);
        handlesRef.current.delete(sessionId);
      }
      setBroadcasting(Array.from(handlesRef.current.keys()));

      try {
        await withAuth((token) =>
          api.endMediaSession(token, sessionId, reason),
        );
      } catch {
        // Si no hay red, la sesion caduca en el servidor; el flujo local ya se
        // ha cortado, que es lo que protege la privacidad ahora mismo.
      }

      void poll();
    },
    [poll, withAuth],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    pending,
    active,
    broadcasting,
    connectionStates,
    permissions,
    error,
    busyRequestId,
    respond,
    resume,
    stop,
    clearError,
  };
}
