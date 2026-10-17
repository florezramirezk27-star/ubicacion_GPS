#!/usr/bin/env node
/**
 * Verificacion end-to-end del panel de Superadministrador.
 *
 * Comprueba, contra una API en marcha:
 *
 *   1. El rol SUPERADMIN llega en la sesion y el rol USER es el por defecto.
 *   2. Un usuario normal recibe 403 en /admin/*.
 *   3. El namespace WebSocket /admin autentica administradores y rechaza al resto.
 *   4. Una coordenada ingerida por la app se difunde al panel global
 *      (admin:location + admin:device-status).
 *   5. /admin/overview, /admin/devices (con filtros), /admin/devices/:id,
 *      /admin/devices/:id/history y /admin/audit responden con la forma esperada.
 *   6. Una consulta de ficha o historial deja rastro en la auditoria.
 *   7. Revocar el acceso corta la ingesta (403).
 *
 * Requisitos: API escuchando y base de datos migrada y sembrada.
 * Uso:  node scripts/check-admin.mjs
 */

import { io } from "socket.io-client";

const API_URL = process.env.API_URL ?? "http://localhost:3001";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@geo.test";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "Admin1234";
const USER_EMAIL = process.env.EMAIL ?? "demo@geo.test";
const USER_PASSWORD = process.env.PASSWORD ?? "Demo1234";

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, { method = "GET", token, shareToken, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (shareToken) headers["X-Share-Token"] = shareToken;

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { status: response.status, body: payload };
}

/** Espera un evento de Socket.IO que cumpla un predicado. */
function waitFor(socket, event, predicate = () => true, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout esperando "${event}"`));
    }, timeoutMs);

    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }

    socket.on(event, handler);
  });
}

/** Conexion al namespace /admin con el access token en el handshake. */
function connectAdmin(token) {
  const socket = io(`${API_URL}/admin`, {
    transports: ["websocket"],
    reconnection: false,
    auth: { token },
  });
  socket.on("connect_error", () => undefined);
  return socket;
}

const near = (a, b) => Math.abs(a - b) < 1e-6;

async function main() {
  console.log(`\nVerificacion del panel de administracion contra ${API_URL}\n`);

  // 1. Sesiones -------------------------------------------------------------
  const admin = await api("/auth/login", {
    method: "POST",
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  check(
    "login de administrador 200",
    admin.status === 200,
    `status=${admin.status}`,
  );
  const adminToken = admin.body?.accessToken;
  check(
    "la sesion de administrador expone el rol SUPERADMIN",
    admin.body?.user?.role === "SUPERADMIN",
    `role=${admin.body?.user?.role}`,
  );

  const user = await api("/auth/login", {
    method: "POST",
    body: { email: USER_EMAIL, password: USER_PASSWORD },
  });
  check(
    "login de usuario normal 200",
    user.status === 200,
    `status=${user.status}`,
  );
  const userToken = user.body?.accessToken;
  check(
    "el usuario normal tiene rol USER",
    user.body?.user?.role === "USER",
    `role=${user.body?.user?.role}`,
  );

  // 2. Autorizacion REST ----------------------------------------------------
  console.log("\nAutorizacion de las rutas /admin");
  const forbidden = await api("/admin/overview", { token: userToken });
  check(
    "un usuario normal recibe 403 en /admin/overview",
    forbidden.status === 403,
    `status=${forbidden.status}`,
  );
  const anonymous = await api("/admin/overview");
  check(
    "sin token se recibe 401",
    anonymous.status === 401,
    `status=${anonymous.status}`,
  );

  // 3. Autorizacion WebSocket ----------------------------------------------
  console.log("\nAutenticacion del namespace WebSocket /admin");
  const badSocket = connectAdmin("token.invalido");
  const badError = await waitFor(
    badSocket,
    "admin:error",
    () => true,
    5000,
  ).catch(() => null);
  check(
    "un token invalido recibe admin:error",
    Boolean(badError),
    JSON.stringify(badError),
  );
  badSocket.disconnect();

  const userSocket = connectAdmin(userToken);
  const userRejected = await waitFor(
    userSocket,
    "admin:error",
    () => true,
    5000,
  ).catch(() => null);
  check(
    "un usuario normal es rechazado del namespace /admin",
    Boolean(userRejected),
  );
  userSocket.disconnect();

  const adminSocket = connectAdmin(adminToken);
  const ready = await waitFor(
    adminSocket,
    "admin:ready",
    () => true,
    8000,
  ).catch(() => null);
  check(
    "el administrador recibe admin:ready",
    Boolean(ready),
    JSON.stringify(ready),
  );

  const locations = [];
  const statuses = [];
  adminSocket.on("admin:location", (payload) => locations.push(payload));
  adminSocket.on("admin:device-status", (payload) => statuses.push(payload));

  // 4. Difusion global ------------------------------------------------------
  console.log("\nDifusion global de coordenadas al panel de administracion");
  const devices = await api("/devices", { token: userToken });
  const device = devices.body?.[0];
  check("la cuenta de demostracion tiene un dispositivo", Boolean(device));
  if (!device) throw new Error("Sin dispositivos: ejecuta el seed primero.");

  const share = await api("/shares", {
    method: "POST",
    token: userToken,
    body: { deviceId: device.id, expiresInMinutes: 15 },
  });
  check(
    "sesion de comparticion creada",
    share.status === 201,
    `status=${share.status}`,
  );
  const shareId = share.body?.id;
  const shareToken = share.body?.shareToken;

  const globalsFirst = waitFor(
    adminSocket,
    "admin:location",
    (payload) =>
      near(payload.latitude, 4.7101) && near(payload.longitude, -74.0601),
    8000,
  ).catch(() => null);

  const ingest = await api("/locations", {
    method: "POST",
    shareToken,
    body: {
      latitude: 4.7101,
      longitude: -74.0601,
      accuracyMeters: 6.4,
      batteryLevel: 47,
      appVersion: "0.1.0",
      osVersion: "Android 9",
      permissionStatus: "granted_foreground",
      recordedAt: new Date().toISOString(),
    },
  });
  check(
    "la ingesta responde 201",
    ingest.status === 201,
    `status=${ingest.status}`,
  );

  const globalEvent = await globalsFirst;
  check(
    "el panel global recibe admin:location",
    Boolean(globalEvent),
    JSON.stringify(globalEvent),
  );
  check(
    "el evento global identifica el dispositivo correcto",
    globalEvent?.deviceId === device.id,
    `deviceId=${globalEvent?.deviceId}`,
  );

  let statusOk = statuses.some(
    (status) => status.deviceId === device.id && status.status === "CONNECTED",
  );
  for (let attempt = 0; attempt < 10 && !statusOk; attempt += 1) {
    await sleep(200);
    statusOk = statuses.some(
      (status) =>
        status.deviceId === device.id && status.status === "CONNECTED",
    );
  }
  check("el panel global recibe admin:device-status = CONNECTED", statusOk);

  // 5. Endpoints de consulta ------------------------------------------------
  console.log("\nConsultas del panel");
  const overview = await api("/admin/overview", { token: adminToken });
  check(
    "GET /admin/overview responde 200",
    overview.status === 200,
    `status=${overview.status}`,
  );
  check(
    "el resumen incluye los contadores esperados",
    typeof overview.body?.totalDevices === "number" &&
      typeof overview.body?.onlineDevices === "number" &&
      typeof overview.body?.activeShares === "number" &&
      typeof overview.body?.alerts === "number",
    JSON.stringify(overview.body),
  );

  const adminDevices = await api("/admin/devices", { token: adminToken });
  check(
    "GET /admin/devices responde 200",
    adminDevices.status === 200,
    `status=${adminDevices.status}`,
  );
  check(
    "el administrador ve el dispositivo del usuario",
    Array.isArray(adminDevices.body) &&
      adminDevices.body.some((entry) => entry.id === device.id),
    `count=${adminDevices.body?.length}`,
  );
  const row = adminDevices.body?.find((entry) => entry.id === device.id);
  check(
    "la fila trae propietario, plataforma y frescura",
    Boolean(row?.userEmail) &&
      Boolean(row?.platform) &&
      Boolean(row?.freshness),
    JSON.stringify(row).slice(0, 200),
  );
  check(
    "la fila reporta los metadatos enviados por la app",
    row?.batteryLevel === 47 &&
      row?.appVersion === "0.1.0" &&
      row?.osVersion === "Android 9",
    `battery=${row?.batteryLevel} app=${row?.appVersion} os=${row?.osVersion}`,
  );

  const filtered = await api(
    `/admin/devices?q=${encodeURIComponent("demo@geo.test")}`,
    {
      token: adminToken,
    },
  );
  check(
    "el filtro por correo acota los resultados",
    Array.isArray(filtered.body) &&
      filtered.body.length >= 1 &&
      filtered.body.every((entry) =>
        /demo@geo\.test/i.test(entry.userEmail ?? ""),
      ),
    `count=${filtered.body?.length}`,
  );

  const detail = await api(`/admin/devices/${device.id}`, {
    token: adminToken,
  });
  check(
    "GET /admin/devices/:id responde 200",
    detail.status === 200,
    `status=${detail.status}`,
  );
  check(
    "la ficha incluye historial de sesiones y numero de ubicaciones",
    Array.isArray(detail.body?.shares) &&
      typeof detail.body?.locationCount === "number" &&
      detail.body.locationCount >= 1,
    `locationCount=${detail.body?.locationCount}`,
  );
  check(
    "la ficha expone la propiedad address (direccion o null)",
    "address" in (detail.body ?? {}),
    JSON.stringify(detail.body?.address),
  );
  if (detail.body?.address) {
    check(
      "si hay direccion, viene con el formato esperado",
      typeof detail.body.address.formattedAddress === "string" &&
        detail.body.address.formattedAddress.length > 0,
      JSON.stringify(detail.body.address).slice(0, 160),
    );
  } else {
    console.log(
      "  NOTA sin direccion disponible (proveedor desactivado o sin red)",
    );
  }

  const history = await api(`/admin/devices/${device.id}/history?limit=5`, {
    token: adminToken,
  });
  check(
    "GET /admin/devices/:id/history responde 200",
    history.status === 200,
    `status=${history.status}`,
  );
  check(
    "el historial esta acotado por el limite",
    Array.isArray(history.body) &&
      history.body.length <= 5 &&
      history.body.length >= 1,
    `count=${history.body?.length}`,
  );

  const audit = await api("/admin/audit?limit=20", { token: adminToken });
  check(
    "GET /admin/audit responde 200",
    audit.status === 200,
    `status=${audit.status}`,
  );
  const actions = (audit.body ?? []).map((entry) => entry.action);
  check(
    "la auditoria registra la consulta de ficha",
    actions.includes("admin.device.view"),
    actions.join(","),
  );
  check(
    "la auditoria registra la consulta de historial",
    actions.includes("admin.history.view"),
    actions.join(","),
  );
  check(
    "las entradas de auditoria incluyen el correo del actor",
    (audit.body ?? []).some((entry) => entry.actorEmail === ADMIN_EMAIL),
  );

  // 6. Revocacion -----------------------------------------------------------
  console.log("\nRevocacion administrativa");
  const revoked = await api(`/admin/devices/${device.id}/revoke`, {
    method: "POST",
    token: adminToken,
    body: { reason: "Verificacion automatica del panel" },
  });
  check(
    "POST /admin/devices/:id/revoke responde 200",
    revoked.status === 200,
    `status=${revoked.status}`,
  );
  check(
    "se revoco al menos una sesion",
    revoked.body?.revoked >= 1,
    `revoked=${revoked.body?.revoked}`,
  );

  const afterRevoke = await api("/locations", {
    method: "POST",
    shareToken,
    body: {
      latitude: 4.72,
      longitude: -74.07,
      accuracyMeters: 10,
      recordedAt: new Date().toISOString(),
    },
  });
  check(
    "tras la revocacion la ingesta se rechaza con 403",
    afterRevoke.status === 403,
    `status=${afterRevoke.status}`,
  );

  adminSocket.disconnect();

  console.log(`\n${passed} correctas, ${failed} fallidas\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nError inesperado: ${error.message}`);
  process.exit(1);
});
