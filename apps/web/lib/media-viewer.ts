import {
  MEDIA_WS_EVENTS,
  type WebrtcIceCandidate,
  type WebrtcSignal,
} from "@geo/shared";
import { API_URL, getSession } from "./api";

/**
 * Visor WebRTC del panel de administracion.
 *
 * Es el extremo que **recibe** el flujo: el telefono es la fuente y crea la
 * oferta; aqui solo se responde con el SDP de respuesta y se intercambian
 * candidatos ICE. El servidor unicamente reenvia la senalizacion, nunca ve el
 * audio ni el video.
 *
 * Detalles que importan:
 *
 *  - **La oferta puede repetirse.** El telefono reenvia su oferta cada pocos
 *    segundos hasta recibir respuesta (asi funciona aunque este visor se abra
 *    tarde). Si llega una oferta identica a la ultima, no se renegocia: se
 *    reenvia la misma respuesta, que es lo barato y lo correcto.
 *  - **Los candidatos pueden llegar antes que la oferta.** Se guardan en cola y
 *    se aplican en cuanto hay descripcion remota.
 *  - **Nada de esto captura del lado del administrador**: no se pide camara ni
 *    microfono aqui. Solo se visualiza lo que la persona acepto en su telefono.
 */

/** Configuracion ICE: un STUN publico basta en la red de pruebas. */
const ICE_CONFIGURATION: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export interface MediaViewerOptions {
  /** Sesion de medios ACCEPTED y ACTIVE en el servidor. */
  sessionId: string;
  /** Flujo remoto listo para pintar en un <video>. */
  onStream: (stream: MediaStream) => void;
  /** Cambios del estado de la conexion (para el indicador del panel). */
  onState?: (state: RTCPeerConnectionState) => void;
  /** La sesion termino (la corto el usuario, el servidor, o fallo la red). */
  onEnded?: (reason: string) => void;
  /** Error legible para mostrar en el panel. */
  onError?: (message: string) => void;
}

export interface MediaViewer {
  sessionId: string;
  connectionState: () => RTCPeerConnectionState | "closed";
  /** Corta la conexion local (el cierre de la sesion lo hace la API). */
  close: () => void;
}

export async function startMediaViewer(
  options: MediaViewerOptions,
): Promise<MediaViewer> {
  const { sessionId } = options;
  const { io } = await import("socket.io-client");
  const session = getSession();

  const peer = new RTCPeerConnection(ICE_CONFIGURATION);
  const socket = io(`${API_URL}/media`, {
    transports: ["websocket", "polling"],
    auth: { token: session?.accessToken ?? "" },
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1_500,
  });

  let closed = false;
  /** Ultima oferta aplicada y su respuesta, para no renegociar en cada reenvio. */
  let lastOfferSdp: string | null = null;
  let lastAnswerSdp: string | null = null;
  /** Candidatos del telefono que llegaron antes que su oferta. */
  const pendingCandidates: RTCIceCandidateInit[] = [];
  /** Candidatos propios, para reenviarlos con cada respuesta. */
  const localCandidates: WebrtcIceCandidate[] = [];

  function sendSignal(signal: WebrtcSignal): void {
    if (closed) return;
    const event =
      signal.type === "candidate"
        ? MEDIA_WS_EVENTS.ice
        : signal.type === "answer"
          ? MEDIA_WS_EVENTS.answer
          : MEDIA_WS_EVENTS.offer;
    try {
      socket.emit(event, signal);
    } catch {
      /* si el socket cae, la reconexion y el siguiente reenvio lo resuelven */
    }
  }

  function teardown(reason: string): void {
    if (closed) return;
    closed = true;
    try {
      socket.emit(MEDIA_WS_EVENTS.end, { sessionId });
    } catch {
      /* ignorado */
    }
    try {
      peer.close();
    } catch {
      /* ignorado */
    }
    try {
      socket.disconnect();
    } catch {
      /* ignorado */
    }
    options.onEnded?.(reason);
  }

  peer.addEventListener("track", (event) => {
    const stream = event.streams[0];
    if (stream) options.onStream(stream);
  });

  peer.addEventListener("icecandidate", (event) => {
    if (!event.candidate) return;
    const payload: WebrtcIceCandidate = {
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid ?? null,
      sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
    };
    localCandidates.push(payload);
    sendSignal({ sessionId, type: "candidate", candidate: payload });
  });

  peer.addEventListener("connectionstatechange", () => {
    if (closed) return;
    options.onState?.(peer.connectionState);
    if (peer.connectionState === "failed") {
      options.onError?.(
        "Se perdio la conexion con el dispositivo. Vuelve a solicitarlo.",
      );
      teardown("Conexion WebRTC fallida");
    }
  });

  /** Aplica una oferta (o repite la ultima respuesta si es un reenvio). */
  async function applyOffer(sdp: string): Promise<void> {
    if (closed) return;

    if (lastOfferSdp === sdp && lastAnswerSdp) {
      sendSignal({ sessionId, type: "answer", sdp: lastAnswerSdp });
      for (const candidate of localCandidates) {
        sendSignal({ sessionId, type: "candidate", candidate });
      }
      return;
    }

    try {
      await peer.setRemoteDescription({ type: "offer", sdp });
      for (const candidate of pendingCandidates.splice(0)) {
        await peer.addIceCandidate(candidate).catch(() => undefined);
      }
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      lastOfferSdp = sdp;
      lastAnswerSdp = peer.localDescription?.sdp ?? answer.sdp ?? null;
      if (!lastAnswerSdp) {
        options.onError?.("No se pudo generar la respuesta de medios.");
        teardown("Sin SDP de respuesta");
        return;
      }
      sendSignal({ sessionId, type: "answer", sdp: lastAnswerSdp });
      for (const candidate of localCandidates) {
        sendSignal({ sessionId, type: "candidate", candidate });
      }
    } catch {
      options.onError?.(
        "No se pudo negociar la conexion con el dispositivo. Vuelve a solicitarlo.",
      );
      teardown("Fallo la negociacion WebRTC");
    }
  }

  socket.on("connect", () => {
    socket.emit("media:join", { sessionId }, () => {
      // Unido a la sala: a partir de aqui se espera la oferta del telefono.
      options.onState?.("connecting");
    });
  });

  socket.on(MEDIA_WS_EVENTS.offer, (signal: WebrtcSignal) => {
    if (closed || signal?.sessionId !== sessionId || !signal.sdp) return;
    void applyOffer(signal.sdp);
  });

  socket.on(MEDIA_WS_EVENTS.ice, (signal: WebrtcSignal) => {
    if (closed || signal?.sessionId !== sessionId || !signal.candidate) return;

    const candidate: RTCIceCandidateInit = {
      candidate: signal.candidate.candidate,
      sdpMid: signal.candidate.sdpMid ?? undefined,
      sdpMLineIndex: signal.candidate.sdpMLineIndex ?? undefined,
    };

    // Sin descripcion remota aun: se guarda y se aplica al recibir la oferta.
    if (!peer.remoteDescription) {
      pendingCandidates.push(candidate);
      return;
    }
    void peer.addIceCandidate(candidate).catch(() => {
      /* un candidato suelto que falla no invalida la conexion */
    });
  });

  socket.on(MEDIA_WS_EVENTS.end, () => {
    teardown("La sesion de medios finalizo.");
  });

  socket.on("media:error", (event: { message?: string }) => {
    options.onError?.(event?.message ?? "Error del canal de medios.");
  });

  socket.on("connect_error", () => {
    if (closed) return;
    options.onError?.("No se pudo conectar con el canal de medios.");
  });

  return {
    sessionId,
    connectionState: () => (closed ? "closed" : peer.connectionState),
    close: () => teardown("El visor cerro la sesion."),
  };
}
