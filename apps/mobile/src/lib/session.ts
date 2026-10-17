import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import type { AuthResponse, PublicUser } from "@geo/shared";

/**
 * Almacenamiento de datos sensibles.
 *
 * En Android/iOS se usa `expo-secure-store` (Keystore / Keychain): los tokens
 * nunca quedan en texto plano en el almacenamiento normal de la app.
 * En web (solo para pruebas rapidas) se cae a `localStorage`, que no es seguro
 * y por eso no se recomienda para produccion.
 */

const KEY_SESSION = "geo.session";
const KEY_SERVER = "geo.serverUrl";
const KEY_SHARE = "geo.share";

const memoryFallback = new Map<string, string>();

async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      memoryFallback.set(key, value);
    }
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    try {
      return (
        globalThis.localStorage?.getItem(key) ?? memoryFallback.get(key) ?? null
      );
    } catch {
      return memoryFallback.get(key) ?? null;
    }
  }
  return SecureStore.getItemAsync(key);
}

async function deleteItem(key: string): Promise<void> {
  if (Platform.OS === "web") {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      /* ignorado */
    }
    memoryFallback.delete(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

export async function saveSession(
  response: AuthResponse,
): Promise<StoredSession> {
  const session: StoredSession = {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    user: response.user,
  };
  await persistSession(session);
  return session;
}

/** Guarda una sesion ya construida (por ejemplo tras renovar el token). */
export async function persistSession(session: StoredSession): Promise<void> {
  await setItem(KEY_SESSION, JSON.stringify(session));
}

export async function loadSession(): Promise<StoredSession | null> {
  const raw = await getItem(KEY_SESSION);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.accessToken || !parsed?.refreshToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await deleteItem(KEY_SESSION);
}

export async function saveServerUrl(url: string): Promise<void> {
  await setItem(KEY_SERVER, url);
}

export async function loadServerUrl(): Promise<string | null> {
  return getItem(KEY_SERVER);
}

export async function clearServerUrl(): Promise<void> {
  await deleteItem(KEY_SERVER);
}

/** Token de la sesion de comparticion activa (permite reanudar tras reiniciar). */
export interface StoredShare {
  shareId: string;
  deviceId: string;
  shareToken: string;
  expiresAt: string;
}

export async function saveShare(share: StoredShare): Promise<void> {
  await setItem(KEY_SHARE, JSON.stringify(share));
}

export async function loadShare(): Promise<StoredShare | null> {
  const raw = await getItem(KEY_SHARE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredShare;
  } catch {
    return null;
  }
}

export async function clearShare(): Promise<void> {
  await deleteItem(KEY_SHARE);
}
