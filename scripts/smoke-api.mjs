#!/usr/bin/env node
/**
 * Prueba de humo de la API (end-to-end).
 *
 * Recorre el flujo real completo: registro, sesion, dispositivo, sesion de
 * comparticion, ingesta de coordenadas, consultas, revocacion y auditoria.
 *
 * Requisitos: la API debe estar escuchando (por defecto http://localhost:3001)
 * y la base de datos migrada.
 *
 * Uso:  node scripts/smoke-api.mjs
 *       API_URL=http://localhost:3001 node scripts/smoke-api.mjs
 */

const API_URL = process.env.API_URL ?? "http://localhost:3001";

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

async function api(path, { method = "GET", token, shareToken, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (shareToken) headers["X-Share-Token"] = shareToken;

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { status: response.status, body: payload };
}

async function main() {
  console.log(`\nPrueba de humo contra ${API_URL}\n`);

  // 1. Salud ---------------------------------------------------------------
  console.log("Salud");
  const health = await api("/health");
  check("GET /health responde 200", health.status === 200, `status=${health.status}`);
  check("la base de datos esta arriba", health.body?.database === "up", JSON.stringify(health.body));

  // 2. Registro ------------------------------------------------------------
  console.log("\nAutenticacion");
  const email = `prueba_${Date.now()}@geo.test`;
  const password = "Prueba1234";

  const register = await api("/auth/register", {
    method: "POST",
    body: { email, password },
  });
  check("POST /auth/register crea la cuenta", register.status === 201, `status=${register.status}`);
  check("devuelve accessToken", typeof register.body?.accessToken === "string");
  check("devuelve refreshToken", typeof register.body?.refreshToken === "string");
  check("no expone el hash de contrasena", register.body?.user?.passwordHash === undefined);

  const accessToken = register.body?.accessToken;
  const refreshToken = register.body?.refreshToken;

  const weakPassword = await api("/auth/register", {
    method: "POST",
    body: { email: `otro_${Date.now()}@geo.test`, password: "debil" },
  });
  check("rechaza contrasena debil (400)", weakPassword.status === 400, `status=${weakPassword.status}`);

  const duplicate = await api("/auth/register", { method: "POST", body: { email, password } });
  check("rechaza correo duplicado (409)", duplicate.status === 409, `status=${duplicate.status}`);

  const me = await api("/auth/me", { token: accessToken });
  check("GET /auth/me devuelve el usuario", me.status === 200 && me.body?.email === email);

  const noToken = await api("/auth/me");
  check("GET /auth/me sin token responde 401", noToken.status === 401, `status=${noToken.status}`);

  const login = await api("/auth/login", { method: "POST", body: { email, password } });
  check("POST /auth/login funciona", login.status === 200, `status=${login.status}`);

  const badLogin = await api("/auth/login", {
    method: "POST",
    body: { email, password: "Incorrecta123" },
  });
  check("rechaza credenciales invalidas (401)", badLogin.status === 401, `status=${badLogin.status}`);

  const refreshed = await api("/auth/refresh", { method: "POST", body: { refreshToken } });
  check("POST /auth/refresh rota los tokens", refreshed.status === 200, `status=${refreshed.status}`);
  check("el refresh anterior queda invalidado (rotacion)", refreshed.body?.refreshToken !== refreshToken);

  const accessToken2 = refreshed.body?.accessToken ?? accessToken;

  // 3. Dispositivos --------------------------------------------------------
  console.log("\nDispositivos");
  const createdDevice = await api("/devices", {
    method: "POST",
    token: accessToken2,
    body: { platform: "ANDROID", deviceName: "Equipo de prueba" },
  });
  check("POST /devices vincula un dispositivo", createdDevice.status === 201, `status=${createdDevice.status}`);
  const deviceId = createdDevice.body?.id;

  const invalidPlatform = await api("/devices", {
    method: "POST",
    token: accessToken2,
    body: { platform: "WINDOWS", deviceName: "Invalido" },
  });
  check("rechaza plataforma invalida (400)", invalidPlatform.status === 400, `status=${invalidPlatform.status}`);

  const devices = await api("/devices", { token: accessToken2 });
  check("GET /devices lista el dispositivo", Array.isArray(devices.body) && devices.body.length === 1);

  // 4. Sesion de comparticion ---------------------------------------------
  console.log("\nSesion de comparticion");
  const share = await api("/shares", {
    method: "POST",
    token: accessToken2,
    body: { deviceId, expiresInMinutes: 30 },
  });
  check("POST /shares inicia la sesion", share.status === 201, `status=${share.status}`);
  check("devuelve el token una sola vez", typeof share.body?.shareToken === "string");
  check("la sesion nace ACTIVA", share.body?.status === "ACTIVE");
  const shareId = share.body?.id;
  const shareToken = share.body?.shareToken;

  // 5. Ingesta de coordenadas ---------------------------------------------
  console.log("\nIngesta de coordenadas");
  const ingest = await api("/locations", {
    method: "POST",
    shareToken,
    body: { latitude: 4.6533, longitude: -74.0836, accuracyMeters: 12 },
  });
  check("POST /locations guarda la coordenada", ingest.status === 201, `status=${ingest.status}`);
  check("no expone la columna espacial", ingest.body?.geog === undefined);

  const outOfRange = await api("/locations", {
    method: "POST",
    shareToken,
    body: { latitude: 120, longitude: -74, accuracyMeters: 10 },
  });
  check("rechaza latitud fuera de rango (400)", outOfRange.status === 400, `status=${outOfRange.status}`);

  const noShare = await api("/locations", {
    method: "POST",
    shareToken: "token_falso",
    body: { latitude: 4.65, longitude: -74.08, accuracyMeters: 10 },
  });
  check("rechaza token de comparticion invalido (401)", noShare.status === 401, `status=${noShare.status}`);

  // 6. Consultas -----------------------------------------------------------
  console.log("\nConsultas");
  const latest = await api(`/locations/latest?deviceId=${deviceId}`, { token: accessToken2 });
  check("GET /locations/latest devuelve el punto", latest.status === 200 && latest.body?.lastLocation != null);
  check("clasifica la frescura como CURRENT", latest.body?.freshness === "CURRENT", `freshness=${latest.body?.freshness}`);

  const history = await api(`/locations/history?deviceId=${deviceId}&limit=10`, { token: accessToken2 });
  check("GET /locations/history devuelve el historial", Array.isArray(history.body) && history.body.length >= 1);

  const nearby = await api(
    `/locations/nearby?latitude=4.6533&longitude=-74.0836&radiusMeters=2000`,
    { token: accessToken2 },
  );
  check("GET /locations/nearby (PostGIS) encuentra el punto", Array.isArray(nearby.body) && nearby.body.length >= 1, JSON.stringify(nearby.body).slice(0, 120));
  check("nearby incluye distancia en metros", typeof nearby.body?.[0]?.distanceMeters === "number");

  const summaries = await api("/locations/summaries", { token: accessToken2 });
  check("GET /locations/summaries responde", Array.isArray(summaries.body) && summaries.body.length === 1);

  // 7. Revocacion ----------------------------------------------------------
  console.log("\nRevocacion y auditoria");
  const stopped = await api(`/shares/${shareId}/stop`, {
    method: "POST",
    token: accessToken2,
    body: { reason: "Fin de la prueba" },
  });
  check("POST /shares/:id/stop detiene la sesion", stopped.status === 200, `status=${stopped.status}`);
  check("la sesion queda STOPPED", stopped.body?.status === "STOPPED");

  const ingestAfterStop = await api("/locations", {
    method: "POST",
    shareToken,
    body: { latitude: 4.66, longitude: -74.07, accuracyMeters: 10 },
  });
  check("ya no acepta coordenadas tras detener (403)", ingestAfterStop.status === 403, `status=${ingestAfterStop.status}`);

  const audit = await api("/auth/audit", { token: accessToken2 });
  const actions = Array.isArray(audit.body) ? audit.body.map((entry) => entry.action) : [];
  check("GET /auth/audit registra los eventos", actions.includes("auth.register") && actions.includes("share.start"), actions.join(","));
  check("los metadatos de auditoria se descifran", audit.body?.some((entry) => entry.metadata && typeof entry.metadata === "object"));

  // Resumen ----------------------------------------------------------------
  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nError inesperado durante la prueba:", error);
  process.exit(1);
});
