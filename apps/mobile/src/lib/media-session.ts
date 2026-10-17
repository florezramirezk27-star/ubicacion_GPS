import {
  MediaStream,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
  mediaDevices,
} from "react-native-webrtc";
import { io, type Socket } from "socket.io-client";
import {
  MEDIA_WS_EVENTS,
  type PublicMediaSession,
  type RemoteSensor,
  type WebrtcIceCandidate,
  type WebrtcSignal,
} from "@geo/shared";

/**
 * Sesion de medios WebRTC (lado del dispositivo).
 *
 * Que hace y que NO hace:
 *   - Abre camara y/o microfono **solo despues** de que la persona haya
 *     aceptado la solicitud en la pantalla de consentimiento. Este modulo no
 *     decide: recibe la orden de `useRemoteAccess`.
 *   - Publica el flujo al administrador a traves de la senalizacion del
 *     servidor (`/media`). El audio y el video van de extremo a extremo: el
 *     servidor solo reenvia SDP e ICE, nunca guarda el contenido.
 *   - Muestra un indicador mientras la camara esta activa (lo pinta la
 *     pantalla) y libera los recursos en cuanto se corta la sesion.
 *
 * Decision practica sobre el offer: el dispositivo es la fuente, asi que crea
 * la oferta y la reenvia cada pocos segundos hasta recibir una respuesta. Asi
 * funciona aunque el administrador abra el visor mas tarde, sin necesidad de
 * un canal de control adicional.
 */

/** Intervalo de reintento de la oferta mientras nadie responde. */
const OFFER_RETRY_MS = 3_000;
/** Numero maximo de reintentos de la oferta (30 s de cortesia). */
const OFFER_MAX_RETRIES = 10;

/**
 * Un unico servidor STUN publico. No hace falta TURN en la red de pruebas (la
 * app y el panel estan en la misma red local); si hiciera falta atravesar NAT
 * simetrico, habria que anadir un TURN propio.
 */
const ICE_CONFIGURATION = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export interface StartMediaSessionOptions {
  /** Sesion de medios ya creada y ACCEPTED en el servidor. */
  sessionId: string;
  sensor: RemoteSensor;
  /** Token de acceso del usuario dueno del dispositivo. */
  accessToken: string;
  /** URL base de la API (sin barra final). */
  apiUrl: string;
  /** El otro extremo (o el servidor) corto la sesion. */
  onEnded?: (reason: string) => void;
  /** Error legible para mostrar en pantalla. */
  onError?: (message: string) => void;
}

export interface MediaSessionHandle {
  sessionId: string;
  /** Estado de la conexion WebRTC, para el indicador de pantalla. */
  connectionState(): string;
  /**
   * Corta la captura y libera camara/microfono.
   * Idempotente: llamarlo dos veces no hace nada la segunda vez.
   */
  stop(reason?: string): void;
}

function eventFor(signalType: WebrtcSignal["type"]): string {
  switch (signalType) {
    case "offer":
      return MEDIA_WS_EVENTS.offer;
    case "answer":
      return MEDIA_WS_EVENTS.answer;
    case "candidate":
      return MEDIA_WS_EVENTS.ice;
    default:
      return MEDIA_WS_EVENTS.end;
  }
}

/**
 * Abre una sesion de medios para una solicitud ya aceptada.
 *
 * Lanza si no se puede obtener el flujo (por ejemplo, permisos revocados entre
 * la aceptacion y la apertura): quien llama debe mostrar el error y cerrar la
 * sesion en el servidor.
 */
export async function startMediaSession(
  options: StartMediaSessionOptions,
): Promise<MediaSessionHandle> {
  const { sessionId, sensor, accessToken, apiUrl } = options;
  const wantsVideo = sensor !== "MICROPHONE";
  const wantsAudio = sensor !== "CAMERA";

  const stream: MediaStream = await mediaDevices.getUserMedia({
    audio: wantsAudio,
    video: wantsVideo,
  });

  const peer = new RTCPeerConnection(ICE_CONFIGURATION);
  for (const track of stream.getTracks()) {
    peer.addTrack(track, stream);
  }

  const socket: Socket = io(`${apiUrl}/media`, {
    transports: ["websocket"],
    auth: { token: accessToken },
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1_500,
  });

  let stopped = false;
  let answered = false;
  let retries = 0;
  let retryTimer: ReturnType<typeof setInterval> | null = null;
  const localCandidates: WebrtcIceCandidate[] = [];

  function sendSignal(signal: WebrtcSignal): void {
    if (stopped) return;
    try {
      socket.emit(eventFor(signal.type), signal);
    } catch {
      /* si el socket esta caido, el reintento de oferta lo volvera a intentar */
    }
  }

  function sendOffer(): void {
    const sdp = peer.localDescription?.sdp;
    if (!sdp) return;
    sendSignal({ sessionId, type: "offer", sdp });
    // Se reenvian tambien los candidatos ya recogidos: si el visor se conecta
    // tarde, los necesita para completar la conexion.
    for (const candidate of localCandidates) {
      sendSignal({ sessionId, type: "candidate", candidate });
    }
  }

  function teardown(): void {
    stopped = true;
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
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
      stream.release(true);
    } catch {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignorado */
        }
      }
    }
    try {
      socket.disconnect();
    } catch {
      /* ignorado */
    }
  }

  peer.addEventListener("icecandidate", (event) => {
    const candidate = event.candidate;
    if (!candidate) return;
    const payload: WebrtcIceCandidate = {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? null,
      sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    };
    localCandidates.push(payload);
    sendSignal({ sessionId, type: "candidate", candidate: payload });
  });

  peer.addEventListener("connectionstatechange", () => {
    const state = peer.connectionState;
    if (state === "failed" && !stopped) {
      teardown();
      options.onError?.(
        "La conexion con el administrador fallo. Se ha cerrado la sesion.",
      );
      options.onEnded?.("Fallo de conexion");
    }
  });

  socket.on(MEDIA_WS_EVENTS.answer, (signal: WebrtcSignal) => {
    if (stopped || signal?.sessionId !== sessionId || !signal.sdp) return;
    if (answered) return;
    answered = true;
    void peer
      .setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp: signal.sdp }),
      )
      .catch(() => {
        options.onError?.("No se pudo completar la conexion con el visor.");
      });
  });

  socket.on(MEDIA_WS_EVENTS.ice, (signal: WebrtcSignal) => {
    if (stopped || signal.sessionId !== sessionId || !signal.candidate) return;
    const candidate = signal.candidate;
    void peer
      .addIceCandidate(
        new RTCIceCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? undefined,
          sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
        }),
      )
      .catch(() => {
        /* un candidato suelto que falla no invalida la conexion */
      });
  });

  socket.on(MEDIA_WS_EVENTS.end, () => {
    if (stopped) return;
    teardown();
    options.onEnded?.("La sesion de medios finalizo.");
  });

  socket.on("connect_error", () => {
    if (stopped) return;
    options.onError?.("No se pudo conectar con el servidor de medios.");
  });

  socket.on("connect", () => {
    // `media:join` con acuse: hasta que el servidor confirma que estamos en la
    // sala no tiene sentido negociar (las senales se reenviarian al vacio).
    socket.emit("media:join", { sessionId }, () => {
      if (stopped) return;
      void (async () => {
        try {
          const offer = await peer.createOffer();
          await peer.setLocalDescription(offer);
        } catch {
          teardown();
          options.onError?.("No se pudo preparar la transmision de la camara.");
          options.onEnded?.("Fallo al negociar la conexion.");
          return;
        }

        sendOffer();

        // Reintento periodico de la oferta: el visor puede abrirse despues de
        // que el usuario acepte, y sin este reenvio la sesion quedaria muda.
        retryTimer = setInterval(() => {
          if (stopped || answered) {
            if (retryTimer) clearInterval(retryTimer);
            retryTimer = null;
            return;
          }
          retries += 1;
          if (retries > OFFER_MAX_RETRIES) {
            teardown();
            options.onError?.("El administrador no respondio a la solicitud.");
            options.onEnded?.("Sin respuesta del visor.");
            return;
          }
          sendOffer();
        }, OFFER_RETRY_MS);
      })();
    });
  });

  return {
    sessionId,
    connectionState: () => peer.connectionState,
    stop: () => {
      if (stopped) return;
      teardown();
    },
  };
}

/** Etiqueta de la sesion para la cabecera del indicador. */
export function describeMediaSession(session: PublicMediaSession): string {
  return `Sesion de medios ${session.id.slice(-6)} (${session.sensor})`;
}