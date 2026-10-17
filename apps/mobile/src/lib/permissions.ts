import { PermissionsAndroid, Platform } from "react-native";
import * as Location from "expo-location";
import { sensorsOf, type RemoteSensor } from "@geo/shared";
import {
  loadMediaPermissionsPrimed,
  loadPermissionsPrimed,
  markMediaPermissionsPrimed,
  markPermissionsPrimed,
} from "./tracking-store";

/**
 * Gestion de permisos de ubicacion.
 *
 * Objetivo de diseno: pedir los permisos una vez y respetar la decision.
 *   - La primera vez se explica y se solicitan (precisa en primer plano y,
 *     despues, "todo el tiempo" para el segundo plano).
 *   - En arranques posteriores NO se vuelve a mostrar el dialogo si el permiso
 *     sigue concedido. Solo se consulta el estado con `get*PermissionsAsync`.
 *   - Si el permiso fue revocado, NO se insiste en bucle: se devuelve
 *     `needsSettings: true` para que la pantalla ofrezca "Abrir ajustes".
 *
 * Diferencias por sistema (honestas, no se puede saltar el control del SO):
 *   - Android 11+ (API 30+): el permiso de segundo plano NO se concede con un
 *     dialogo; `requestBackgroundPermissionsAsync` abre los ajustes y el usuario
 *     debe elegir "Permitir todo el tiempo".
 *   - iOS: el primer "Cambiar a Siempre" aparece en el dialogo de segundo plano;
 *     si el usuario eligio "Al usar la app" o "Permitir una vez", hay que
 *     cambiarlo desde Ajustes.
 */

export type PermissionLevel =
  | "granted_background"
  | "granted_foreground"
  | "denied"
  | "undetermined";

export interface PermissionsSnapshot {
  foregroundGranted: boolean;
  backgroundGranted: boolean;
  /** Permiso preciso concedido (no "aproximada" / "reducida"). */
  precise: boolean;
  level: PermissionLevel;
  foregroundCanAsk: boolean;
  backgroundCanAsk: boolean;
  /** Ya se gestionaron los permisos antes en este dispositivo. */
  primed: boolean;
  /** Estado del permiso de notificaciones (Android 13+), para la notificacion del servicio. */
  notifications: "granted" | "denied" | "undetermined";
}

export interface EnsurePermissionsResult {
  ok: boolean;
  foregroundGranted: boolean;
  backgroundGranted: boolean;
  precise: boolean;
  /** true cuando hace falta que el usuario actue desde los ajustes del sistema. */
  needsSettings: boolean;
  /** Mensaje legible que explica que falta, si algo falta. */
  message?: string;
}

function androidApiLevel(): number {
  const version = Platform.Version;
  return typeof version === "number" ? version : parseInt(String(version), 10);
}

function isPrecise(response: Location.LocationPermissionResponse): boolean {
  if (!response.granted) return false;
  if (Platform.OS === "ios") return response.ios?.accuracy === "full";
  // Android: 'fine' = precisa, 'coarse' = aproximada.
  return response.android?.accuracy !== "coarse";
}

function levelFrom(
  foregroundGranted: boolean,
  backgroundGranted: boolean,
): PermissionLevel {
  if (backgroundGranted) return "granted_background";
  if (foregroundGranted) return "granted_foreground";
  return "denied";
}

/** Comprueba (sin pedirlo) el permiso de notificaciones en Android 13+. */
async function readNotificationPermission(): Promise<
  PermissionsSnapshot["notifications"]
> {
  if (Platform.OS !== "android" || androidApiLevel() < 33) return "undetermined";
  const permission = (PermissionsAndroid.PERMISSIONS as Record<string, string>)
    .POST_NOTIFICATIONS;
  if (!permission) return "undetermined";
  try {
    const granted = await PermissionsAndroid.check(
      permission as Parameters<typeof PermissionsAndroid.check>[0],
    );
    return granted ? "granted" : "denied";
  } catch {
    return "undetermined";
  }
}

/** Lee el estado actual de los permisos, sin mostrar ningun dialogo. */
export async function readPermissions(): Promise<PermissionsSnapshot> {
  const [foreground, background, primed, notifications] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
    loadPermissionsPrimed(),
    readNotificationPermission(),
  ]);

  return {
    foregroundGranted: foreground.granted,
    backgroundGranted: background.granted,
    precise: isPrecise(foreground),
    level: levelFrom(foreground.granted, background.granted),
    foregroundCanAsk: foreground.canAskAgain,
    backgroundCanAsk: background.canAskAgain,
    primed,
    notifications,
  };
}

/**
 * Solicita la notificacion del servicio (Android 13+). Es lo que hace visible
 * el aviso permanente mientras se comparte la ubicacion en segundo plano.
 * No es bloqueante: el servicio en primer plano funciona aunque se deniegue.
 */
export async function requestForegroundServiceNotification(): Promise<
  PermissionsSnapshot["notifications"]
> {
  if (Platform.OS !== "android" || androidApiLevel() < 33) return "undetermined";

  const permissions = PermissionsAndroid.PERMISSIONS as Record<string, string>;
  const permission = permissions.POST_NOTIFICATIONS;
  if (!permission) return "undetermined";

  try {
    const result = await PermissionsAndroid.request(
      permission as Parameters<typeof PermissionsAndroid.request>[0],
    );
    return result === PermissionsAndroid.RESULTS.GRANTED
      ? "granted"
      : "denied";
  } catch {
    return "undetermined";
  }
}

/**
 * Asegura los permisos necesarios para el seguimiento en segundo plano.
 *
 * Se llama al pulsar "Iniciar seguimiento" (nunca al abrir la app), de modo que
 * los dialogos aparecen en un contexto explicado y no en cada arranque.
 */
export async function ensureTrackingPermissions(): Promise<EnsurePermissionsResult> {
  const primed = await loadPermissionsPrimed();

  // 1) Ubicacion en primer plano (precisa si el usuario lo permite).
  let foreground = await Location.getForegroundPermissionsAsync();
  if (!foreground.granted) {
    if (!foreground.canAskAgain) {
      await markPermissionsPrimed();
      return {
        ok: false,
        foregroundGranted: false,
        backgroundGranted: false,
        precise: false,
        needsSettings: true,
        message:
          "El permiso de ubicacion esta bloqueado. Activalo en los ajustes del sistema.",
      };
    }
    foreground = await Location.requestForegroundPermissionsAsync();
    if (!foreground.granted) {
      await markPermissionsPrimed();
      return {
        ok: false,
        foregroundGranted: false,
        backgroundGranted: false,
        precise: false,
        needsSettings: !foreground.canAskAgain,
        message: foreground.canAskAgain
          ? "Se necesita el permiso de ubicacion para compartir tu posicion."
          : "Permiso de ubicacion bloqueado. Activalo en los ajustes del sistema.",
      };
    }
  }

  const precise = isPrecise(foreground);

  // 2) Ubicacion en segundo plano ("todo el tiempo").
  let background = await Location.getBackgroundPermissionsAsync();

  if (!background.granted && !primed) {
    // Solo se solicita la primera vez. En Android 11+ esto abre los ajustes.
    background = await Location.requestBackgroundPermissionsAsync();
  }

  await markPermissionsPrimed();
  await requestForegroundServiceNotification();

  if (!background.granted) {
    return {
      ok: false,
      foregroundGranted: true,
      backgroundGranted: false,
      precise,
      needsSettings: true,
      message:
        Platform.OS === "android"
          ? "Para compartir con la pantalla bloqueada, abre los ajustes de la app y elige 'Permitir todo el tiempo' en Ubicacion."
          : "Para compartir en segundo plano, abre los ajustes y selecciona 'Siempre' en Ubicacion.",
    };
  }

  return {
    ok: true,
    foregroundGranted: true,
    backgroundGranted: true,
    precise,
    needsSettings: false,
  };
}

// ---------------------------------------------------------------------------
// Camara y microfono (acceso remoto)
// ---------------------------------------------------------------------------

/** Sensor de medios, en el vocabulario de la pantalla. */
export type MediaSensor = "camera" | "microphone";

export interface MediaPermissionsSnapshot {
  camera: boolean;
  microphone: boolean;
  /** Ambos concedidos: se puede abrir una sesion de medios. */
  ready: boolean;
  /** Ya se gestionaron alguna vez (no se repite el dialogo del sistema). */
  primed: boolean;
  /** Hay algo bloqueado: solo se puede resolver desde los ajustes. */
  needsSettings: boolean;
}

export interface EnsureMediaResult {
  ok: boolean;
  /** Sensores que quedaron sin permiso. */
  denied: MediaSensor[];
  /** true cuando el usuario debe habilitarlos desde los ajustes del sistema. */
  needsSettings: boolean;
  message?: string;
}

const ANDROID_MEDIA_PERMISSIONS: Record<MediaSensor, string> = {
  camera: "android.permission.CAMERA",
  microphone: "android.permission.RECORD_AUDIO",
};

/** Tipo que espera `PermissionsAndroid`: el literal de permiso, no un string. */
type AndroidPermission = Parameters<typeof PermissionsAndroid.check>[0];

function androidPermission(media: MediaSensor): AndroidPermission {
  return ANDROID_MEDIA_PERMISSIONS[media] as AndroidPermission;
}

function sensorToMedia(sensor: RemoteSensor): MediaSensor[] {
  return sensorsOf(sensor).map((value) =>
    value === "CAMERA" ? "camera" : "microphone",
  );
}

/**
 * Estado de los permisos de camara y microfono, sin mostrar dialogos.
 *
 * En iOS se informa `ready: true` a proposito: alli el permiso lo gestiona el
 * propio sistema la primera vez que WebRTC pide el flujo, y iOS recuerda la
 * respuesta. Sin `expo-camera` no hay forma de consultarlo antes sin pedirlo.
 */
export async function readMediaPermissions(): Promise<MediaPermissionsSnapshot> {
  const primed = await loadMediaPermissionsPrimed();

  if (Platform.OS !== "android") {
    return {
      camera: true,
      microphone: true,
      ready: true,
      primed,
      needsSettings: false,
    };
  }

  const [camera, microphone] = await Promise.all([
    PermissionsAndroid.check(androidPermission("camera")).catch(() => false),
    PermissionsAndroid.check(androidPermission("microphone")).catch(
      () => false,
    ),
  ]);

  return {
    camera,
    microphone,
    ready: camera && microphone,
    primed,
    // Ya se pidio en el pasado y sigue denegado: insistir no sirve.
    needsSettings: primed && !(camera && microphone),
  };
}

/**
 * Asegura los permisos de camara/microfono para una sesion de medios.
 *
 * Regla de diseno (requisito explicito): **se piden una sola vez**. Si el
 * usuario ya los concedio, no se vuelve a mostrar ningun dialogo; si los
 * denego, no se insiste en bucle: se devuelve `needsSettings` para que la
 * pantalla ofrezca "Abrir ajustes".
 */
export async function ensureMediaPermissions(
  sensor: RemoteSensor,
): Promise<EnsureMediaResult> {
  const needed = sensorToMedia(sensor);

  // En iOS el dialogo lo dispara WebRTC al pedir el flujo, y el sistema recuerda
  // la respuesta: no hay nada que preguntar aqui.
  if (Platform.OS !== "android") {
    return { ok: true, denied: [], needsSettings: false };
  }

  const primed = await loadMediaPermissionsPrimed();
  const denied: MediaSensor[] = [];
  let needsSettings = false;

  for (const media of needed) {
    const permission = androidPermission(media);
    try {
      if (await PermissionsAndroid.check(permission)) continue;

      if (primed) {
        // Ya se pidio antes: no se repite el dialogo del sistema.
        denied.push(media);
        needsSettings = true;
        continue;
      }

      const result = await PermissionsAndroid.request(permission);
      if (result === PermissionsAndroid.RESULTS.GRANTED) continue;

      denied.push(media);
      if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
        needsSettings = true;
      }
    } catch {
      denied.push(media);
      needsSettings = true;
    }
  }

  if (denied.length === 0) {
    await markMediaPermissionsPrimed();
    return { ok: true, denied: [], needsSettings: false };
  }

  return {
    ok: false,
    denied,
    needsSettings,
    message: needsSettings
      ? "El acceso a camara o microfono esta bloqueado. Activalo en los ajustes del sistema para poder aceptar la solicitud."
      : "Sin permiso de camara o microfono no se puede abrir la sesion solicitada.",
  };
}
