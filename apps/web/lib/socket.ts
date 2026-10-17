import type { PublicLocation, PublicRemoteAccessRequest } from "@geo/shared";
import { API_URL, getSession } from "./api";

/** Eventos que emite el backend por WebSocket. */
export interface LiveDeviceStatusEvent {
  deviceId: string;
  status: "CONNECTED" | "STALE" | "OFFLINE";
  at: string;
}

export interface LiveErrorEvent {
  message: string;
}

/**
 * Conexion Socket.IO con la API.
 *
 * El access token viaja en el handshake (`auth.token`) y el servidor lo valida
 * antes de aceptar la conexion. Despues hay que suscribirse a cada dispositivo
 * con `subscribe:device`; el servidor comprueba la propiedad antes de unirnos
 * a su sala.
 */
export interface LiveConnection {
  subscribeDevice: (deviceId: string) => void;
  unsubscribeDevice: (deviceId: string) => void;
  disconnect: () => void;
}

export type LiveHandlers = {
  onLocation: (location: PublicLocation) => void;
  onStatus: (event: LiveDeviceStatusEvent) => void;
  onError?: (event: LiveErrorEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
};

export async function connectLive(
  handlers: LiveHandlers,
): Promise<LiveConnection> {
  const { io } = await import("socket.io-client");
  const session = getSession();

  const socket = io(API_URL, {
    transports: ["websocket", "polling"],
    auth: { token: session?.accessToken ?? "" },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  socket.on("connect", () => handlers.onConnected?.());
  socket.on("disconnect", (reason: string) =>
    handlers.onDisconnected?.(reason),
  );
  socket.on("live:ready", () => handlers.onConnected?.());
  socket.on("live:error", (event: LiveErrorEvent) => handlers.onError?.(event));
  socket.on("location:update", (location: PublicLocation) =>
    handlers.onLocation(location),
  );
  socket.on("device:status", (event: LiveDeviceStatusEvent) =>
    handlers.onStatus(event),
  );

  return {
    subscribeDevice: (deviceId: string) =>
      socket.emit("subscribe:device", { deviceId }),
    unsubscribeDevice: (deviceId: string) =>
      socket.emit("unsubscribe:device", { deviceId }),
    disconnect: () => socket.disconnect(),
  };
}

// ---------------------------------------------------------------------------
// Canal del panel de Superadministrador (namespace /admin)
// ---------------------------------------------------------------------------

export interface AdminReadyEvent {
  userId: string;
  email: string;
}

export interface AdminDeviceStatusEvent {
  deviceId: string;
  status: string;
  at: string;
}

export interface AdminDeviceChangeEvent {
  deviceId: string;
  kind: "device.updated" | "device.removed" | "share.changed";
  at: string;
  [key: string]: unknown;
}

export interface AdminConnection {
  disconnect: () => void;
}

export type AdminHandlers = {
  /** El servidor acepto la conexion y confirmo el rol SUPERADMIN. */
  onReady?: (event: AdminReadyEvent) => void;
  onLocation?: (location: PublicLocation) => void;
  onStatus?: (event: AdminDeviceStatusEvent) => void;
  onChange?: (event: AdminDeviceChangeEvent) => void;
  /**
   * Nueva solicitud de acceso a camara/microfono, o cambio de su estado.
   * La captura NO empieza aqui: el dispositivo solo emite tras el
   * consentimiento explicito de la persona.
   */
  onRemoteRequest?: (request: PublicRemoteAccessRequest) => void;
  /** La sesion de medios de una solicitud se inicio o se cerro. */
  onMediaSession?: (request: PublicRemoteAccessRequest) => void;
  onError?: (event: LiveErrorEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
};

/**
 * Conexion al namespace `/admin`.
 *
 * El backend valida el access token y **vuelve a comprobar el rol contra la
 * base de datos** antes de aceptar la conexion. Si el token es invalido o el
 * usuario no es SUPERADMIN, el servidor emite `admin:error` y cierra la
 * conexion; en ese caso se llama a `onError`.
 */
export async function connectAdmin(
  handlers: AdminHandlers,
): Promise<AdminConnection> {
  const { io } = await import("socket.io-client");
  const session = getSession();

  const socket = io(`${API_URL}/admin`, {
    transports: ["websocket", "polling"],
    auth: { token: session?.accessToken ?? "" },
    reconnection: true,
    reconnectionDelay: 1500,
    reconnectionDelayMax: 8000,
  });

  socket.on("connect", () => handlers.onConnected?.());
  socket.on("disconnect", (reason: string) =>
    handlers.onDisconnected?.(reason),
  );
  socket.on("admin:ready", (event: AdminReadyEvent) =>
    handlers.onReady?.(event),
  );
  socket.on("admin:error", (event: LiveErrorEvent) =>
    handlers.onError?.(event),
  );
  socket.on("admin:location", (location: PublicLocation) =>
    handlers.onLocation?.(location),
  );
  socket.on("admin:remote-request", (request: PublicRemoteAccessRequest) =>
    handlers.onRemoteRequest?.(request),
  );
  socket.on("admin:media-session", (request: PublicRemoteAccessRequest) =>
    handlers.onMediaSession?.(request),
  );
  socket.on("admin:device-status", (event: AdminDeviceStatusEvent) =>
    handlers.onStatus?.(event),
  );
  socket.on("admin:device-change", (event: AdminDeviceChangeEvent) =>
    handlers.onChange?.(event),
  );

  return { disconnect: () => socket.disconnect() };
}
