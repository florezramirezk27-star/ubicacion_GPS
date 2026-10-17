#!/usr/bin/env node
/**
 * Verificacion end-to-end del seguimiento en vivo.
 *
 * Comprueba la cadena completa del requisito central:
 *
 *   movil  --HTTP POST /locations-->  API  --WebSocket location:update-->  panel
 *
 * Ademas valida las defensas del canal:
 *   - una conexion con token invalido se rechaza;
 *   - suscribirse a un dispositivo ajeno devuelve error;
 *   - tras detener la comparticion la ingesta se rechaza (403).
 *
 * Requisitos: API escuchando y base de datos migrada.
 * Uso:  node scripts/check-live.mjs
 */

import { io } from "socket.io-client";

const API_URL = process.env.API_URL ?? "http://localhost:3001";
const EMAIL = process.env.EMAIL ?? "demo@geo.test";
const PASSWORD = process.env.PASSWORD ?? "Demo1234";

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
function waitFor(socket, event, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout esperando el evento "${event}"`));
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

function connectSocket(token) {
  const socket = io(API_URL, {
    transports: ["websocket"],
    reconnection: false,
    auth: { token },
  });
  socket.on("connect_error", () => undefined);
  return socket;
}

const near = (a, b) => Math.abs(a - b) < 1e-6;

async function main() {
  console.log(`\nVerificacion en vivo contra ${API_URL}\n`);

  // 1. Sesion ---------------------------------------------------------------
  const auth = await api("/auth/login", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  });
  check("inicio de sesion 200", auth.status === 200, `status=${auth.status}`);
  const accessToken = auth.body?.accessToken;
  check("se obtuvo access token", typeof accessToken === "string" && accessToken.length > 20);

  const devices = await api("/devices", { token: accessToken });
  const device = devices.body?.[0];
  check(
    "la cuenta tiene al menos un dispositivo",
    Boolean(device),
    JSON.stringify(devices.body).slice(0, 160),
  );
  if (!device) throw new Error("Sin dispositivos: ejecuta el seed primero.");

  // 2. Canal en vivo: token invalido ---------------------------------------
  console.log("\nAutenticacion del canal WebSocket");
  const badSocket = connectSocket("token.invalido");
  const badError = await waitFor(badSocket, "live:error", () => true, 5000).catch(() => null);
  check("un token invalido recibe live:error", Boolean(badError), JSON.stringify(badError));
  badSocket.disconnect();

  // 3. Canal en vivo: suscripcion a dispositivo ajeno ----------------------
  const socket = connectSocket(accessToken);
  const ready = await waitFor(socket, "live:ready", () => true, 8000).catch(() => null);
  check("el token valido recibe live:ready", Boolean(ready), JSON.stringify(ready));

  const foreignSubscribe = waitFor(
    socket,
    "live:error",
    (payload) => /no encontrado/i.test(payload?.message ?? ""),
    5000,
  ).catch(() => null);
  socket.emit("subscribe:device", { deviceId: "dispositivo-inexistente" });
  const foreignError = await foreignSubscribe;
  check("suscripcion a un dispositivo ajeno devuelve error", Boolean(foreignError));

  // 4. Suscripcion al dispositivo propio -----------------------------------
  const subscribed = waitFor(
    socket,
    "live:subscribed",
    (payload) => payload?.deviceId === device.id,
    5000,
  ).catch(() => null);
  socket.emit("subscribe:device", { deviceId: device.id });
  const subscribeAck = await subscribed;
  check("suscripcion al dispositivo propio confirmada", Boolean(subscribeAck));

  // Recoge todo lo difundido para poder analizarlo despues.
  const received = [];
  const statuses = [];
  socket.on("location:update", (location) => received.push(location));
  socket.on("device:status", (status) => statuses.push(status));

  // 5. Ingesta y difusion en vivo -----------------------------------------
  console.log("\nIngesta HTTP -> difusion WebSocket");
  const share = await api("/shares", {
    method: "POST",
    token: accessToken,
    body: { deviceId: device.id, expiresInMinutes: 15 },
  });
  check("sesion de comparticion creada", share.status === 201, `status=${share.status}`);
  const shareId = share.body?.id;
  const shareToken = share.body?.shareToken;
  check("se recibio el token de comparticion", typeof shareToken === "string");

  const first = waitFor(
    socket,
    "location:update",
    (location) => near(location.latitude, 4.7001) && near(location.longitude, -74.0501),
    8000,
  ).catch(() => null);

  const ingestA = await api("/locations", {
    method: "POST",
    shareToken,
    body: {
      latitude: 4.7001,
      longitude: -74.0501,
      accuracyMeters: 9.5,
      speedMps: 1.4,
      headingDegrees: 90,
      recordedAt: new Date().toISOString(),
    },
  });
  check("POST /locations responde 201", ingestA.status === 201, `status=${ingestA.status}`);
  check(
    "la respuesta no filtra la columna geog de PostGIS",
    ingestA.body && !("geog" in ingestA.body),
    JSON.stringify(ingestA.body).slice(0, 160),
  );

  const liveA = await first;
  check("el panel recibe location:update (1a coordenada)", Boolean(liveA));
  check(
    "el evento corresponde al dispositivo suscrito",
    liveA?.deviceId === device.id,
    `deviceId=${liveA?.deviceId}`,
  );
  check("las coordenadas difundidas son exactas", near(liveA?.latitude ?? 0, 4.7001) && near(liveA?.longitude ?? 0, -74.0501));

  // 6. Segunda coordenada: el marcador se mueve ---------------------------
  const second = waitFor(
    socket,
    "location:update",
    (location) => near(location.latitude, 4.7003) && near(location.longitude, -74.0507),
    8000,
  ).catch(() => null);

  await api("/locations", {
    method: "POST",
    shareToken,
    body: {
      latitude: 4.7003,
      longitude: -74.0507,
      accuracyMeters: 7.2,
      recordedAt: new Date().toISOString(),
    },
  });

  const liveB = await second;
  check("el panel recibe la 2a coordenada (movimiento)", Boolean(liveB));

  // 7. Estado del dispositivo ---------------------------------------------
  let statusOk = statuses.some((status) => status.deviceId === device.id && status.status === "CONNECTED");
  for (let attempt = 0; attempt < 10 && !statusOk; attempt += 1) {
    await sleep(200);
    statusOk = statuses.some((status) => status.deviceId === device.id && status.status === "CONNECTED");
  }
  check("se difundio device:status = CONNECTED", statusOk, JSON.stringify(statuses.slice(0, 3)));

  // 8. Al detener la comparticion se bloquea la ingesta -------------------
  console.log("\nCorte de la comparticion");
  const stopped = await api(`/shares/${shareId}/stop`, {
    method: "POST",
    token: accessToken,
    body: { reason: "Verificacion automatica del canal en vivo" },
  });
  check("detener la sesion responde 200", stopped.status === 200, `status=${stopped.status}`);
  check("la sesion queda en estado STOPPED", stopped.body?.status === "STOPPED", `status=${stopped.body?.status}`);

  const afterStop = await api("/locations", {
    method: "POST",
    shareToken,
    body: { latitude: 4.71, longitude: -74.06, accuracyMeters: 12, recordedAt: new Date().toISOString() },
  });
  check(
    "tras detener la sesion la ingesta se rechaza con 403",
    afterStop.status === 403,
    `status=${afterStop.status}`,
  );

  socket.disconnect();

  // 9. Resumen -------------------------------------------------------------
  console.log(`\n${passed} correctas, ${failed} fallidas\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nError inesperado: ${error.message}`);
  process.exit(1);
});
