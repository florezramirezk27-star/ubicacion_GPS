import type {
  AuthResponse,
  CreatedLocationShare,
  CreateDeviceInput,
  DeviceLocationSummary,
  IngestLocationInput,
  PublicDevice,
  PublicLocation,
  PublicMediaSession,
  PublicRemoteAccessRequest,
  PublicUser,
} from "@geo/shared";
import { resolveDefaultApiUrl } from "../config";

/** Error con el codigo HTTP, para poder distinguir 401 de un fallo de red. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Error de red (sin respuesta del servidor): hay que reintentar mas tarde. */
export class NetworkError extends Error {
  constructor(message = "No hay conexion con el servidor") {
    super(message);
    this.name = "NetworkError";
  }
}

let baseUrl = resolveDefaultApiUrl();

export function setApiBaseUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, "");
}

export function getApiBaseUrl(): string {
  return baseUrl;
}

/** Tiempo maximo por peticion: evita que el bucle de envio se quede colgado. */
const REQUEST_TIMEOUT_MS = 15_000;

function extractMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim()) return payload;
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string") return message;
    if (Array.isArray(message) && typeof message[0] === "string")
      return message[0];
  }
  return fallback;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  token?: string | null;
  shareToken?: string | null;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = "GET", body, token, shareToken } = options;

  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (shareToken) headers["X-Share-Token"] = shareToken;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new NetworkError();
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      extractMessage(payload, `Error ${response.status}`),
    );
  }

  return payload as T;
}

export const api = {
  // ------------------------------- Sesion -------------------------------
  login: (email: string, password: string) =>
    request<AuthResponse>("/auth/login", {
      method: "POST",
      body: { email, password },
    }),

  register: (email: string, password: string) =>
    request<AuthResponse>("/auth/register", {
      method: "POST",
      body: { email, password },
    }),

  me: (token: string) => request<PublicUser>("/auth/me", { token }),

  refresh: (refreshToken: string) =>
    request<AuthResponse>("/auth/refresh", {
      method: "POST",
      body: { refreshToken },
    }),

  logout: (refreshToken: string) =>
    request<{ success: true }>("/auth/logout", {
      method: "POST",
      body: { refreshToken },
    }),

  // ----------------------------- Dispositivos -----------------------------
  listDevices: (token: string) =>
    request<PublicDevice[]>("/devices", { token }),

  createDevice: (token: string, input: CreateDeviceInput) =>
    request<PublicDevice>("/devices", { method: "POST", token, body: input }),

  // ------------------------ Sesiones de comparticion ----------------------
  startShare: (token: string, deviceId: string, expiresInMinutes: number) =>
    request<CreatedLocationShare>("/shares", {
      method: "POST",
      token,
      body: { deviceId, expiresInMinutes },
    }),

  stopShare: (token: string, shareId: string, reason: string) =>
    request<unknown>(`/shares/${shareId}/stop`, {
      method: "POST",
      token,
      body: { reason },
    }),

  // ------------------------------ Ubicaciones -----------------------------
  /** Ingesta de una coordenada. Se autentica con el token de comparticion. */
  ingestLocation: (shareToken: string, input: IngestLocationInput) =>
    request<PublicLocation>("/locations", {
      method: "POST",
      shareToken,
      body: input,
    }),

  latest: (token: string, deviceId: string) =>
    request<DeviceLocationSummary>(
      `/locations/latest?deviceId=${encodeURIComponent(deviceId)}`,
      {
        token,
      },
    ),

  // ---------------------------- Acceso remoto -----------------------------
  //
  // Solo el usuario (dueno del dispositivo) puede aceptar o rechazar. La app
  // nunca activa camara ni microfono por si sola: esto solo pinta la solicitud.
  pendingRemoteAccess: (token: string) =>
    request<PublicRemoteAccessRequest[]>("/remote-access/pending", { token }),

  respondRemoteAccess: (token: string, requestId: string, accept: boolean) =>
    request<{
      request: PublicRemoteAccessRequest;
      session: PublicMediaSession | null;
    }>(`/remote-access/${requestId}/respond`, {
      method: "POST",
      token,
      body: { accept },
    }),

  activeMediaSessions: (token: string) =>
    request<PublicRemoteAccessRequest[]>("/remote-access/sessions/active", {
      token,
    }),

  endMediaSession: (token: string, sessionId: string, reason?: string) =>
    request<PublicRemoteAccessRequest>(
      `/remote-access/sessions/${sessionId}/end`,
      {
        method: "POST",
        token,
        body: reason ? { reason } : {},
      },
    ),
};
