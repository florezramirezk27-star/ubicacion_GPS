import type {
  AdminAuditEntry,
  AdminDevice,
  AdminDeviceDetail,
  AdminDeviceQuery,
  AdminOverview,
  AuthResponse,
  CreatedLocationShare,
  CreateDeviceInput,
  CreateRemoteAccessRequestInput,
  DeviceLocationSummary,
  HistoryQueryInput,
  PublicDevice,
  PublicLocation,
  PublicLocationShare,
  PublicMediaSession,
  PublicRemoteAccessRequest,
  PublicUser,
  RemoteAccessListQuery,
} from "@geo/shared";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** Resultado de /locations/nearby: una ubicacion con su distancia al punto consultado. */
export interface NearbyLocation extends PublicLocation {
  distanceMeters: number;
}

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Almacenamiento de sesion
// ---------------------------------------------------------------------------
//
// En esta version los tokens se guardan en localStorage para simplificar la
// demo. En un despliegue real de produccion el panel deberia usar cookies
// httpOnly + Secure + SameSite (ver docs/seguridad.md).

const STORAGE_KEY = "geolocalizador.session";

let currentSession: StoredSession | null = null;
let loaded = false;
const listeners = new Set<(session: StoredSession | null) => void>();

function readFromStorage(): StoredSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.accessToken || !parsed?.refreshToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getSession(): StoredSession | null {
  if (!loaded) {
    currentSession = readFromStorage();
    loaded = true;
  }
  return currentSession;
}

export function setSession(session: StoredSession | null): void {
  currentSession = session;
  loaded = true;
  if (typeof window !== "undefined") {
    if (session) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }
  listeners.forEach((listener) => listener(session));
}

export function subscribeSession(
  listener: (session: StoredSession | null) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Cliente HTTP con renovacion automatica de token
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Si es false, la peticion no adjunta el token de acceso. */
  authenticated?: boolean;
  /** Token de comparticion para la ingesta de coordenadas. */
  shareToken?: string;
  retryOn401?: boolean;
}

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

async function tryRefresh(refreshToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) {
      setSession(null);
      return false;
    }
    const data = (await response.json()) as AuthResponse;
    setSession({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      user: data.user,
    });
    return true;
  } catch {
    setSession(null);
    return false;
  }
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    method = "GET",
    body,
    authenticated = true,
    shareToken,
    retryOn401 = true,
  } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (shareToken) headers["X-Share-Token"] = shareToken;

  const session = getSession();
  if (authenticated && session) {
    headers.Authorization = `Bearer ${session.accessToken}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (
    response.status === 401 &&
    authenticated &&
    retryOn401 &&
    session?.refreshToken
  ) {
    const refreshed = await tryRefresh(session.refreshToken);
    if (refreshed) {
      return request<T>(path, { ...options, retryOn401: false });
    }
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
      extractMessage(payload, response.statusText || "Error de red"),
      payload,
    );
  }

  return payload as T;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const api = {
  // Autenticacion ---------------------------------------------------------
  async register(email: string, password: string): Promise<AuthResponse> {
    return request<AuthResponse>("/auth/register", {
      method: "POST",
      body: { email, password },
      authenticated: false,
    });
  },

  async login(email: string, password: string): Promise<AuthResponse> {
    return request<AuthResponse>("/auth/login", {
      method: "POST",
      body: { email, password },
      authenticated: false,
    });
  },

  async logout(refreshToken: string): Promise<void> {
    await request("/auth/logout", {
      method: "POST",
      body: { refreshToken },
      authenticated: false,
    });
  },

  async me(): Promise<PublicUser> {
    return request<PublicUser>("/auth/me");
  },

  // Dispositivos ----------------------------------------------------------
  async listDevices(): Promise<PublicDevice[]> {
    return request<PublicDevice[]>("/devices");
  },

  async createDevice(input: CreateDeviceInput): Promise<PublicDevice> {
    return request<PublicDevice>("/devices", { method: "POST", body: input });
  },

  async deleteDevice(deviceId: string): Promise<{ success: true }> {
    return request<{ success: true }>(`/devices/${deviceId}`, {
      method: "DELETE",
    });
  },

  // Sesiones de comparticion ---------------------------------------------
  async listShares(deviceId: string): Promise<PublicLocationShare[]> {
    return request<PublicLocationShare[]>(
      `/shares?deviceId=${encodeURIComponent(deviceId)}`,
    );
  },

  async startShare(
    deviceId: string,
    expiresInMinutes: number,
  ): Promise<CreatedLocationShare> {
    return request<CreatedLocationShare>("/shares", {
      method: "POST",
      body: { deviceId, expiresInMinutes },
    });
  },

  async stopShare(
    shareId: string,
    reason?: string,
  ): Promise<PublicLocationShare> {
    return request<PublicLocationShare>(`/shares/${shareId}/stop`, {
      method: "POST",
      body: { reason },
    });
  },

  async revokeShare(
    shareId: string,
    reason?: string,
  ): Promise<PublicLocationShare> {
    return request<PublicLocationShare>(`/shares/${shareId}/revoke`, {
      method: "POST",
      body: { reason },
    });
  },

  // Ubicaciones -----------------------------------------------------------
  async summaries(): Promise<DeviceLocationSummary[]> {
    return request<DeviceLocationSummary[]>("/locations/summaries");
  },

  async latest(deviceId: string): Promise<DeviceLocationSummary> {
    return request<DeviceLocationSummary>(
      `/locations/latest?deviceId=${encodeURIComponent(deviceId)}`,
    );
  },

  async history(query: HistoryQueryInput): Promise<PublicLocation[]> {
    const params = new URLSearchParams({
      deviceId: query.deviceId,
      limit: String(query.limit),
    });
    if (query.from) params.set("from", query.from);
    if (query.to) params.set("to", query.to);
    return request<PublicLocation[]>(`/locations/history?${params.toString()}`);
  },

  async nearby(params: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
    limit?: number;
  }): Promise<NearbyLocation[]> {
    const search = new URLSearchParams({
      latitude: String(params.latitude),
      longitude: String(params.longitude),
      radiusMeters: String(params.radiusMeters),
    });
    if (params.limit) search.set("limit", String(params.limit));
    return request<NearbyLocation[]>(`/locations/nearby?${search.toString()}`);
  },

  // Panel de Superadministrador -------------------------------------------
  // Todas estas rutas exigen el rol SUPERADMIN en el backend; el 403 se
  // propaga como ApiError y el panel lo muestra sin romper la sesion.
  async adminOverview(): Promise<AdminOverview> {
    return request<AdminOverview>("/admin/overview");
  },

  async adminDevices(
    query: Partial<AdminDeviceQuery> = {},
  ): Promise<AdminDevice[]> {
    const params = new URLSearchParams();
    if (query.platform) params.set("platform", query.platform);
    if (query.status) params.set("status", query.status);
    if (query.q) params.set("q", query.q);
    if (query.userId) params.set("userId", query.userId);
    params.set("limit", String(query.limit ?? 200));
    return request<AdminDevice[]>(`/admin/devices?${params.toString()}`);
  },

  async adminDevice(deviceId: string): Promise<AdminDeviceDetail> {
    return request<AdminDeviceDetail>(
      `/admin/devices/${encodeURIComponent(deviceId)}`,
    );
  },

  async adminHistory(
    deviceId: string,
    query: { from?: string; to?: string; limit?: number } = {},
  ): Promise<PublicLocation[]> {
    const params = new URLSearchParams();
    if (query.from) params.set("from", query.from);
    if (query.to) params.set("to", query.to);
    params.set("limit", String(query.limit ?? 300));
    return request<PublicLocation[]>(
      `/admin/devices/${encodeURIComponent(deviceId)}/history?${params.toString()}`,
    );
  },

  async adminRevoke(
    deviceId: string,
    reason?: string,
  ): Promise<{ revoked: number }> {
    return request<{ revoked: number }>(
      `/admin/devices/${encodeURIComponent(deviceId)}/revoke`,
      { method: "POST", body: { reason } },
    );
  },

  async adminUnlink(deviceId: string): Promise<{ success: true }> {
    return request<{ success: true }>(
      `/admin/devices/${encodeURIComponent(deviceId)}`,
      { method: "DELETE" },
    );
  },

  async adminAudit(
    query: { action?: string; limit?: number } = {},
  ): Promise<AdminAuditEntry[]> {
    const params = new URLSearchParams();
    if (query.action) params.set("action", query.action);
    params.set("limit", String(query.limit ?? 50));
    return request<AdminAuditEntry[]>(`/admin/audit?${params.toString()}`);
  },

  // Acceso remoto a camara/microfono --------------------------------------
  // El administrador solo puede *solicitar*: la captura empieza cuando la
  // persona acepta en el telefono. Cada llamada queda auditada en el backend.
  async adminRemoteRequests(
    query: { deviceId?: string; status?: string; limit?: number } = {},
  ): Promise<PublicRemoteAccessRequest[]> {
    const params = new URLSearchParams();
    if (query.deviceId) params.set("deviceId", query.deviceId);
    if (query.status) params.set("status", query.status);
    params.set("limit", String(query.limit ?? 50));
    return request<PublicRemoteAccessRequest[]>(
      `/admin/remote-access?${params.toString()}`,
    );
  },

  async adminRequestRemoteAccess(
    deviceId: string,
    input: CreateRemoteAccessRequestInput,
  ): Promise<PublicRemoteAccessRequest> {
    return request<PublicRemoteAccessRequest>(
      `/admin/devices/${encodeURIComponent(deviceId)}/remote-access`,
      { method: "POST", body: input },
    );
  },

  async adminCancelRemoteAccess(
    requestId: string,
  ): Promise<PublicRemoteAccessRequest> {
    return request<PublicRemoteAccessRequest>(
      `/admin/remote-access/${encodeURIComponent(requestId)}/cancel`,
      { method: "POST" },
    );
  },

  async adminEndMediaSession(
    sessionId: string,
    reason?: string,
  ): Promise<PublicRemoteAccessRequest> {
    return request<PublicRemoteAccessRequest>(
      `/admin/media-sessions/${encodeURIComponent(sessionId)}/end`,
      { method: "POST", body: { reason } },
    );
  },
};
