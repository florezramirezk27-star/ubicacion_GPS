"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FRESHNESS_DEFAULT_OFFLINE_MINUTES,
  LOCATION_FRESHNESS,
  batteryBadge,
  classifyFreshness,
  explainDataDelay,
  type AdminDevice,
  type AdminOverview,
  type BatteryTone,
  type LocationFreshness,
  type PublicLocation,
  type PublicRemoteAccessRequest,
} from "@geo/shared";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "@/lib/auth-provider";
import {
  FRESHNESS_LABEL,
  PLATFORM_LABEL,
  SHARE_STATUS_LABEL,
  describePlace,
  formatAddress,
  formatAge,
  formatCoordinates,
  formatDateTime,
  formatMeters,
} from "@/lib/format";
import { connectAdmin, type AdminConnection } from "@/lib/socket";
import { AdminAuditFeed } from "./admin-audit-feed";
import { AdminMap, type AdminTrailPoint } from "./admin-map";
import { AdminRemoteMedia } from "./admin-remote-media";
import { FreshnessBadge } from "./freshness-badge";

/** Color del distintivo de bateria, en el mismo lenguaje que la app movil. */
const BATTERY_TONE_CLASS: Record<BatteryTone, string> = {
  none: "badge-unknown",
  ok: "badge-unknown",
  warn: "badge-stale",
  critical: "badge-offline",
};

/** Estado efectivo de un dispositivo segun su ultima coordenada conocida. */
function effectiveFreshness(
  device: AdminDevice,
  now: number,
): { freshness: LocationFreshness; ageSeconds: number | null } {
  const at = device.lastLocation?.recordedAt;
  if (!at) return { freshness: "UNKNOWN", ageSeconds: null };
  const ageSeconds = Math.max(
    0,
    Math.floor((now - new Date(at).getTime()) / 1000),
  );
  return {
    freshness: classifyFreshness(ageSeconds, FRESHNESS_DEFAULT_OFFLINE_MINUTES),
    ageSeconds,
  };
}

/** Descripcion legible del estado del permiso reportado por la app. */
const PERMISSION_LABEL: Record<string, string> = {
  granted_foreground: "Concedido (primer plano)",
  granted_background: "Concedido (segundo plano)",
  denied: "Denegado",
  restricted: "Restringido",
  undetermined: "Sin decidir",
  unknown: "Desconocido",
};

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-value" data-tone={tone}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/**
 * Panel de Superadministrador (`GEOTRACK · ADMINISTRACION`).
 *
 * Resumen: vision global de todos los dispositivos autorizados, mapa con el
 * circulo de incertidumbre de cada uno, ficha con direccion aproximada,
 * historial y acciones de gestion (revocar / desvincular). Cada consulta queda
 * auditada en el backend.
 */
export function AdminDashboard() {
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);

  // Filtros del listado global.
  const [platform, setPlatform] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Actualizaciones que llegan por WebSocket (sin esperar a la siguiente consulta).
  const [liveLocations, setLiveLocations] = useState<
    Record<string, PublicLocation>
  >({});
  const [liveStatuses, setLiveStatuses] = useState<Record<string, string>>({});
  // Solicitudes de acceso remoto que llegan por WebSocket, indexadas por id.
  // Se fusionan con las de la consulta para que el panel reaccione al instante.
  const [liveRemoteRequests, setLiveRemoteRequests] = useState<
    Record<string, PublicRemoteAccessRequest>
  >({});

  // "Ahora" periodico para recalcular la antiguedad: un punto viejo nunca debe
  // seguir pareciendo "en vivo".
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedSearch(search.trim()),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [search]);

  // ------------------------------- Consultas -------------------------------
  const overviewQuery = useQuery<AdminOverview>({
    queryKey: ["admin", "overview"],
    queryFn: api.adminOverview,
    refetchInterval: 15_000,
  });

  const devicesQuery = useQuery({
    queryKey: ["admin", "devices", platform, debouncedSearch],
    queryFn: () =>
      api.adminDevices({
        platform: platform ? (platform as AdminDevice["platform"]) : undefined,
        q: debouncedSearch || undefined,
        limit: 300,
      }),
    refetchInterval: 15_000,
  });

  const detailQuery = useQuery({
    queryKey: ["admin", "device", selectedId],
    queryFn: () => api.adminDevice(selectedId as string),
    enabled: Boolean(selectedId),
    // Sin sondeo periodico: cada consulta de ficha queda AUDITADA, asi que solo
    // se pide al seleccionar (o al invalidar tras una accion). Las coordenadas
    // nuevas llegan por WebSocket (admin:location).
  });

  const historyQuery = useQuery({
    queryKey: ["admin", "history", selectedId],
    queryFn: () => api.adminHistory(selectedId as string, { limit: 300 }),
    enabled: Boolean(selectedId),
  });

  // Solicitudes de acceso remoto del dispositivo seleccionado. Se refresca en
  // segundo plano por si el canal WebSocket se cae; ademas cada cambio llega
  // como evento (`admin:remote-request` / `admin:media-session`).
  const remoteQuery = useQuery({
    queryKey: ["admin", "remote", selectedId],
    queryFn: () =>
      api.adminRemoteRequests({ deviceId: selectedId as string, limit: 20 }),
    enabled: Boolean(selectedId),
    refetchInterval: 20_000,
  });

  // --------------------------- Seguimiento en vivo -------------------------
  const socketRef = useRef<AdminConnection | null>(null);
  useEffect(() => {
    let cancelled = false;

    connectAdmin({
      onConnected: () => setLiveConnected(true),
      onReady: () => {
        setLiveConnected(true);
        setChannelError(null);
      },
      onDisconnected: () => setLiveConnected(false),
      onError: (event) => {
        setLiveConnected(false);
        setChannelError(event.message);
      },
      onLocation: (location) => {
        setLiveLocations((previous) => ({
          ...previous,
          [location.deviceId]: location,
        }));
      },
      onStatus: (event) => {
        setLiveStatuses((previous) => ({
          ...previous,
          [event.deviceId]: event.status,
        }));
      },
      // Acceso remoto: el dispositivo publica el cambio de estado (solicitada,
      // aceptada, rechazada, caducada) y el inicio/cierre de la sesion de medios.
      onRemoteRequest: (request) => {
        setLiveRemoteRequests((previous) => ({
          ...previous,
          [request.id]: request,
        }));
      },
      onMediaSession: (request) => {
        setLiveRemoteRequests((previous) => ({
          ...previous,
          [request.id]: request,
        }));
      },
      // Un cambio estructural (revocacion, baja) obliga a refrescar las listas.
      onChange: () => {
        void queryClient.invalidateQueries({ queryKey: ["admin"] });
      },
    })
      .then((connection) => {
        if (cancelled) {
          connection.disconnect();
          return;
        }
        socketRef.current = connection;
      })
      .catch(() =>
        setChannelError(
          "No se pudo abrir el canal de administracion. Se mostraran datos por consulta.",
        ),
      );

    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [queryClient]);

  // ------------------------------- Derivados -------------------------------
  // Fusiona las coordenadas en vivo con las filas del servidor.
  const devices = useMemo<AdminDevice[]>(() => {
    const base = devicesQuery.data ?? [];
    return base.map((device) => {
      const live = liveLocations[device.id];
      return live ? { ...device, lastLocation: live } : device;
    });
  }, [devicesQuery.data, liveLocations]);

  // Filtra por estado de frescura calculado en el cliente para que el listado
  // coincida siempre con lo que el usuario ve (posiblemente ya actualizado).
  const filteredDevices = useMemo(() => {
    if (!status) return devices;
    return devices.filter(
      (device) => effectiveFreshness(device, now).freshness === status,
    );
  }, [devices, status, now]);

  // Si el dispositivo seleccionado desaparece del listado, se limpia.
  useEffect(() => {
    if (
      selectedId &&
      devicesQuery.data &&
      !devicesQuery.data.some((device) => device.id === selectedId)
    ) {
      setSelectedId(null);
    }
  }, [devicesQuery.data, selectedId]);

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedId) ?? null,
    [devices, selectedId],
  );

  const detail = detailQuery.data ?? null;

  // Detalle fusionado con la ubicacion en vivo (si llego una nueva).
  const detailLocation: PublicLocation | null = useMemo(() => {
    if (selectedId && liveLocations[selectedId])
      return liveLocations[selectedId]!;
    return detail?.lastLocation ?? null;
  }, [selectedId, liveLocations, detail]);

  const detailFreshness = useMemo(() => {
    const at = detailLocation?.recordedAt;
    if (!at)
      return { freshness: "UNKNOWN" as LocationFreshness, ageSeconds: null };
    const ageSeconds = Math.max(
      0,
      Math.floor((now - new Date(at).getTime()) / 1000),
    );
    return {
      freshness: classifyFreshness(
        ageSeconds,
        FRESHNESS_DEFAULT_OFFLINE_MINUTES,
      ),
      ageSeconds,
    };
  }, [detailLocation, now]);

  const trail = useMemo<AdminTrailPoint[]>(
    () =>
      // El historial viene del mas reciente al mas antiguo: se invierte.
      (historyQuery.data ?? [])
        .slice(0, 300)
        .reverse()
        .map((point) => ({
          latitude: point.latitude,
          longitude: point.longitude,
        })),
    [historyQuery.data],
  );

  // Solicitudes del dispositivo seleccionado: las de la consulta mas las que
  // hayan llegado por WebSocket (que mandan, por ser mas recientes).
  const remoteRequests = useMemo<PublicRemoteAccessRequest[]>(() => {
    const merged = new Map<string, PublicRemoteAccessRequest>();
    for (const request of remoteQuery.data ?? []) merged.set(request.id, request);
    for (const [id, request] of Object.entries(liveRemoteRequests)) {
      if (request.deviceId === selectedId) merged.set(id, request);
    }
    return [...merged.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }, [remoteQuery.data, liveRemoteRequests, selectedId]);

  // ------------------------------- Mutaciones ------------------------------
  const revokeMutation = useMutation({
    mutationFn: (deviceId: string) =>
      api.adminRevoke(deviceId, "Revocado desde el panel de administracion"),
    onSuccess: (result) => {
      setNotice(
        result.revoked > 0
          ? `Se revocaron ${result.revoked} sesion(es) de comparticion.`
          : "El dispositivo no tenia sesiones activas.",
      );
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (error) =>
      setNotice(
        error instanceof ApiError
          ? error.message
          : "No se pudieron revocar las sesiones.",
      ),
  });

  const unlinkMutation = useMutation({
    mutationFn: (deviceId: string) => api.adminUnlink(deviceId),
    onSuccess: () => {
      setNotice("Dispositivo desvinculado de la plataforma.");
      setSelectedId(null);
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
    onError: (error) =>
      setNotice(
        error instanceof ApiError
          ? error.message
          : "No se pudo desvincular el dispositivo.",
      ),
  });

  function confirmRevoke(device: AdminDevice) {
    const ok = window.confirm(
      `Revocar el acceso de "${device.deviceName}" (${device.userEmail})?\n\nEl dispositivo dejara de poder enviar coordenadas hasta iniciar una nueva sesion.`,
    );
    if (ok) revokeMutation.mutate(device.id);
  }

  function confirmUnlink(device: AdminDevice) {
    const ok = window.confirm(
      `Desvincular "${device.deviceName}" (${device.userEmail})?\n\nSe eliminaran el dispositivo y todo su historial de ubicaciones. Esta accion no se puede deshacer.`,
    );
    if (ok) unlinkMutation.mutate(device.id);
  }

  const overview = overviewQuery.data;
  // Distintivos de bateria y de "por que el dato llega con retraso" de la ficha.
  const detailDelay = explainDataDelay(
    detailFreshness.freshness,
    detail?.batteryLevel,
  );

  return (
    <>
      <header className="topbar">
        <div className="topbar-brand">
          <span className="topbar-dot" />
          GEOTRACK · Administracion
        </div>
        <div className="topbar-actions">
          <span
            className={`badge ${liveConnected ? "badge-current" : "badge-offline"}`}
            title="Estado del canal WebSocket de administracion"
          >
            {liveConnected ? "Canal global conectado" : "Canal global caido"}
          </span>
          <span className="muted">{user?.email}</span>
          <Link className="badge badge-unknown" href="/dashboard">
            Panel de usuario
          </Link>
          <button className="small ghost" onClick={() => void logout()}>
            Cerrar sesion
          </button>
        </div>
      </header>

      <main className="page">
        {notice && (
          <div className="alert alert-info" style={{ marginBottom: "1rem" }}>
            {notice}
          </div>
        )}
        {channelError && (
          <div className="alert alert-error" style={{ marginBottom: "1rem" }}>
            {channelError}
          </div>
        )}

        <div className="card" style={{ marginBottom: "1.25rem" }}>
          <h2>Alcance del panel</h2>
          <p className="small muted" style={{ marginBottom: 0 }}>
            El administrador ve <strong>unicamente</strong> las coordenadas que
            cada dispositivo ha compartido y los metadatos que la app reporta.
            No accede a conversaciones, fotos ni llamadas, y <strong>no</strong>{" "}
            puede localizar un telefono por su numero. Un dato antiguo se marca
            como &quot;datos antiguos&quot; o &quot;desconectado&quot;; nunca se
            muestra como actual. Cada consulta de ficha o historial queda
            registrada en la auditoria. La camara y el microfono{" "}
            <strong>solo se pueden solicitar</strong>: se abren unicamente si la
            persona acepta en su telefono, donde ve un aviso fijo con el boton
            para cortar, y con la app cerrada no hay entrega.
          </p>
        </div>

        <section className="stat-grid">
          <Stat label="Usuarios" value={overview?.totalUsers ?? 0} />
          <Stat label="Dispositivos" value={overview?.totalDevices ?? 0} />
          <Stat
            label="En linea ahora"
            value={overview?.onlineDevices ?? 0}
            tone="ok"
          />
          <Stat
            label="Compartiendo"
            value={overview?.sharingDevices ?? 0}
            tone="accent"
          />
          <Stat label="Con alerta" value={overview?.alerts ?? 0} tone="warn" />
          <Stat label="Sesiones activas" value={overview?.activeShares ?? 0} />
        </section>

        <div className="grid">
          {/* --------------------------- Columna izquierda --------------------------- */}
          <div className="stack">
            <div className="card">
              <div className="card-title">
                <h2>Dispositivos globales</h2>
                <span className="tag">
                  {filteredDevices.length}/{devices.length}
                </span>
              </div>

              <div className="field">
                <label htmlFor="admin-search">Buscar</label>
                <input
                  id="admin-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Nombre o correo del propietario"
                />
              </div>
              <div className="row" style={{ gap: "0.5rem" }}>
                <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                  <label htmlFor="admin-platform">Plataforma</label>
                  <select
                    id="admin-platform"
                    value={platform}
                    onChange={(event) => setPlatform(event.target.value)}
                  >
                    <option value="">Todas</option>
                    <option value="ANDROID">Android</option>
                    <option value="IOS">iPhone</option>
                  </select>
                </div>
                <div className="field" style={{ flex: 1, marginBottom: 0 }}>
                  <label htmlFor="admin-status">Estado</label>
                  <select
                    id="admin-status"
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                  >
                    <option value="">Todos</option>
                    {LOCATION_FRESHNESS.map((value) => (
                      <option key={value} value={value}>
                        {FRESHNESS_LABEL[value]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <hr
                style={{
                  border: "none",
                  borderTop: "1px solid var(--border)",
                  margin: "1rem 0",
                }}
              />

              {devicesQuery.isLoading && (
                <p className="muted small">Cargando dispositivos...</p>
              )}
              {devicesQuery.isError && (
                <div className="alert alert-error">
                  No se pudo cargar la lista global.
                </div>
              )}
              {!devicesQuery.isLoading && filteredDevices.length === 0 && (
                <p className="muted small">
                  No hay dispositivos que cumplan el filtro.
                </p>
              )}

              <div className="device-list">
                {filteredDevices.map((device) => {
                  const state = effectiveFreshness(device, now);
                  const battery = batteryBadge(device.batteryLevel);
                  const delay = explainDataDelay(
                    state.freshness,
                    device.batteryLevel,
                  );
                  return (
                    <button
                      key={device.id}
                      className={`device-item ${device.id === selectedId ? "active" : ""}`}
                      onClick={() => setSelectedId(device.id)}
                    >
                      <div className="device-item-name">
                        <span>{device.deviceName}</span>
                        <span className="tag">
                          {PLATFORM_LABEL[device.platform] ?? device.platform}
                        </span>
                      </div>
                      <div
                        className="small muted"
                        style={{ marginTop: "0.2rem" }}
                      >
                        {device.userEmail}
                      </div>
                      <div className="small" style={{ marginTop: "0.15rem" }}>
                        {formatAddress(device.address)}
                      </div>
                      <div
                        className="row small"
                        style={{ marginTop: "0.35rem" }}
                      >
                        <FreshnessBadge
                          freshness={state.freshness}
                          ageText={
                            state.ageSeconds != null
                              ? formatAge(state.ageSeconds)
                              : undefined
                          }
                        />
                        {/* Con bateria baja y el dato retrasado se dice "ahorro
                            de bateria", no "sin datos": el retraso es
                            deliberado, no un fallo. */}
                        {delay.reason === "battery-saving" && (
                          <span className="badge badge-stale" title={delay.detail}>
                            {delay.label}
                          </span>
                        )}
                        {liveStatuses[device.id] && (
                          <span className="tag">{liveStatuses[device.id]}</span>
                        )}
                        <span
                          className={`badge ${BATTERY_TONE_CLASS[battery.tone]}`}
                          title={
                            battery.highlight
                              ? "Bateria baja: el dispositivo espacia los envios."
                              : "Nivel de bateria reportado."
                          }
                        >
                          {battery.label}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ---------------------------- Columna derecha ---------------------------- */}
          <div className="stack">
            <div className="card">
              <div className="card-title">
                <h2>Mapa global</h2>
                <div className="row">
                  <span className="legend">
                    <span
                      className="legend-dot"
                      style={{ background: "#34d399" }}
                    />
                    En vivo
                  </span>
                  <span className="legend">
                    <span
                      className="legend-dot"
                      style={{ background: "#fbbf24" }}
                    />
                    Antiguo
                  </span>
                  <span className="legend">
                    <span
                      className="legend-dot"
                      style={{ background: "#f87171" }}
                    />
                    Desconectado
                  </span>
                  <span className="legend">
                    <span
                      className="legend-dot"
                      style={{ background: "#94a3b8" }}
                    />
                    Sin datos
                  </span>
                  <button
                    className="small"
                    onClick={() => setFitSignal((value) => value + 1)}
                  >
                    Centrar
                  </button>
                </div>
              </div>

              <AdminMap
                devices={filteredDevices}
                selectedId={selectedId}
                onSelect={setSelectedId}
                trail={trail}
                fitSignal={fitSignal}
              />

              <p className="small muted" style={{ marginTop: "0.6rem" }}>
                El circulo alrededor de cada punto representa la precision
                reportada por el GPS: cuanto mas grande, menos certeza sobre la
                posicion exacta.
              </p>
            </div>

            <div className="card">
              <div className="card-title">
                <h2>
                  {selectedDevice
                    ? `Ficha de ${selectedDevice.deviceName}`
                    : "Ficha del dispositivo"}
                </h2>
                {selectedDevice && (
                  <div className="row">
                    <FreshnessBadge
                      freshness={detailFreshness.freshness}
                      ageText={
                        detailFreshness.ageSeconds != null
                          ? formatAge(detailFreshness.ageSeconds)
                          : undefined
                      }
                    />
                    {detailDelay.reason === "battery-saving" && (
                      <span
                        className="badge badge-stale"
                        title={detailDelay.detail}
                      >
                        {detailDelay.label}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {!selectedId && (
                <p className="muted small">
                  Selecciona un dispositivo en la lista o en el mapa para ver su
                  ficha, su direccion aproximada y su historial.
                </p>
              )}

              {selectedId && detailQuery.isLoading && (
                <p className="muted small">Cargando ficha...</p>
              )}
              {selectedId && detailQuery.isError && (
                <div className="alert alert-error">
                  No se pudo cargar la ficha del dispositivo.
                </div>
              )}

              {detail && (
                <div className="stack">
                  <div
                    className="row"
                    style={{ gap: "1.5rem", alignItems: "stretch" }}
                  >
                    <div>
                      <div className="small muted">Propietario</div>
                      <div>{detail.userEmail}</div>
                    </div>
                    <div>
                      <div className="small muted">Plataforma</div>
                      <div>
                        {PLATFORM_LABEL[detail.platform] ?? detail.platform}
                      </div>
                    </div>
                    <div>
                      <div className="small muted">Sistema / App</div>
                      <div>
                        {detail.osVersion ?? "—"} · {detail.appVersion ?? "—"}
                      </div>
                    </div>
                    <div>
                      <div className="small muted">Bateria</div>
                      <div>
                        <span
                          className={`badge ${BATTERY_TONE_CLASS[batteryBadge(detail.batteryLevel).tone]}`}
                        >
                          {batteryBadge(detail.batteryLevel).label}
                        </span>
                      </div>
                    </div>
                    <div>
                      <div className="small muted">Permiso de ubicacion</div>
                      <div>
                        {detail.permissionStatus
                          ? (PERMISSION_LABEL[detail.permissionStatus] ??
                            detail.permissionStatus)
                          : "Sin dato"}
                      </div>
                    </div>
                    <div>
                      <div className="small muted">Vinculado</div>
                      <div>{formatDateTime(detail.createdAt)}</div>
                    </div>
                    <div>
                      <div className="small muted">Ultima vez visto</div>
                      <div>
                        {detail.lastSeenAt
                          ? formatDateTime(detail.lastSeenAt)
                          : "Sin dato"}
                      </div>
                    </div>
                    <div>
                      <div className="small muted">Comparticion</div>
                      <div>
                        {detail.shareStatus
                          ? (SHARE_STATUS_LABEL[detail.shareStatus] ??
                            detail.shareStatus)
                          : "Sin sesion"}
                      </div>
                    </div>
                  </div>

                  <div className="address-box">
                    <div className="small muted">Direccion aproximada</div>
                    {detailLocation?.accuracyMeters != null && (
                      <div className="small muted">
                        (precisa a ~
                        {formatMeters(detailLocation.accuracyMeters)})
                      </div>
                    )}
                    <div>
                      {detail.address
                        ? detail.address.formattedAddress
                        : "Sin direccion disponible (el proveedor no respondio o no hay datos suficientes)."}
                    </div>
                    {detail.address && describePlace(detail.address) && (
                      <div className="small muted">
                        {describePlace(detail.address)}
                      </div>
                    )}
                  </div>

                  {detailLocation ? (
                    <div className="row" style={{ gap: "1.5rem" }}>
                      <div>
                        <div className="small muted">Coordenadas</div>
                        <div className="mono">
                          {formatCoordinates(
                            detailLocation.latitude,
                            detailLocation.longitude,
                          )}
                        </div>
                      </div>
                      <div>
                        <div className="small muted">Precision GPS</div>
                        <div>{formatMeters(detailLocation.accuracyMeters)}</div>
                      </div>
                      <div>
                        <div className="small muted">Capturada</div>
                        <div>{formatDateTime(detailLocation.recordedAt)}</div>
                      </div>
                      <div>
                        <div className="small muted">Puntos historicos</div>
                        <div>{detail.locationCount}</div>
                      </div>
                    </div>
                  ) : (
                    <p className="muted small">
                      Este dispositivo no ha reportado ninguna ubicacion.
                    </p>
                  )}

                  {detailDelay.reason !== "live" && (
                    <p className="small muted" style={{ margin: 0 }}>
                      {detailDelay.label}: {detailDelay.detail}
                    </p>
                  )}

                  <div className="row">
                    <button
                      className="danger"
                      onClick={() => confirmRevoke(detail)}
                      disabled={revokeMutation.isPending}
                    >
                      {revokeMutation.isPending
                        ? "Revocando..."
                        : "Revocar acceso"}
                    </button>
                    <button
                      className="danger"
                      onClick={() => confirmUnlink(detail)}
                      disabled={unlinkMutation.isPending}
                    >
                      {unlinkMutation.isPending
                        ? "Desvinculando..."
                        : "Desvincular dispositivo"}
                    </button>
                  </div>

                  {detail.shares.length > 0 && (
                    <div className="small muted">
                      Sesiones recientes:
                      <ul
                        style={{ margin: "0.3rem 0 0", paddingLeft: "1.1rem" }}
                      >
                        {detail.shares.slice(0, 5).map((share) => (
                          <li key={share.id}>
                            {SHARE_STATUS_LABEL[share.status] ?? share.status} ·{" "}
                            {formatDateTime(share.startedAt)} → expira{" "}
                            {formatDateTime(share.expiresAt)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Acceso remoto: solo aparece cuando hay una ficha cargada, porque
                solicitar acceso exige un dispositivo concreto y su historial
                de solicitudes. */}
            {detail && (
              <AdminRemoteMedia
                device={detail}
                requests={remoteRequests}
                onChanged={() =>
                  void queryClient.invalidateQueries({
                    queryKey: ["admin", "remote", detail.id],
                  })
                }
              />
            )}

            <div className="card">
              <div className="card-title">
                <h2>Historial de ubicaciones</h2>
                <span className="tag">{historyQuery.data?.length ?? 0}</span>
              </div>
              {!selectedId && (
                <p className="muted small">
                  Selecciona un dispositivo para ver su historial.
                </p>
              )}
              {selectedId && historyQuery.isLoading && (
                <p className="muted small">Cargando historial...</p>
              )}
              {selectedId && historyQuery.data?.length === 0 && (
                <p className="muted small">Sin puntos registrados.</p>
              )}
              {historyQuery.data && historyQuery.data.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Capturada</th>
                        <th>Coordenadas</th>
                        <th>Precision</th>
                        <th>Velocidad</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyQuery.data.slice(0, 200).map((point) => (
                        <tr key={point.id}>
                          <td>{formatDateTime(point.recordedAt)}</td>
                          <td className="mono">
                            {formatCoordinates(point.latitude, point.longitude)}
                          </td>
                          <td>{formatMeters(point.accuracyMeters)}</td>
                          <td>
                            {point.speedMps != null
                              ? `${(point.speedMps * 3.6).toFixed(1)} km/h`
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={{ marginTop: "1.25rem" }}>
          <AdminAuditFeed />
        </div>
      </main>
    </>
  );
}
