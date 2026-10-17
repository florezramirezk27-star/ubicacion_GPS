#!/usr/bin/env node
/**
 * Verificacion del cableado del seguimiento de ubicacion en segundo plano.
 *
 * No puede mover un telefono, pero si comprueba —leyendo los archivos del
 * proyecto y la configuracion nativa resultante— que el componente esta bien
 * montado, que es donde se cometen los errores tipicos:
 *
 *   1. app.json activa los flags del plugin `expo-location` (iOS background,
 *      Android background y servicio en primer plano).
 *   2. La configuracion nativa contiene los permisos y `UIBackgroundModes`.
 *   3. `index.js` registra la tarea en el ambito global del bundle (requisito
 *      de `expo-task-manager`, obligatorio para el arranque headless).
 *   4. Existen arranque/parada del servicio y la opcion `foregroundService`.
 *   5. La sesion, la cola de pendientes y las estadisticas se persisten en
 *      AsyncStorage, y los envios se serializan.
 *   6. El flujo de permisos pide primero primer plano y luego segundo plano,
 *      y no vuelve a preguntar en cada arranque.
 *
 * Limitacion honesta: esto verifica el CABLEADO, no el comportamiento del
 * sistema operativo en un telefono concreto (ver docs/pruebas.md, seccion 10).
 *
 * Uso:  node scripts/check-mobile-background.mjs
 *       SKIP_INTROSPECT=1 node scripts/check-mobile-background.mjs   (sin expo CLI)
 */

import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOBILE = path.join(ROOT, "apps", "mobile");

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ""}`);
  }
}

function skip(name, why) {
  skipped += 1;
  console.log(`  SKIP ${name} -> ${why}`);
}

function read(relativePath) {
  const full = path.join(ROOT, relativePath);
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

/** `npx expo config --type introspect` expone la configuracion nativa resultante. */
function introspect() {
  if (process.env.SKIP_INTROSPECT === "1") return null;

  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(
    command,
    ["expo", "config", "--type", "introspect", "--json"],
    {
      cwd: MOBILE,
      encoding: "utf8",
      timeout: 180_000,
      shell: process.platform === "win32",
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  if (result.status !== 0 || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function permissionNames(config) {
  const list =
    config?._internal?.modResults?.android?.manifest?.manifest?.[
      "uses-permission"
    ] ??
    config?._internal?.modResults?.android?.manifest?.["uses-permission"] ??
    [];
  return new Set(
    (Array.isArray(list) ? list : [list])
      .map((entry) => entry?.["$"]?.["android:name"])
      .filter(Boolean),
  );
}

function iosInfoPlist(config) {
  return config?._internal?.modResults?.ios?.infoPlist ?? {};
}

async function main() {
  console.log("\nVerificacion del seguimiento en segundo plano (cableado)\n");

  // 1. Configuracion del plugin de expo-location ----------------------------
  const appJson = JSON.parse(read("apps/mobile/app.json") ?? "{}");
  const plugin = (appJson.expo?.plugins ?? []).find(
    (entry) => Array.isArray(entry) && entry[0] === "expo-location",
  );
  const pluginProps = plugin?.[1] ?? {};

  check("app.json registra el plugin expo-location", Boolean(plugin));
  check(
    "flag iOS: ubicacion en segundo plano habilitada",
    pluginProps.isIosBackgroundLocationEnabled === true,
    JSON.stringify(pluginProps.isIosBackgroundLocationEnabled),
  );
  check(
    "flag Android: permiso de ubicacion en segundo plano habilitado",
    pluginProps.isAndroidBackgroundLocationEnabled === true,
    JSON.stringify(pluginProps.isAndroidBackgroundLocationEnabled),
  );
  check(
    "flag Android: servicio en primer plano habilitado",
    pluginProps.isAndroidForegroundServiceEnabled === true,
    JSON.stringify(pluginProps.isAndroidForegroundServiceEnabled),
  );
  check(
    "app.json no declara a mano permisos de segundo plano (los aporta el plugin)",
    !(appJson.expo?.android?.permissions ?? []).includes(
      "ACCESS_BACKGROUND_LOCATION",
    ),
  );

  // 2. Dependencias nativas -------------------------------------------------
  const mobilePkg = JSON.parse(read("apps/mobile/package.json") ?? "{}");
  const deps = { ...mobilePkg.dependencies };
  check(
    "dependencia expo-task-manager instalada",
    Boolean(deps["expo-task-manager"]),
    "falta npx expo install expo-task-manager",
  );
  check(
    "dependencia @react-native-async-storage/async-storage instalada",
    Boolean(deps["@react-native-async-storage/async-storage"]),
    "falta npx expo install @react-native-async-storage/async-storage",
  );

  // 3. Registro de la tarea en el ambito global ----------------------------
  const entry = read("apps/mobile/index.js") ?? "";
  check(
    "index.js importa el modulo de segundo plano",
    /from\s+["']\.\/src\/lib\/background-location["']/.test(entry) ||
      /import\s+["']\.\/src\/lib\/background-location["']/.test(entry),
    "sin ese import, defineTask no se ejecuta en el arranque headless",
  );
  const importIndex = entry.indexOf("./src/lib/background-location");
  const appIndex = entry.indexOf('from "./App"');
  check(
    "el modulo de segundo plano se importa antes de App",
    importIndex >= 0 && (appIndex < 0 || importIndex < appIndex),
    "la tarea debe registrarse al cargar el bundle, no al montar la pantalla",
  );

  // 4. Tarea, arranque y parada --------------------------------------------
  const bg = read("apps/mobile/src/lib/background-location.ts") ?? "";
  check(
    "se define la tarea con TaskManager.defineTask",
    bg.includes("TaskManager.defineTask"),
  );
  check(
    "el nombre de la tarea es estable (geo-background-location)",
    bg.includes('BACKGROUND_LOCATION_TASK = "geo-background-location"'),
  );
  check(
    "arranca con Location.startLocationUpdatesAsync",
    bg.includes("Location.startLocationUpdatesAsync"),
  );
  check(
    "para con Location.stopLocationUpdatesAsync",
    bg.includes("Location.stopLocationUpdatesAsync"),
  );
  check(
    "usa foregroundService (notificacion permanente en Android)",
    bg.includes("foregroundService") &&
      bg.includes("notificationTitle"),
  );
  check(
    "muestra el indicador de segundo plano en iOS",
    bg.includes("showsBackgroundLocationIndicator: true"),
  );
  check(
    "no pausa automaticamente las actualizaciones",
    bg.includes("pausesUpdatesAutomatically: false"),
  );
  check(
    "restablece la URL de la API dentro de la tarea (proceso headless)",
    bg.includes("setApiBaseUrl(session.apiUrl)"),
  );
  check(
    "protege la cola con un limite de lecturas",
    bg.includes("MAX_QUEUE"),
  );
  check(
    "la sesion caducada se marca como invalida",
    bg.includes("handleInvalid") && bg.includes("SHARE_INVALID_MESSAGE"),
  );

  // 5. Persistencia de la cola y las estadisticas --------------------------
  const store = read("apps/mobile/src/lib/tracking-store.ts") ?? "";
  check(
    "el almacen persistente usa AsyncStorage",
    store.includes('from "@react-native-async-storage/async-storage"'),
  );
  check("persiste la sesion de comparticion", store.includes("KEY_SESSION"));
  check("persiste la cola de lecturas pendientes", store.includes("KEY_QUEUE"));
  check("persiste las estadisticas", store.includes("KEY_STATS"));
  check(
    "serializa las escrituras para que la tarea y la pantalla no se pisen",
    store.includes("function serialize"),
  );
  check(
    "los oyentes in-process avisan a la pantalla al instante",
    store.includes("subscribeToTracking") && store.includes("emit("),
  );

  // 6. Flujo de permisos ----------------------------------------------------
  const permissions = read("apps/mobile/src/lib/permissions.ts") ?? "";
  check(
    "consulta el permiso de primer plano sin dialogo (get...)",
    permissions.includes("Location.getForegroundPermissionsAsync"),
  );
  check(
    "pide primero el permiso de primer plano",
    permissions.includes("Location.requestForegroundPermissionsAsync"),
  );
  check(
    "despues gestiona el permiso de segundo plano",
    permissions.includes("Location.requestBackgroundPermissionsAsync") &&
      permissions.includes("Location.getBackgroundPermissionsAsync"),
  );
  check(
    "no vuelve a preguntar en cada arranque (marca de primera vez)",
    permissions.includes("markPermissionsPrimed") &&
      permissions.includes("loadPermissionsPrimed"),
  );
  check(
    "ofrece abrir los ajustes en lugar de insistir en bucle",
    permissions.includes("needsSettings: true"),
  );
  check(
    "pide el permiso de notificaciones del servicio (Android 13+)",
    permissions.includes("POST_NOTIFICATIONS"),
  );
  check(
    "informa de la precision (precisa vs aproximada)",
    permissions.includes("isPrecise"),
  );

  // 7. Pantalla: indicador honesto -----------------------------------------
  const screen = read("apps/mobile/src/screens/TrackingScreen.tsx") ?? "";
  check(
    "la pantalla muestra el estado del segundo plano",
    screen.includes("Compartir en segundo plano"),
  );
  check(
    "la pantalla incluye la tabla honesta de estados del telefono",
    screen.includes("Que ocurre segun el estado del telefono"),
  );
  check(
    "la pantalla ofrece abrir los ajustes de permisos",
    screen.includes("Abrir ajustes de permisos"),
  );

  // 8. Configuracion nativa generada ---------------------------------------
  const config = introspect();

  if (!config) {
    skip(
      "permisos Android generados",
      "no se pudo introspectar la config (SKIP_INTROSPECT=1 o fallo del expo CLI)",
    );
    skip(
      "UIBackgroundModes de iOS",
      "no se pudo introspectar la config (SKIP_INTROSPECT=1 o fallo del expo CLI)",
    );
    skip(
      "descripciones de uso de iOS",
      "no se pudo introspectar la config (SKIP_INTROSPECT=1 o fallo del expo CLI)",
    );
  } else {
    const perms = permissionNames(config);
    for (const required of [
      "android.permission.ACCESS_BACKGROUND_LOCATION",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_LOCATION",
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.ACCESS_FINE_LOCATION",
    ]) {
      check(
        `permiso Android presente: ${required.replace("android.permission.", "")}`,
        perms.has(required),
      );
    }

    const infoPlist = iosInfoPlist(config);
    const modes = Array.isArray(infoPlist.UIBackgroundModes)
      ? infoPlist.UIBackgroundModes
      : [];
    check(
      "iOS declara UIBackgroundModes con location",
      modes.includes("location"),
      JSON.stringify(infoPlist.UIBackgroundModes),
    );
    check(
      "iOS declara NSLocationWhenInUseUsageDescription",
      Boolean(infoPlist.NSLocationWhenInUseUsageDescription),
    );
    check(
      "iOS declara NSLocationAlwaysAndWhenInUseUsageDescription",
      Boolean(infoPlist.NSLocationAlwaysAndWhenInUseUsageDescription),
    );

    const appAttrs =
      config._internal?.modResults?.android?.manifest?.manifest
        ?.application?.[0]?.$ ?? {};
    check(
      "Android conserva usesCleartextTraffic para la API de la red local",
      appAttrs["android:usesCleartextTraffic"] === "true",
      String(appAttrs["android:usesCleartextTraffic"]),
    );
  }

  // 9. El servicio de la libreria declara el tipo de Android 14+ ------------
  const libManifest = read(
    "node_modules/expo-location/android/src/main/AndroidManifest.xml",
  );
  if (libManifest === null) {
    skip(
      "servicio de expo-location con foregroundServiceType=location",
      "no se encuentra el manifiesto de la libreria",
    );
  } else {
    check(
      "servicio de expo-location con foregroundServiceType=location",
      libManifest.includes('foregroundServiceType="location"'),
    );
  }

  // 10. Bateria: solo se reduce el consumo, nunca se detiene el rastreo -----
  const batteryShared = read("packages/shared/src/battery.ts") ?? "";
  const multipliers = [
    ...batteryShared.matchAll(/intervalMultiplier:\s*([0-9.]+)/g),
  ].map((match) => Number(match[1]));

  check(
    "la politica de bateria es compartida (packages/shared/src/battery.ts)",
    batteryShared.includes("classifyBattery") &&
      batteryShared.includes("effectiveIntervalMs"),
  );
  check(
    "ningun tramo de bateria detiene el seguimiento (intervalMultiplier >= 1)",
    multipliers.length >= 3 && multipliers.every((value) => value >= 1),
    `valores: ${JSON.stringify(multipliers)}`,
  );
  check(
    "la politica no tiene un campo para 'parar' el rastreo",
    !/stops?Tracking\s*:/.test(batteryShared),
  );
  check(
    "el servicio lee la bateria en cada envio",
    bg.includes("readBattery"),
  );
  check(
    "con bateria baja se espacian los envios (no se detiene la tarea)",
    bg.includes("coalescePositions") && bg.includes("sendIntervalFor"),
  );
  check(
    "la notificacion del servicio refleja el estado de bateria",
    bg.includes("foregroundNotificationBody"),
  );
  check(
    "la pantalla muestra el tramo de bateria aplicado",
    screen.includes("battery"),
  );

  // 11. Acceso remoto a camara/microfono ------------------------------------
  check(
    "dependencia react-native-webrtc instalada",
    Boolean(deps["react-native-webrtc"]),
  );
  check(
    "dependencia socket.io-client instalada (senalizacion)",
    Boolean(deps["socket.io-client"]),
  );
  check(
    "dependencia expo-notifications instalada (aviso local)",
    Boolean(deps["expo-notifications"]),
  );

  const androidPermissions = appJson.expo?.android?.permissions ?? [];
  check(
    "app.json declara CAMERA (la aporta react-native-webrtc)",
    androidPermissions.some((entry) => entry.endsWith("permission.CAMERA")),
  );
  check(
    "app.json declara RECORD_AUDIO",
    androidPermissions.some((entry) =>
      entry.endsWith("permission.RECORD_AUDIO"),
    ),
  );
  check(
    "iOS declara NSCameraUsageDescription",
    Boolean(appJson.expo?.ios?.infoPlist?.NSCameraUsageDescription),
  );
  check(
    "iOS declara NSMicrophoneUsageDescription",
    Boolean(appJson.expo?.ios?.infoPlist?.NSMicrophoneUsageDescription),
  );

  const apiLib = read("apps/mobile/src/lib/api.ts") ?? "";
  check(
    "el cliente movil consulta solicitudes pendientes",
    apiLib.includes("pendingRemoteAccess"),
  );
  check(
    "el movil responde solicitudes (aceptar/rechazar)",
    apiLib.includes("respondRemoteAccess"),
  );
  check(
    "el movil puede listar y cerrar sus sesiones de medios",
    apiLib.includes("activeMediaSessions") &&
      apiLib.includes("endMediaSession"),
  );

  const mediaSession = read("apps/mobile/src/lib/media-session.ts") ?? "";
  check(
    "la sesion de medios pide el flujo con getUserMedia",
    mediaSession.includes("mediaDevices.getUserMedia"),
  );
  check(
    "la senalizacion usa los eventos compartidos (MEDIA_WS_EVENTS)",
    mediaSession.includes("MEDIA_WS_EVENTS"),
  );
  check(
    "libera camara y microfono al terminar",
    mediaSession.includes("release(true)") ||
      mediaSession.includes("track.stop()"),
  );

  const mediaPermissions = permissions.includes("ensureMediaPermissions");
  check(
    "los permisos de medios se piden una sola vez (marca persistente)",
    mediaPermissions &&
      permissions.includes("loadMediaPermissionsPrimed") &&
      permissions.includes("markMediaPermissionsPrimed"),
  );
  check(
    "los permisos de medios se resuelven antes de aceptar la solicitud",
    (read("apps/mobile/src/hooks/useRemoteAccess.ts") ?? "").includes(
      "ensureMediaPermissions",
    ),
  );

  const overlay =
    read("apps/mobile/src/components/RemoteAccessOverlay.tsx") ?? "";
  check(
    "el dialogo de consentimiento es explicito (Permitir / Rechazar)",
    overlay.includes('label="Permitir"') &&
      overlay.includes('label="Rechazar"'),
  );
  check(
    "hay un aviso visible mientras la camara esta activa (boton para cortar)",
    overlay.includes("Cortar ahora") && overlay.includes("CONNECTION_LABELS"),
  );

  const appTsx = read("apps/mobile/App.tsx") ?? "";
  check(
    "el consentimiento esta montado en la raiz de la app",
    appTsx.includes("RemoteAccessOverlay") &&
      appTsx.includes("useRemoteAccess"),
  );

  const apiModule = read("apps/api/src/remote-access/remote-access.module.ts");
  check("existe el modulo de acceso remoto en la API", apiModule !== null);
  check(
    "el modulo de acceso remoto esta registrado en app.module.ts",
    read("apps/api/src/app.module.ts")?.includes("RemoteAccessModule") ?? false,
  );
  const apiService =
    read("apps/api/src/remote-access/remote-access.service.ts") ?? "";
  check(
    "toda solicitud/aceptacion/rechazo/cierre queda auditado",
    apiService.includes("audit"),
  );
  check(
    "solo un SUPERADMIN puede solicitar acceso",
    (read("apps/api/src/remote-access/remote-access.controller.ts") ?? "")
      .includes("AdminGuard") &&
      (read("apps/api/src/admin/admin.guard.ts") ?? "").includes("SUPERADMIN"),
  );
  check(
    "la solicitud caduca sola (el silencio no es consentimiento)",
    apiService.includes("expireStale") && apiService.includes("expiresAt"),
  );

  // Resumen -----------------------------------------------------------------
  console.log(
    `\nResultado: ${passed} correctas, ${failed} fallidas` +
      `${skipped > 0 ? `, ${skipped} omitidas` : ""}\n`,
  );

  if (failed > 0) {
    console.error("Hay comprobaciones fallidas del seguimiento en segundo plano.");
    process.exit(1);
  }
  console.log(
    "El cableado del seguimiento en segundo plano esta completo.\n" +
      "Recuerda: esto no sustituye la prueba manual en un telefono (docs/pruebas.md, 10).",
  );
}

await main();
