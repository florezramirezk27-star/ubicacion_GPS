#!/usr/bin/env node
/**
 * Medicion de latencia del canal en vivo.
 *
 * Para el componente academico del proyecto se necesita un dato objetivo de
 * cuanto tarda una coordenada en llegar al observador. El requisito central es:
 *
 *   movil --HTTP POST /locations--> API --WebSocket location:update--> panel
 *
 * Este script mide, para cada punto enviado:
 *
 *   - latencia HTTP   : desde que se inicia el POST hasta que la API responde 201.
 *   - latencia de difusion : desde que la API responde hasta que el evento
 *     `location:update` llega al observador suscrito.
 *   - latencia extremo a extremo : la suma de las dos.
 *
 * La correlacion entre la peticion y el evento es exacta: se empareja por el
 * `id` que devuelve la API en el POST con el `id` del evento recibido, de modo
 * que no hay ambiguedad aunque lleguen varios puntos seguidos.
 *
 * Requisitos: API escuchando y base de datos migrada con el seed aplicado.
 *
 * Uso:
 *   node scripts/measure-latency.mjs
 *   COUNT=30 INTERVAL_MS=500 node scripts/measure-latency.mjs
 */

import { io } from "socket.io-client";

const API_URL = process.env.API_URL ?? "http://localhost:3001";
const EMAIL = process.env.EMAIL ?? "demo@geo.test";
const PASSWORD = process.env.PASSWORD ?? "Demo1234";
const COUNT = Number(process.env.COUNT ?? 20);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 800);

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

function waitFor(socket, event, predicate = () => true, timeoutMs = 8000) {
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

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    min: sorted[0],
    p50: pick(0.5),
    p90: pick(0.9),
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
  };
}

function format(label, value) {
  return `  ${label.padEnd(34)} ${value.toFixed(1).padStart(8)} ms`;
}

function report(name, values) {
  if (values.length === 0) {
    console.log(`\n${name}: sin muestras`);
    return null;
  }
  const s = stats(values);
  console.log(`\n${name} (n=${s.n})`);
  console.log(format("minimo", s.min));
  console.log(format("media", s.mean));
  console.log(format("mediana (p50)", s.p50));
  console.log(format("p90", s.p90));
  console.log(format("maximo", s.max));
  return s;
}

async function main() {
  console.log(`\nMedicion de latencia contra ${API_URL}`);
  console.log(`Puntos a enviar: ${COUNT} (cada ${INTERVAL_MS} ms)\n`);

  const auth = await api("/auth/login", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  });
  const accessToken = auth.body?.accessToken;
  if (!accessToken) throw new Error("No se pudo iniciar sesion. Ejecuta el seed primero.");

  const devices = await api("/devices", { token: accessToken });
  const device = devices.body?.[0];
  if (!device) throw new Error("La cuenta no tiene dispositivos.");

  const share = await api("/shares", {
    method: "POST",
    token: accessToken,
    body: { deviceId: device.id, expiresInMinutes: 15 },
  });
  if (share.status !== 201) throw new Error(`No se pudo abrir la sesion: status=${share.status}`);
  const { shareToken, id: shareId } = share.body;

  const socket = io(API_URL, {
    transports: ["websocket"],
    reconnection: false,
    auth: { token: accessToken },
  });
  socket.on("connect_error", () => undefined);

  await waitFor(socket, "live:ready", () => true, 10000);
  const subscribed = waitFor(
    socket,
    "live:subscribed",
    (payload) => payload?.deviceId === device.id,
    8000,
  );
  socket.emit("subscribe:device", { deviceId: device.id });
  await subscribed;

  // Importante: la API difunde el evento ANTES de responder al POST (emite y
  // luego devuelve el 201). Por eso no se puede esperar la respuesta para
  // empezar a escuchar: el evento ya habria pasado. Se guardan todos los
  // eventos recibidos y despues se emparejan por `id` con cada peticion.
  const arrivalTimes = new Map();
  socket.on("location:update", (location) => {
    arrivalTimes.set(location.id, performance.now());
  });

  const httpSamples = [];
  const broadcastSamples = [];
  const e2eSamples = [];

  // Recorrido circular suave alrededor del Parque de la 93 (Bogota).
  const centerLat = 4.6768;
  const centerLon = -74.0482;
  const radiusDeg = 0.0016;

  for (let i = 0; i < COUNT; i += 1) {
    const angle = (2 * Math.PI * i) / COUNT;
    const latitude = centerLat + radiusDeg * Math.sin(angle);
    const longitude = centerLon + radiusDeg * Math.cos(angle);

    const sendStart = performance.now();
    const response = await api("/locations", {
      method: "POST",
      shareToken,
      body: {
        latitude,
        longitude,
        accuracyMeters: 8 + Math.random() * 6,
        speedMps: 1.2,
        headingDegrees: (angle * 180) / Math.PI,
        recordedAt: new Date().toISOString(),
      },
    });
    const httpEnd = performance.now();

    if (response.status !== 201 || !response.body?.id) {
      console.warn(`  punto ${i + 1}: respuesta inesperada status=${response.status}`);
      continue;
    }

    const locationId = response.body.id;

    // El evento puede haber llegado ya (incluso antes de la respuesta): por eso
    // primero se consulta el buffer y solo se espera si todavia no esta.
    const deadline = httpEnd + 8000;
    while (!arrivalTimes.has(locationId) && performance.now() < deadline) {
      await sleep(2);
    }

    const receivedAt = arrivalTimes.get(locationId) ?? null;
    if (receivedAt !== null) {
      httpSamples.push(httpEnd - sendStart);
      broadcastSamples.push(receivedAt - httpEnd);
      e2eSamples.push(receivedAt - sendStart);
    } else {
      console.warn(`  punto ${i + 1}: no llego el evento location:update`);
    }
    arrivalTimes.delete(locationId);

    process.stdout.write(`\r  enviados: ${i + 1}/${COUNT}`);
    if (i < COUNT - 1) await sleep(INTERVAL_MS);
  }
  process.stdout.write("\n");

  socket.disconnect();

  await api(`/shares/${shareId}/stop`, {
    method: "POST",
    token: accessToken,
    body: { reason: "Fin de la medicion de latencia" },
  });

  console.log("\n=================== RESULTADOS ===================");
  report("Latencia HTTP (peticion -> respuesta 201)", httpSamples);
  report("Latencia de difusion (respuesta -> evento WebSocket)", broadcastSamples);
  report("Latencia extremo a extremo (peticion -> evento)", e2eSamples);
  console.log("\n==================================================");

  if (e2eSamples.length === 0) {
    console.error("\nNo se recogio ninguna muestra.");
    process.exit(1);
  }
  console.log(`\nMuestras validas: ${e2eSamples.length}/${COUNT}\n`);
}

main().catch((error) => {
  console.error(`\nError inesperado: ${error.message}`);
  process.exit(1);
});
