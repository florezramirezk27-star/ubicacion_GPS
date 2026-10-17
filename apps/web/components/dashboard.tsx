"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_SHARE_DURATION_MINUTES,
  MAX_SHARE_DURATION_MINUTES,
  MIN_SHARE_DURATION_MINUTES,
  classifyFreshness,
  createDeviceSchema,
  type CreatedLocationShare,
  type DeviceLocationSummary,
  type PublicLocation,
} from "@geo/shared";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "@/lib/auth-provider";
import {
  PLATFORM_LABEL,
  SHARE_STATUS_LABEL,
  formatAge,
  formatCoordinates,
  formatDateTime,
  formatMeters,
} from "@/lib/format";
import {
  connectLive,
  type LiveConnection,
  type LiveDeviceStatusEvent,
} from "@/lib/socket";
import { FreshnessBadge } from "./freshness-badge";
import { HistoryPanel } from "./history-panel";
import { LiveMap, type MapPosition } from "./live-map";

export function Dashboard() {
  const { user, logout } = useAuth();
  const queryClient = useQueryClient();

  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [liveLocation, setLiveLocation] = useState<PublicLocation | null>(null);
  const [deviceStatus, setDeviceStatus] =
    useState<LiveDeviceStatusEvent | null>(null);
  const [follow, setFollow] = useState(true);
  const [liveConnected, setLiveConnected] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [newShare, setNewShare] = useState<CreatedLocationShare | null>(null);
  const [copied, setCopied] = useState(false);

  // Formulario de alta de dispositivo.
  const [newDeviceName, setNewDeviceName] = useState("");
  const [newDevicePlatform, setNewDevicePlatform] = useState<"ANDROID" | "IOS">(
    "ANDROID",
  );
  const [deviceError, setDeviceError] = useState<string | null>(null);

  // Duracion de la sesion de comparticion.
  const [durationMinutes, setDurationMinutes] = useState(
    DEFAULT_SHARE_DURATION_MINUTES,
  );

  /**
   * "Ahora" se actualiza periodicamente para recalcular la antiguedad del dato.
   * Es lo que impide que un punto viejo siga pareciendo "en vivo".
   */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  // ------------------------------ Consultas ------------------------------
  const devicesQuery = useQuery({
    queryKey: ["devices"],
    queryFn: api.listDevices,
  });
  const summariesQuery = useQuery({
    queryKey: ["summaries"],
    queryFn: api.summaries,
    refetchInterval: 20_000,
  });

  useEffect(() => {
    if (
      !selectedDeviceId &&
      devicesQuery.data &&
      devicesQuery.data.length > 0
    ) {
      setSelectedDeviceId(devicesQuery.data[0]!.id);
    }
  }, [devicesQuery.data, selectedDeviceId]);

  useEffect(() => {
    setLiveLocation(null);
    setDeviceStatus(null);
    setNewShare(null);
    setCopied(false);
  }, [selectedDeviceId]);

  const selectedDevice = useMemo(
    () =>
      devicesQuery.data?.find((device) => device.id === selectedDeviceId) ??
      null,
    [devicesQuery.data, selectedDeviceId],
  );

  const latestQuery = useQuery({
    queryKey: ["latest", selectedDeviceId],
    queryFn: () => api.latest(selectedDeviceId as string),
    enabled: Boolean(selectedDeviceId),
    refetchInterval: 30_000,
  });

  const sharesQuery = useQuery({
    queryKey: ["shares", selectedDeviceId],
    queryFn: () => api.listShares(selectedDeviceId as string),
    enabled: Boolean(selectedDeviceId),
  });

  const historyQuery = useQuery({
    queryKey: ["history", selectedDeviceId],
    queryFn: () =>
      api.history({ deviceId: selectedDeviceId as string, limit: 500 }),
    enabled: Boolean(selectedDeviceId),
  });

  const activeShare = useMemo(
    () => sharesQuery.data?.find((share) => share.status === "ACTIVE") ?? null,
    [sharesQuery.data],
  );

  // ------------------------- Seguimiento en vivo -------------------------
  const socketRef = useRef<LiveConnection | null>(null);
  const selectedDeviceRef = useRef<string | null>(null);
  useEffect(() => {
    selectedDeviceRef.current = selectedDeviceId;
  }, [selectedDeviceId]);

  useEffect(() => {
    let cancelled = false;

    connectLive({
      onConnected: () => {
        setLiveConnected(true);
        setNotice(null);
      },
      onDisconnected: () => setLiveConnected(false),
      onError: (event) => setNotice(event.message),
      onLocation: (location) => {
        // Actualiza el resumen de dispositivos sin esperar a la siguiente consulta.
        queryClient.setQueryData<DeviceLocationSummary[]>(
          ["summaries"],
          (previous) => {
            if (!previous) return previous;
            return previous.map((summary) =>
              summary.deviceId === location.deviceId
                ? {
                    ...summary,
                    lastLocation: location,
                    freshness: "CURRENT",
                    ageSeconds: 0,
                  }
                : summary,
            );
          },
        );

        if (location.deviceId === selectedDeviceRef.current) {
          setLiveLocation(location);
        }
      },
      onStatus: (event) => {
        if (event.deviceId === selectedDeviceRef.current) {
          setDeviceStatus(event);
        }
      },
    })
      .then((connection) => {
        if (cancelled) {
          connection.disconnect();
          return;
        }
        socketRef.current = connection;
        if (selectedDeviceRef.current) {
          connection.subscribeDevice(selectedDeviceRef.current);
        }
      })
      .catch(() =>
        setNotice(
          "No se pudo abrir el canal en vivo. Se mostraran datos por consulta.",
        ),
      );

    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [queryClient]);

  // Suscribe/desuscribe al cambiar de dispositivo.
  useEffect(() => {
    const connection = socketRef.current;
    if (!connection || !selectedDeviceId) return;
    connection.subscribeDevice(selectedDeviceId);
    return () => connection.unsubscribeDevice(selectedDeviceId);
  }, [selectedDeviceId, liveConnected]);

  // ----------------------------- Derivados ------------------------------
  const position: PublicLocation | null =
    liveLocation ?? latestQuery.data?.lastLocation ?? null;

  const ageSeconds = position
    ? Math.max(
        0,
        Math.floor((now - new Date(position.recordedAt).getTime()) / 1000),
      )
    : null;

  const freshness = classifyFreshness(ageSeconds);

  const mapPosition: MapPosition | null = position
    ? { latitude: position.latitude, longitude: position.longitude }
    : null;

  const historyPoints = useMemo<MapPosition[]>(
    () =>
      // El historial viene del mas reciente al mas antiguo: se invierte para
      // dibujar el recorrido en orden cronologico.
      (historyQuery.data ?? [])
        .slice(0, 300)
        .reverse()
        .map((point) => ({
          latitude: point.latitude,
          longitude: point.longitude,
        })),
    [historyQuery.data],
  );

  // ----------------------------- Mutaciones -----------------------------
  const createDevice = useMutation({
    mutationFn: async () => {
      const parsed = createDeviceSchema.safeParse({
        platform: newDevicePlatform,
        deviceName: newDeviceName,
      });
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? "Datos invalidos");
      }
      return api.createDevice(parsed.data);
    },
    onSuccess: (device) => {
      setNewDeviceName("");
      setDeviceError(null);
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      queryClient.invalidateQueries({ queryKey: ["summaries"] });
      setSelectedDeviceId(device.id);
    },
    onError: (error) => {
      setDeviceError(
        error instanceof ApiError ? error.message : (error as Error).message,
      );
    },
  });

  const startShare = useMutation({
    mutationFn: () =>
      api.startShare(selectedDeviceId as string, durationMinutes),
    onSuccess: (share) => {
      setNewShare(share);
      setNotice(null);
      queryClient.invalidateQueries({ queryKey: ["shares", selectedDeviceId] });
    },
    onError: (error) =>
      setNotice(
        error instanceof ApiError
          ? error.message
          : "No se pudo iniciar la sesion",
      ),
  });

  const stopShare = useMutation({
    mutationFn: (shareId: string) =>
      api.stopShare(shareId, "Detenida desde el panel web"),
    onSuccess: () => {
      setNewShare(null);
      queryClient.invalidateQueries({ queryKey: ["shares", selectedDeviceId] });
    },
    onError: (error) =>
      setNotice(
        error instanceof ApiError
          ? error.message
          : "No se pudo detener la sesion",
      ),
  });

  async function copyToken(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar-brand">
          <span className="topbar-dot" />
          Geolocalizador Movil
        </div>
        <div className="topbar-actions">
          <span
            className="badge badge-unknown"
            title="Estado del canal WebSocket"
          >
            {liveConnected
              ? "Canal en vivo conectado"
              : "Canal en vivo desconectado"}
          </span>
          <span className="muted">{user?.email}</span>
          {user?.role === "SUPERADMIN" && (
            <Link className="badge badge-current" href="/admin">
              Panel de administracion
            </Link>
          )}
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

        <div className="grid">
          {/* ------------------------- Columna izquierda ------------------------- */}
          <div className="stack">
            <div className="card">
              <div className="card-title">
                <h2>Dispositivos</h2>
                <span className="tag">{devicesQuery.data?.length ?? 0}</span>
              </div>

              {devicesQuery.isLoading && (
                <p className="muted small">Cargando...</p>
              )}
              {devicesQuery.data?.length === 0 && (
                <p className="muted small">
                  Aun no hay dispositivos vinculados. Crea uno para empezar.
                </p>
              )}

              <div className="device-list">
                {devicesQuery.data?.map((device) => {
                  const summary = summariesQuery.data?.find(
                    (item) => item.deviceId === device.id,
                  );
                  return (
                    <button
                      key={device.id}
                      className={`device-item ${device.id === selectedDeviceId ? "active" : ""}`}
                      onClick={() => setSelectedDeviceId(device.id)}
                    >
                      <div className="device-item-name">
                        {device.deviceName}
                        <span className="tag">
                          {PLATFORM_LABEL[device.platform] ?? device.platform}
                        </span>
                      </div>
                      <div
                        className="row small"
                        style={{ marginTop: "0.35rem" }}
                      >
                        <FreshnessBadge
                          freshness={summary?.freshness ?? "UNKNOWN"}
                          ageText={
                            summary?.ageSeconds != null
                              ? formatAge(summary.ageSeconds)
                              : undefined
                          }
                        />
                      </div>
                    </button>
                  );
                })}
              </div>

              <hr
                style={{
                  border: "none",
                  borderTop: "1px solid var(--border)",
                  margin: "1rem 0",
                }}
              />

              <h3>Vincular dispositivo</h3>
              <div className="field">
                <label htmlFor="deviceName">Nombre</label>
                <input
                  id="deviceName"
                  value={newDeviceName}
                  onChange={(event) => setNewDeviceName(event.target.value)}
                  placeholder="Pixel de Juan"
                />
              </div>
              <div className="field">
                <label htmlFor="platform">Plataforma</label>
                <select
                  id="platform"
                  value={newDevicePlatform}
                  onChange={(event) =>
                    setNewDevicePlatform(
                      event.target.value as "ANDROID" | "IOS",
                    )
                  }
                >
                  <option value="ANDROID">Android</option>
                  <option value="IOS">iPhone</option>
                </select>
              </div>
              {deviceError && (
                <div
                  className="alert alert-error"
                  style={{ marginBottom: "0.75rem" }}
                >
                  {deviceError}
                </div>
              )}
              <button
                className="primary"
                onClick={() => createDevice.mutate()}
                disabled={
                  createDevice.isPending || newDeviceName.trim().length === 0
                }
                style={{ width: "100%" }}
              >
                {createDevice.isPending
                  ? "Vinculando..."
                  : "Vincular dispositivo"}
              </button>
            </div>

            <div className="card">
              <div className="card-title">
                <h2>Sesion de comparticion</h2>
                {activeShare && <span className="tag">Activa</span>}
              </div>

              {!selectedDevice && (
                <p className="muted small">
                  Selecciona un dispositivo para gestionar su comparticion.
                </p>
              )}

              {selectedDevice && (
                <>
                  <p className="small muted">
                    El dispositivo recibira un token de un solo uso. Solo
                    mientras la sesion este activa se aceptaran coordenadas
                    nuevas.
                  </p>

                  {activeShare ? (
                    <div className="stack" style={{ marginTop: "0.75rem" }}>
                      <div className="alert alert-ok">
                        Compartiendo desde{" "}
                        {formatDateTime(activeShare.startedAt)}. Expira{" "}
                        {formatDateTime(activeShare.expiresAt)}.
                      </div>
                      <button
                        className="danger"
                        onClick={() => stopShare.mutate(activeShare.id)}
                        disabled={stopShare.isPending}
                      >
                        {stopShare.isPending
                          ? "Deteniendo..."
                          : "Detener comparticion"}
                      </button>
                    </div>
                  ) : (
                    <div className="stack" style={{ marginTop: "0.75rem" }}>
                      <div className="field">
                        <label htmlFor="duration">
                          Duracion: {durationMinutes} minutos (max.{" "}
                          {Math.round(MAX_SHARE_DURATION_MINUTES / 60)} horas)
                        </label>
                        <input
                          id="duration"
                          type="range"
                          min={MIN_SHARE_DURATION_MINUTES}
                          max={MAX_SHARE_DURATION_MINUTES}
                          step={5}
                          value={durationMinutes}
                          onChange={(event) =>
                            setDurationMinutes(Number(event.target.value))
                          }
                        />
                      </div>
                      <button
                        className="primary"
                        onClick={() => startShare.mutate()}
                        disabled={startShare.isPending}
                      >
                        {startShare.isPending
                          ? "Iniciando..."
                          : "Iniciar comparticion"}
                      </button>
                    </div>
                  )}

                  {newShare && (
                    <div className="token-box">
                      <p className="small" style={{ margin: 0 }}>
                        Token de envio para este dispositivo (se muestra una
                        sola vez):
                      </p>
                      <p className="mono" style={{ margin: "0.4rem 0" }}>
                        {newShare.shareToken}
                      </p>
                      <div className="row">
                        <button
                          className="small"
                          onClick={() => void copyToken(newShare.shareToken)}
                        >
                          {copied ? "Copiado" : "Copiar token"}
                        </button>
                        <span className="small muted">
                          Usalo en la app movil o en{" "}
                          <code>scripts/simulate-mobile.mjs</code>.
                        </span>
                      </div>
                    </div>
                  )}

                  {sharesQuery.data && sharesQuery.data.length > 0 && (
                    <div
                      className="small muted"
                      style={{ marginTop: "0.75rem" }}
                    >
                      Historial de sesiones:
                      <ul
                        style={{ margin: "0.3rem 0 0", paddingLeft: "1.1rem" }}
                      >
                        {sharesQuery.data.slice(0, 4).map((share) => (
                          <li key={share.id}>
                            {SHARE_STATUS_LABEL[share.status] ?? share.status} ·{" "}
                            {formatDateTime(share.startedAt)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* -------------------------- Columna derecha -------------------------- */}
          <div className="stack">
            <div className="card">
              <div className="card-title">
                <h2>
                  {selectedDevice
                    ? `Ubicacion de ${selectedDevice.deviceName}`
                    : "Ubicacion en vivo"}
                </h2>
                <div className="row">
                  <FreshnessBadge
                    freshness={freshness}
                    ageText={
                      ageSeconds != null ? formatAge(ageSeconds) : undefined
                    }
                  />
                  {deviceStatus && (
                    <span
                      className="tag"
                      title="Ultimo evento de estado recibido"
                    >
                      {deviceStatus.status}
                    </span>
                  )}
                </div>
              </div>

              <LiveMap
                position={mapPosition}
                accuracyMeters={position?.accuracyMeters ?? null}
                trail={historyPoints}
                follow={follow}
              />

              <div className="row" style={{ marginTop: "0.75rem" }}>
                <label
                  className="row small"
                  style={{ margin: 0, gap: "0.4rem" }}
                >
                  <input
                    type="checkbox"
                    checked={follow}
                    onChange={(event) => setFollow(event.target.checked)}
                    style={{ width: "auto" }}
                  />
                  Centrar el mapa en cada actualizacion
                </label>
              </div>

              <div className="row small muted" style={{ marginTop: "0.5rem" }}>
                <span>
                  El marcador se mueve solo al recibir coordenadas nuevas. Si el
                  dispositivo deja de enviar, pasa a &quot;datos antiguos&quot;
                  y luego a &quot;desconectado&quot;.
                </span>
              </div>
            </div>

            <div className="card">
              <div className="card-title">
                <h2>Detalle de la ubicacion</h2>
              </div>
              {!position ? (
                <p className="muted small">Sin datos de ubicacion todavia.</p>
              ) : (
                <div
                  className="row"
                  style={{ alignItems: "stretch", gap: "1.5rem" }}
                >
                  <div>
                    <div className="small muted">Coordenadas</div>
                    <div className="mono">
                      {formatCoordinates(position.latitude, position.longitude)}
                    </div>
                  </div>
                  <div>
                    <div className="small muted">Precision GPS</div>
                    <div>{formatMeters(position.accuracyMeters)}</div>
                  </div>
                  <div>
                    <div className="small muted">Capturada</div>
                    <div>{formatDateTime(position.recordedAt)}</div>
                  </div>
                  <div>
                    <div className="small muted">Recibida</div>
                    <div>{formatDateTime(position.receivedAt)}</div>
                  </div>
                  {position.speedMps != null && (
                    <div>
                      <div className="small muted">Velocidad</div>
                      <div>{(position.speedMps * 3.6).toFixed(1)} km/h</div>
                    </div>
                  )}
                  {position.altitudeMeters != null && (
                    <div>
                      <div className="small muted">Altitud</div>
                      <div>{Math.round(position.altitudeMeters)} m</div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <HistoryPanel
              history={historyQuery.data ?? []}
              loading={historyQuery.isLoading}
              error={historyQuery.isError}
              currentPosition={mapPosition}
            />
          </div>
        </div>
      </main>
    </>
  );
}
