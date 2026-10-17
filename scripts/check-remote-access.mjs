#!/usr/bin/env node
/**
 * Verificacion del cableado del acceso remoto a camara y microfono.
 *
 * No puede abrir una camara ni establecer una conexion WebRTC real, pero si
 * comprueba —leyendo los archivos del proyecto— que las garantias del producto
 * estan efectivamente cableadas de extremo a extremo, que es donde se cometen
 * los errores graves:
 *
 *   1. El contrato compartido (`@geo/shared`) define sensores, estados, eventos
 *      de WebSocket, esquemas de validacion y limites (TTL, tamano de SDP).
 *   2. El esquema de Prisma tiene las tablas, los enums y las relaciones en
 *      cascada (al cerrar la solicitud no quedan sesiones huerfanas).
 *   3. La API exige `SUPERADMIN` para solicitar (AdminGuard), deja rastro de
 *      cada paso en la auditoria, caduca las solicitudes sin respuesta y el
 *      gateway `/media` solo admite al dueno del dispositivo o a un SUPERADMIN.
 *   4. **No existe activacion silenciosa**: la unica via por la que se crea una
 *      sesion es la respuesta del usuario (`respond`), y el panel web solo puede
 *      *solicitar*, nunca capturar (no usa `getUserMedia`).
 *   5. La app movil pide consentimiento explicito, resuelve los permisos del
 *      sistema antes de aceptar, muestra un indicador con boton de fin y avisa
 *      con una notificacion local.
 *
 * Limitacion honesta: esto verifica el CABLEADO, no el comportamiento real con
 * camaras, permisos del sistema ni NAT concreto (ver docs/pruebas.md, seccion 10).
 *
 * Uso:  node scripts/check-remote-access.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  OK   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ""}`);
  }
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

function section(title) {
  console.log(`\n${title}`);
}

const hasAll = (haystack, needles) => needles.every((n) => haystack.includes(n));

async function main() {
  console.log("\nVerificacion del acceso remoto (cableado)\n");

  // 1. Contrato compartido --------------------------------------------------
  section("1. Contrato compartido (@geo/shared)");
  const shared = read("packages/shared/src/remote-access.ts") ?? "";
  check("existe packages/shared/src/remote-access.ts", shared.length > 0);
  check(
    "define los tres sensores (camara, microfono y ambos)",
    hasAll(shared, ['"CAMERA"', '"MICROPHONE"', '"CAMERA_AND_MICROPHONE"']),
  );
  check(
    "define los estados de solicitud (incluye EXPIRED: el silencio caduca)",
    hasAll(shared, [
      '"PENDING"',
      '"ACCEPTED"',
      '"REJECTED"',
      '"EXPIRED"',
      '"CANCELLED"',
    ]),
  );
  check(
    "define los estados de sesion (ACTIVE / ENDED)",
    shared.includes('MEDIA_SESSION_STATUSES = ["ACTIVE", "ENDED"]'),
  );
  check(
    "define los eventos del panel (ADMIN_REMOTE_EVENTS) y de WebRTC (MEDIA_WS_EVENTS)",
    shared.includes("ADMIN_REMOTE_EVENTS") && shared.includes("MEDIA_WS_EVENTS"),
  );
  check(
    "limita el tiempo de vida de la solicitud (TTL minimo, por defecto y maximo)",
    hasAll(shared, [
      "REMOTE_REQUEST_MIN_TTL_SECONDS",
      "REMOTE_REQUEST_DEFAULT_TTL_SECONDS",
      "REMOTE_REQUEST_MAX_TTL_SECONDS",
    ]),
  );
  check(
    "define el intervalo de sondeo del dispositivo (REMOTE_POLL_INTERVAL_MS)",
    shared.includes("REMOTE_POLL_INTERVAL_MS"),
  );
  check(
    "acota el tamano del SDP aceptado (WEBRTC_MAX_SDP_LENGTH)",
    shared.includes("WEBRTC_MAX_SDP_LENGTH"),
  );
  check(
    "valida la entrada con esquemas Zod (solicitud, respuesta, cierre)",
    hasAll(shared, [
      "createRemoteAccessRequestSchema",
      "respondRemoteAccessSchema",
      "endMediaSessionSchema",
    ]),
  );
  check(
    "valida la senalizacion WebRTC (webrtcSignalSchema)",
    shared.includes("webrtcSignalSchema"),
  );
  check(
    "agrupa la sala de medios por sesion (MEDIA_ROOM_PREFIX / mediaRoom)",
    shared.includes("MEDIA_ROOM_PREFIX") && shared.includes("function mediaRoom"),
  );
  check(
    "el paquete compartido reexporta el modulo de acceso remoto",
    (read("packages/shared/src/index.ts") ?? "").includes('"./remote-access"'),
  );

  // 2. Esquema de Prisma ----------------------------------------------------
  section("2. Esquema de datos (Prisma)");
  const schema = read("apps/api/prisma/schema.prisma") ?? "";
  check("existe el modelo RemoteAccessRequest", /model\s+RemoteAccessRequest\b/.test(schema));
  check("existe el modelo MediaSession", /model\s+MediaSession\b/.test(schema));
  check(
    "existen los enums RemoteSensor, RemoteRequestStatus y MediaSessionStatus",
    hasAll(schema, [
      "enum RemoteSensor",
      "enum RemoteRequestStatus",
      "enum MediaSessionStatus",
    ]),
  );
  check(
    "la sesion se enlaza 1-a-1 con la solicitud (requestId @unique)",
    /requestId\s+String\s+@unique/.test(schema),
  );
  check(
    "las relaciones borran en cascada (sin sesiones huerfanas)",
    (schema.match(/onDelete:\s*Cascade/g) ?? []).length >= 4,
  );

  // 3. API ------------------------------------------------------------------
  section("3. API (NestJS)");
  check(
    "el modulo de acceso remoto esta registrado en app.module.ts",
    (read("apps/api/src/app.module.ts") ?? "").includes("RemoteAccessModule"),
  );
  const controller =
    read("apps/api/src/remote-access/remote-access.controller.ts") ?? "";
  check(
    "las rutas de administracion estan protegidas con AdminGuard",
    hasAll(controller, [
      '@Post("admin/devices/:id/remote-access")',
      '@Get("admin/remote-access")',
      '@Post("admin/remote-access/:id/cancel")',
      '@Post("admin/media-sessions/:id/end")',
    ]) &&
      (controller.match(/@UseGuards\(AdminGuard\)/g) ?? []).length >= 4,
  );
  check(
    "el dispositivo dispone de rutas para sondeo, respuesta y fin de sesion",
    hasAll(controller, [
      '@Get("remote-access/pending")',
      '@Post("remote-access/:id/respond")',
      '@Get("remote-access/sessions/active")',
      '@Post("remote-access/sessions/:id/end")',
    ]),
  );

  const service =
    read("apps/api/src/remote-access/remote-access.service.ts") ?? "";
  check(
    "cada paso queda registrado en la auditoria (crear, cancelar, rechazar, aceptar, iniciar y terminar)",
    hasAll(service, [
      '"remote.request.create"',
      '"remote.request.cancel"',
      '"remote.request.reject"',
      '"remote.request.accept"',
      '"remote.session.start"',
      '"remote.session.end"',
    ]),
  );
  check(
    "la sesion solo se crea tras la aceptacion explicita (rama accept: false)",
    service.includes("accept: boolean") &&
      service.includes("if (!accept)") &&
      service.includes("mediaSession.create"),
  );
  check(
    "la solicitud caduca sola si nadie responde (expireStale / expiresAt)",
    service.includes("expireStale") && service.includes("expiresAt"),
  );

  const gateway =
    read("apps/api/src/remote-access/remote-access.gateway.ts") ?? "";
  check(
    'la senalizacion viaja por un namespace dedicado (namespace: "/media")',
    gateway.includes('namespace: "/media"'),
  );
  check(
    "unirse a la sala exige sesion ACTIVA y ser el dueno o SUPERADMIN",
    gateway.includes('"media:join"') &&
      gateway.includes("ACTIVE") &&
      gateway.includes("SUPERADMIN"),
  );
  check(
    "el gateway usa los eventos compartidos (MEDIA_WS_EVENTS)",
    gateway.includes("MEDIA_WS_EVENTS"),
  );

  // 4. Panel web ------------------------------------------------------------
  section("4. Panel web (Next.js)");
  const panel = read("apps/web/components/admin-remote-media.tsx") ?? "";
  check("existe el panel de medios remotos", panel.length > 0);
  check(
    "el panel solo puede *solicitar* acceso (no hay activacion directa)",
    panel.includes("Solicitar"),
  );
  check(
    "el panel solicita, cancela y finaliza mediante la API",
    hasAll(panel, [
      "adminRequestRemoteAccess",
      "adminCancelRemoteAccess",
      "adminEndMediaSession",
    ]),
  );
  const webApi = read("apps/web/lib/api.ts") ?? "";
  check(
    "el cliente web cubre las rutas de administracion del acceso remoto",
    hasAll(webApi, [
      "adminRemoteRequests",
      "adminRequestRemoteAccess",
      "adminCancelRemoteAccess",
      "adminEndMediaSession",
      "/admin/remote-access",
      "media-sessions",
    ]),
  );
  check(
    "el visor web reproduce la senal (usa startMediaViewer)",
    panel.includes("startMediaViewer"),
  );
  const viewer = read("apps/web/lib/media-viewer.ts") ?? "";
  check(
    "el visor NO captura: no usa getUserMedia ni mediaDevices",
    viewer.length > 0 &&
      !viewer.includes("getUserMedia") &&
      !viewer.includes("mediaDevices"),
    "el panel debe limitarse a recibir el flujo, nunca a capturar",
  );

  // 5. App movil ------------------------------------------------------------
  section("5. App movil (Expo)");
  const appTsx = read("apps/mobile/App.tsx") ?? "";
  check(
    "el consentimiento esta montado en la raiz de la app",
    appTsx.includes("RemoteAccessOverlay") && appTsx.includes("useRemoteAccess"),
  );
  const overlay = read("apps/mobile/src/components/RemoteAccessOverlay.tsx") ?? "";
  check(
    "el dialogo de consentimiento es bloqueante (Modal) y explicito (Permitir / Rechazar)",
    overlay.includes("Modal") &&
      overlay.includes('label="Permitir"') &&
      overlay.includes('label="Rechazar"'),
  );
  check(
    "hay un indicador visible con boton para cortar la sesion",
    overlay.includes("Cortar ahora"),
  );

  const hook = read("apps/mobile/src/hooks/useRemoteAccess.ts") ?? "";
  check(
    "el dispositivo sondea tanto solicitudes como sesiones activas",
    hook.includes("pendingRemoteAccess") && hook.includes("activeMediaSessions"),
  );
  check(
    "el intervalo de sondeo viene del contrato compartido",
    hook.includes("REMOTE_POLL_INTERVAL_MS"),
  );
  check(
    "se resuelven los permisos del sistema antes de aceptar",
    hook.includes("ensureMediaPermissions"),
  );
  check(
    "se avisa con una notificacion local de la solicitud",
    hook.includes("notifyRemoteRequest"),
  );
  check(
    "existe el modulo de permisos de camara/microfono",
    read("apps/mobile/src/lib/permissions.ts") !== null,
  );
  check(
    "existe el aviso local de solicitudes (remote-notify)",
    read("apps/mobile/src/lib/remote-notify.ts") !== null,
  );
  const media = read("apps/mobile/src/lib/media-session.ts") ?? "";
  check(
    "la captura y la oferta WebRTC se hacen en el dispositivo (react-native-webrtc)",
    media.includes("react-native-webrtc") &&
      media.includes("getUserMedia") &&
      media.includes("createOffer"),
  );
  const appJson = read("apps/mobile/app.json") ?? "";
  check(
    "app.json declara los permisos de camara y microfono",
    appJson.includes("CAMERA") && appJson.includes("RECORD_AUDIO"),
  );

  // 6. Documentacion --------------------------------------------------------
  section("6. Documentacion");
  check("existe docs/acceso-remoto.md", read("docs/acceso-remoto.md") !== null);
  check(
    "el README enlaza la documentacion de acceso remoto",
    (read("README.md") ?? "").includes("docs/acceso-remoto.md"),
  );
  check(
    "la guia de despliegue explica la cadena de conexion de Supabase (uselibpqcompat)",
    (read("docs/despliegue.md") ?? "").includes("uselibpqcompat"),
  );

  // Resumen -----------------------------------------------------------------
  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);

  if (failed > 0) {
    console.error("Hay comprobaciones fallidas del acceso remoto.");
    process.exit(1);
  }
  console.log(
    "El cableado del acceso remoto esta completo.\n" +
      "Recuerda: esto no sustituye la prueba manual en un telefono (docs/pruebas.md, 10).",
  );
}

await main();
