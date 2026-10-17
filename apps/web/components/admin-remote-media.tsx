"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  REMOTE_REQUEST_STATUS_LABELS,
  REMOTE_SENSOR_LABELS,
  type AdminDeviceDetail,
  type PublicRemoteAccessRequest,
  type RemoteRequestStatus,
  type RemoteSensor,
} from "@geo/shared";
import { ApiError, api } from "@/lib/api";
import { startMediaViewer, type MediaViewer } from "@/lib/media-viewer";
import { formatDateTime } from "@/lib/format";

/**
 * Acceso remoto a camara y microfono (lado del panel).
 *
 * Lo que el administrador puede hacer aqui, y lo que no:
 *
 *  - **Solicitar** acceso a camara, microfono o ambos, con un motivo.
 *  - **Ver** el estado de la solicitud ("esperando consentimiento", "rechazada",
 *    "caducada") y **ver el flujo** cuando la persona acepta.
 *  - **Finalizar** la sesion en cualquier momento.
 *  - **No puede activar nada.** No existe un boton que encienda la camara sin
 *    que alguien la acepte en el telefono: la solicitud caduca sola si nadie
 *    responde (el silencio no es consentimiento).
 *
 * Limite conocido y documentado: si la app del telefono esta cerrada no hay
 * entrega. El sondeo de solicitudes vive en la app, y el sistema operativo no
 * permite abrir la camara desde fuera sin pasar por ella.
 */

/** Clase CSS del distintivo segun el estado de la solicitud. */
const STATUS_TONE: Record<RemoteRequestStatus, string> = {
  PENDING: "badge-stale",
  ACCEPTED: "badge-current",
  REJECTED: "badge-offline",
  EXPIRED: "badge-unknown",
  CANCELLED: "badge-unknown",
};

/** Etiqueta legible del estado de la conexion WebRTC del visor. */
const CONNECTION_LABEL: Record<string, string> = {
  new: "Preparando",
  connecting: "Conectando con el telefono",
  connected: "En directo",
  disconnected: "Conexion inestable",
  failed: "Conexion perdida",
  closed: "Sesion cerrada",
};

/** Opciones de validez de la solicitud, en segundos. */
const TTL_OPTIONS = [30, 60, 120, 300] as const;

export function AdminRemoteMedia({
  device,
  requests,
  onChanged,
}: {
  device: AdminDeviceDetail;
  /** Solicitudes del dispositivo, de la mas reciente a la mas antigua. */
  requests: PublicRemoteAccessRequest[];
  onChanged?: () => void;
}) {
  const [sensor, setSensor] = useState<RemoteSensor>("CAMERA");
  const [reason, setReason] = useState("");
  const [ttlSeconds, setTtlSeconds] = useState<number>(120);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [connection, setConnection] = useState<string>("closed");
  const [audioOn, setAudioOn] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewerRef = useRef<MediaViewer | null>(null);

  const pending = requests.find((item) => item.status === "PENDING") ?? null;
  const activeRequest =
    requests.find((item) => item.session?.status === "ACTIVE") ?? null;
  const activeSessionId = activeRequest?.session?.id ?? null;
  const latest = requests[0] ?? null;

  const invalidate = useCallback(() => {
    onChanged?.();
  }, [onChanged]);

  // ------------------------------- Mutaciones ------------------------------

  const requestMutation = useMutation({
    mutationFn: () => {
      const trimmed = reason.trim();
      return api.adminRequestRemoteAccess(device.id, {
        sensor,
        // El motivo es opcional, pero si se escribe debe tener sentido.
        ...(trimmed.length > 0 ? { reason: trimmed } : {}),
        ttlSeconds,
      });
    },
    onSuccess: () => {
      setError(null);
      setMessage(
        `Solicitud enviada (${REMOTE_SENSOR_LABELS[sensor]}). Caduca en ${ttlSeconds} s si nadie responde.`,
      );
      setReason("");
      invalidate();
    },
    onError: (caught) =>
      setError(
        caught instanceof ApiError
          ? caught.message
          : "No se pudo enviar la solicitud.",
      ),
  });

  const cancelMutation = useMutation({
    mutationFn: (requestId: string) => api.adminCancelRemoteAccess(requestId),
    onSuccess: () => {
      setMessage("Solicitud cancelada.");
      invalidate();
    },
    onError: (caught) =>
      setError(
        caught instanceof ApiError
          ? caught.message
          : "No se pudo cancelar la solicitud.",
      ),
  });

  const endMutation = useMutation({
    mutationFn: (sessionId: string) =>
      api.adminEndMediaSession(sessionId, "Finalizada por el administrador"),
    onSuccess: () => {
      setMessage("Sesion finalizada. El dispositivo detendra la captura.");
      invalidate();
    },
    onError: (caught) =>
      setError(
        caught instanceof ApiError
          ? caught.message
          : "No se pudo finalizar la sesion.",
      ),
  });

  // ------------------------ Visor WebRTC del flujo -------------------------
  useEffect(() => {
    if (!activeSessionId) {
      viewerRef.current?.close();
      viewerRef.current = null;
      setStream(null);
      setConnection("closed");
      return;
    }

    // Ya hay un visor para esta sesion: nada que hacer.
    if (viewerRef.current?.sessionId === activeSessionId) return;

    viewerRef.current?.close();
    let cancelled = false;

    void startMediaViewer({
      sessionId: activeSessionId,
      onStream: (incoming) => {
        if (cancelled) return;
        setStream(incoming);
      },
      onState: (state) => {
        if (!cancelled) setConnection(state);
      },
      onEnded: (why) => {
        if (cancelled) return;
        setConnection("closed");
        setStream(null);
        viewerRef.current = null;
        setMessage(why);
        invalidate();
      },
      onError: (text) => {
        if (!cancelled) setError(text);
      },
    })
      .then((viewer) => {
        if (cancelled) {
          viewer.close();
          return;
        }
        viewerRef.current = viewer;
      })
      .catch(() =>
        setError("No se pudo abrir el canal de medios del administrador."),
      );

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, invalidate]);

  // Al cambiar de dispositivo no se deja el visor abierto.
  useEffect(() => {
    return () => {
      viewerRef.current?.close();
      viewerRef.current = null;
    };
  }, [device.id]);

  // El flujo se pinta en el <video> en cuanto llega.
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.srcObject = stream;
    element.muted = !audioOn;
  }, [stream, audioOn]);

  const reasonTooShort = reason.trim().length > 0 && reason.trim().length < 3;

  return (
    <div className="card">
      <div className="card-title">
        <h2>Acceso remoto a camara y microfono</h2>
        {activeRequest ? (
          <span className="badge badge-current">Sesion activa</span>
        ) : pending ? (
          <span className="badge badge-stale">Esperando consentimiento</span>
        ) : (
          <span className="tag">Sin sesion</span>
        )}
      </div>

      <p className="small muted" style={{ marginTop: 0 }}>
        Solo se puede <strong>solicitar</strong>: la camara y el microfono se
        abren unicamente si la persona acepta en su telefono, y vera un aviso
        fijo con el boton para cortar. Si no responde, la solicitud caduca sola.
        Con la app cerrada no hay entrega (el aviso vive en la app).
      </p>

      {error && (
        <div className="alert alert-error" style={{ marginBottom: "0.75rem" }}>
          {error}
        </div>
      )}
      {message && (
        <div className="alert alert-info" style={{ marginBottom: "0.75rem" }}>
          {message}
        </div>
      )}

      {/* ---------------------------- Formulario ---------------------------- */}
      <div className="row" style={{ gap: "0.75rem", alignItems: "flex-end" }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="remote-sensor">Sensor</label>
          <select
            id="remote-sensor"
            value={sensor}
            onChange={(event) => setSensor(event.target.value as RemoteSensor)}
            disabled={Boolean(pending) || Boolean(activeRequest)}
          >
            <option value="CAMERA">Camara</option>
            <option value="MICROPHONE">Microfono</option>
            <option value="CAMERA_AND_MICROPHONE">Camara y microfono</option>
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="remote-ttl">Validez</label>
          <select
            id="remote-ttl"
            value={ttlSeconds}
            onChange={(event) => setTtlSeconds(Number(event.target.value))}
            disabled={Boolean(pending) || Boolean(activeRequest)}
          >
            {TTL_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {value} s
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1, marginBottom: 0 }}>
          <label htmlFor="remote-reason">Motivo (visible en el telefono)</label>
          <input
            id="remote-reason"
            value={reason}
            maxLength={280}
            placeholder="Por que se necesita el acceso"
            onChange={(event) => setReason(event.target.value)}
            disabled={Boolean(pending) || Boolean(activeRequest)}
          />
        </div>
      </div>

      {reasonTooShort && (
        <p className="small" style={{ color: "var(--warn)" }}>
          El motivo debe tener al menos 3 caracteres.
        </p>
      )}

      <div className="row" style={{ marginTop: "0.75rem" }}>
        <button
          className="primary"
          onClick={() => requestMutation.mutate()}
          disabled={
            requestMutation.isPending ||
            Boolean(pending) ||
            Boolean(activeRequest) ||
            reasonTooShort
          }
        >
          {requestMutation.isPending
            ? "Enviando..."
            : `Solicitar ${REMOTE_SENSOR_LABELS[sensor].toLowerCase()}`}
        </button>

        {pending && (
          <button
            className="ghost"
            onClick={() => cancelMutation.mutate(pending.id)}
            disabled={cancelMutation.isPending}
          >
            {cancelMutation.isPending ? "Cancelando..." : "Cancelar solicitud"}
          </button>
        )}

        {activeRequest && (
          <button
            className="danger"
            onClick={() => endMutation.mutate(activeRequest.session!.id)}
            disabled={endMutation.isPending}
          >
            {endMutation.isPending ? "Finalizando..." : "Finalizar sesion"}
          </button>
        )}
      </div>

      {pending && (
        <p className="small muted" style={{ marginTop: "0.75rem" }}>
          Esperando a que la persona acepte o rechace. Si no responde antes de{" "}
          {formatDateTime(pending.expiresAt)}, la solicitud caduca (el silencio
          no es consentimiento).
        </p>
      )}

      {/* ------------------------------ Visor ------------------------------ */}
      {activeRequest && (
        <div style={{ marginTop: "0.85rem" }}>
          <div className="spread" style={{ marginBottom: "0.5rem" }}>
            <span className="small">
              {CONNECTION_LABEL[connection] ?? connection}
            </span>
            <div className="row">
              {audioOn ? (
                <button
                  className="small ghost"
                  onClick={() => setAudioOn(false)}
                >
                  Silenciar
                </button>
              ) : (
                <button className="small" onClick={() => setAudioOn(true)}>
                  Activar sonido
                </button>
              )}
            </div>
          </div>

          <video
            ref={videoRef}
            className="media-viewer"
            autoPlay
            playsInline
            // El navegador bloquea el autoplay con audio: se arranca en mudo y
            // el sonido lo habilita el administrador con un clic explicito.
            muted={!audioOn}
          />

          <p className="small muted" style={{ marginTop: "0.5rem" }}>
            {stream
              ? "Flujo en directo desde el dispositivo. Nada se graba: el video viaja de extremo a extremo y el servidor solo reenvia la senalizacion."
              : "Esperando el flujo del telefono. Mientras tanto, la persona ve en su pantalla que la sesion esta activa y puede cortarla."}
          </p>
        </div>
      )}

      {/* ------------------------ Historial reciente ----------------------- */}
      {requests.length > 0 && (
        <div className="small muted" style={{ marginTop: "0.75rem" }}>
          Solicitudes recientes:
          <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.1rem" }}>
            {requests.slice(0, 5).map((item) => (
              <li key={item.id}>
                <span className={`badge ${STATUS_TONE[item.status]}`}>
                  {REMOTE_REQUEST_STATUS_LABELS[item.status]}
                </span>{" "}
                {REMOTE_SENSOR_LABELS[item.sensor]} ·{" "}
                {formatDateTime(item.createdAt)}
                {item.session?.endedAt
                  ? ` · cerrada ${formatDateTime(item.session.endedAt)}`
                  : ""}
                {item.session?.endedReason
                  ? ` (${item.session.endedReason})`
                  : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
