import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";
import type { IngestLocationInput } from "@geo/shared";

/**
 * Metadatos opcionales que la app adjunta a cada coordenada.
 *
 * Se envian "si estan disponibles": son datos de contexto para el panel de
 * administracion (version de la app, version del sistema, estado del permiso de
 * ubicacion y nivel de bateria). El backend los acepta como opcionales y el
 * panel muestra "sin dato" cuando no llegan, en lugar de inventar un valor.
 *
 * El nivel de bateria permite al Superadministrador distinguir tres situaciones
 * que no son lo mismo: dispositivo transmitiendo, dispositivo con bateria baja
 * y dispositivo cuya ubicacion dejo de actualizarse.
 */
export type DeviceMetadata = Pick<
  IngestLocationInput,
  "appVersion" | "osVersion" | "permissionStatus" | "batteryLevel"
>;

/** Vocabulario estable del estado del permiso, entendido por el panel web. */
export type PermissionLevel =
  | "granted_background"
  | "granted_foreground"
  | "denied"
  | "undetermined";

/** Etiqueta de permiso que se envia al backend (columna `permission_status`). */
export function permissionStatusFor(
  foregroundGranted: boolean,
  backgroundGranted: boolean,
): PermissionLevel {
  if (backgroundGranted) return "granted_background";
  if (foregroundGranted) return "granted_foreground";
  return "denied";
}

function buildOsVersion(): string | undefined {
  const fallbackName = Platform.OS === "ios" ? "iOS" : "Android";
  const name = Device.osName ?? fallbackName;
  const version =
    Device.osVersion ??
    (typeof Platform.Version === "number" ||
    typeof Platform.Version === "string"
      ? String(Platform.Version)
      : undefined);

  const text = `${name} ${version ?? ""}`.trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Reune los metadatos disponibles en el dispositivo.
 *
 * `batteryPercent` es el nivel ya normalizado (0..100) o `null` si el sistema
 * no lo conoce. Se envia tal cual: el panel necesita poder distinguir un 4 %
 * real de un "sin dato".
 */
export function collectDeviceMetadata(
  permissionStatus?: string,
  batteryPercent?: number | null,
): DeviceMetadata {
  const appVersion = Constants.expoConfig?.version ?? null;
  const osVersion = buildOsVersion();

  return {
    ...(appVersion ? { appVersion } : {}),
    ...(osVersion ? { osVersion } : {}),
    ...(permissionStatus ? { permissionStatus } : {}),
    ...(batteryPercent === null || batteryPercent === undefined
      ? {}
      : { batteryLevel: Math.round(batteryPercent) }),
  };
}
