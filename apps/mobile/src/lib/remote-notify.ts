import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import {
  REMOTE_SENSOR_LABELS,
  type PublicRemoteAccessRequest,
} from "@geo/shared";

/**
 * Aviso local de una solicitud de acceso remoto.
 *
 * Por que una notificacion **local** y no un push: la plataforma no depende de
 * servicios de terceros ni de tokens de push (nada de FCM/Firebase). El precio
 * se documenta en lugar de esconderse: con la app cerrada no hay aviso, porque
 * el sondeo de solicitudes solo corre mientras la app esta viva. La solicitud
 * en cambio si queda registrada en el servidor y caduca sola, asi que al volver
 * a abrir la app aparece igualmente.
 *
 * Importante: la notificacion **avisa**, no activa nada. La camara o el
 * microfono solo se abren despues de que la persona pulse "Permitir" en la
 * pantalla de consentimiento.
 */

/** Canal de Android: alta prioridad, porque es una peticion con caducidad. */
const CHANNEL_ID = "acceso-remoto";

/** Clave con la que viaja el id de la solicitud dentro de la notificacion. */
export const REMOTE_REQUEST_DATA_KEY = "remoteRequestId";

function identifierFor(requestId: string): string {
  return `remote-request-${requestId}`;
}

// El manejador se registra al importar el modulo: asi, con la app en primer
// plano, la notificacion se muestra igualmente (y no se silencia sin avisar).
try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
} catch {
  /* en web no existe; la app movil es la unica que usa notificaciones */
}

/** Prepara el canal y pide el permiso de notificaciones. Se pide una sola vez. */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: "Solicitudes de acceso",
        description:
          "Avisos de solicitudes de camara o microfono enviadas por el administrador.",
        importance: Notifications.AndroidImportance.HIGH,
        sound: "default",
        vibrationPattern: [0, 250, 250, 250],
      });
    }

    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;

    const requested = await Notifications.requestPermissionsAsync();
    return requested.granted;
  } catch {
    return false;
  }
}

/** Texto legible de una solicitud (se usa en la notificacion y en la pantalla). */
export function describeRemoteRequest(
  request: PublicRemoteAccessRequest,
): string {
  const what = REMOTE_SENSOR_LABELS[request.sensor];
  const who = request.requestedByEmail
    ? `Administrador ${request.requestedByEmail}`
    : "El administrador";
  return `${who} solicita acceso a: ${what}.`;
}

/** Publica el aviso local de una solicitud pendiente. */
export async function notifyRemoteRequest(
  request: PublicRemoteAccessRequest,
): Promise<void> {
  try {
    const allowed = await ensureNotificationPermission();
    if (!allowed) return;

    await Notifications.scheduleNotificationAsync({
      identifier: identifierFor(request.id),
      content: {
        title: "Solicitud de acceso remoto",
        body: `${describeRemoteRequest(request)} Abre la app para aceptar o rechazar: nada se activa sin tu permiso.`,
        data: { [REMOTE_REQUEST_DATA_KEY]: request.id },
        sound: "default",
      },
      trigger: Platform.OS === "android" ? { channelId: CHANNEL_ID } : null,
    });
  } catch {
    // Si el sistema no deja notificar, la solicitud se sigue viendo en la app.
  }
}

/** Retira el aviso de una solicitud ya resuelta. */
export async function dismissRemoteRequestNotification(
  requestId: string,
): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(identifierFor(requestId));
  } catch {
    /* ignorado */
  }
}

/**
 * Escucha los toques sobre la notificacion y devuelve el id de la solicitud.
 * Permite que tocar el aviso abra directamente la pantalla de consentimiento.
 */
export function subscribeToRemoteRequestTaps(
  listener: (requestId: string) => void,
): () => void {
  try {
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data as
          | Record<string, unknown>
          | undefined;
        const requestId = data?.[REMOTE_REQUEST_DATA_KEY];
        if (typeof requestId === "string") listener(requestId);
      },
    );
    return () => subscription.remove();
  } catch {
    return () => undefined;
  }
}