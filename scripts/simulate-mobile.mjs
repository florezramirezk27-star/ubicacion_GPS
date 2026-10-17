#!/usr/bin/env node
/**
 * Simulador de dispositivo movil.
 *
 * Reproduce exactamente lo que hara la app Expo cuando el usuario autoriza
 * compartir su ubicacion:
 *
 *   1. Inicia sesion con su cuenta.
 *   2. Elige un dispositivo vinculado.
 *   3. Abre una sesion de comparticion (POST /shares) y obtiene el token
 *      de un solo uso.
 *   4. Envia coordenadas periodicamente por HTTP con la cabecera
 *      `X-Share-Token`.
 *   5. Al terminar (o con Ctrl+C), detiene la sesion.
 *
 * Sirve para comprobar el tiempo real sin necesidad de un telefono: abre el
 * panel web, inicia la simulacion y observa como el marcador se mueve.
 *
 * Uso:
 *   node scripts/simulate-mobile.mjs
 *   STEPS=30 INTERVAL_MS=1500 DEVICE_NAME="Pixel de prueba" node scripts/simulate-mobile.mjs
 */

const API_URL = process.env.API_URL ?? "http://localhost:3001";
const EMAIL = process.env.EMAIL ?? "demo@geo.test";
const PASSWORD = process.env.PASSWORD ?? "Demo1234";
const DEVICE_NAME = process.env.DEVICE_NAME ?? null;
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 3000);
const STEPS = Number(process.env.STEPS ?? 20);
const DURATION_MINUTES = Number(process.env.DURATION_MINUTES ?? 60);
/** Radio del recorrido circular simulado, en metros. */
const RADIUS_METERS = Number(process.env.RADIUS_METERS ?? 180);
/**
 * Token de una sesion ya abierta desde el panel web. Si se indica, el script no
 * inicia sesion ni crea la comparticion: solo envia coordenadas.
 */
const EXISTING_SHARE_TOKEN = process.env.SHARE_TOKEN ?? null;

/** Centro de referencia: Parque de la 93, Bogota. */
const CENTER = { latitude: 4.6768, longitude: -74.0482 };

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

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "message" in payload
        ? JSON.stringify(payload.message)
        : String(payload);
    throw new Error(`${method} ${path} -> ${response.status} ${detail}`);
  }

  return payload;
}

/** Calcula un punto sobre el recorrido circular simulado. */
function pointAt(step) {
  const angle = (step / STEPS) * 2 * Math.PI;
  const latOffset = (RADIUS_METERS / 111_320) * Math.sin(angle);
  const lngOffset =
    (RADIUS_METERS / (111_320 * Math.cos((CENTER.latitude * Math.PI) / 180))) * Math.cos(angle);

  return {
    latitude: Number((CENTER.latitude + latOffset).toFixed(7)),
    longitude: Number((CENTER.longitude + lngOffset).toFixed(7)),
    // Precisión tipica de un GPS de telefono a cielo abierto.
    accuracyMeters: 6 + Math.random() * 10,
    altitudeMeters: 2550 + Math.random() * 6,
    // Velocidad de caminata (~1.4 m/s) con algo de ruido.
    speedMps: Number((1.2 + Math.random() * 0.5).toFixed(2)),
    headingDegrees: Number((((step / STEPS) * 360 + 90) % 360).toFixed(1)),
  };
}

let activeShareId = null;
let accessToken = null;

async function stopShare(reason) {
  if (!activeShareId || !accessToken) return;
  try {
    await api(`/shares/${activeShareId}/stop`, {
      method: "POST",
      token: accessToken,
      body: { reason },
    });
    console.log(`\nSesion de comparticion detenida (${reason}).`);
  } catch (error) {
    console.error(`No se pudo detener la sesion: ${error.message}`);
  } finally {
    activeShareId = null;
  }
}

async function main() {
  console.log(`\nSimulador de dispositivo movil -> ${API_URL}\n`);

  let shareToken = EXISTING_SHARE_TOKEN;

  if (shareToken) {
    // Se reutiliza una sesion abierta desde el panel: no se detiene al final.
    console.log("Usando el token de comparticion indicado en SHARE_TOKEN.");
  } else {
    // 1. Sesion -------------------------------------------------------------
    const auth = await api("/auth/login", {
      method: "POST",
      body: { email: EMAIL, password: PASSWORD },
    });
    accessToken = auth.accessToken;
    console.log(`Sesion iniciada como ${auth.user.email}`);

    // 2. Dispositivo --------------------------------------------------------
    const devices = await api("/devices", { token: accessToken });
    if (devices.length === 0) {
      throw new Error("La cuenta no tiene dispositivos vinculados. Crea uno en el panel web.");
    }

    const device = DEVICE_NAME
      ? devices.find((candidate) => candidate.deviceName === DEVICE_NAME)
      : devices[0];

    if (!device) {
      const names = devices.map((candidate) => candidate.deviceName).join(", ");
      throw new Error(`No existe un dispositivo llamado "${DEVICE_NAME}". Disponibles: ${names}`);
    }
    console.log(`Dispositivo: ${device.deviceName} (${device.platform})`);

    // 3. Sesion de comparticion --------------------------------------------
    const share = await api("/shares", {
      method: "POST",
      token: accessToken,
      body: { deviceId: device.id, expiresInMinutes: DURATION_MINUTES },
    });
    activeShareId = share.id;
    shareToken = share.shareToken;
    console.log(`Sesion de comparticion activa hasta ${share.expiresAt}`);
  }

  // 4. Envio de coordenadas -------------------------------------------------
  console.log(
    `\nEnviando ${STEPS} posiciones cada ${INTERVAL_MS} ms. Abre el panel para ver el movimiento.\n`,
  );

  for (let step = 0; step < STEPS; step += 1) {
    const point = pointAt(step);
    const stored = await api("/locations", {
      method: "POST",
      shareToken,
      body: { ...point, recordedAt: new Date().toISOString() },
    });

    const { latitude, longitude, accuracyMeters } = stored;
    console.log(
      `  [${String(step + 1).padStart(2, "0")}/${STEPS}] ` +
        `${latitude.toFixed(5)}, ${longitude.toFixed(5)}  ±${accuracyMeters.toFixed(1)} m`,
    );

    if (step < STEPS - 1) await sleep(INTERVAL_MS);
  }

  console.log("\nRecorrido completado.");
}

// Cierre ordenado: detiene la sesion para no dejar el dispositivo compartiendo.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void stopShare(`Simulacion interrumpida (${signal})`).then(() => process.exit(0));
  });
}

main()
  .then(() => stopShare("Recorrido de simulacion finalizado"))
  .catch((error) => {
    console.error(`\nError: ${error.message}`);
    return stopShare("Simulacion fallida").then(() => process.exit(1));
  });
