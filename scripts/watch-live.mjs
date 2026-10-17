// Observador temporal de tiempo real: se suscribe por WebSocket al dispositivo
// y registra los eventos `location:update` / `device:status` que emite la API
// mientras el telefono real envia coordenadas. Uso: node scripts/watch-live.mjs
import { io } from "socket.io-client";

const API_URL = process.env.API_URL ?? "http://localhost:3001";
const DEVICE_ID = process.env.DEVICE_ID ?? "cmvabl6in0001gwj5222ziryb";
const DURATION_MS = Number(process.env.DURATION_MS ?? 75000);

const login = await fetch(`${API_URL}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "demo@geo.test", password: "Demo1234" }),
});

if (!login.ok) {
  console.log("[http] login fallo:", login.status, await login.text());
  process.exit(1);
}

const auth = await login.json();
console.log(
  "[http] login ok, accessToken presente:",
  typeof auth.accessToken === "string" && auth.accessToken.length > 20,
);

const socket = io(API_URL, {
  transports: ["websocket"],
  reconnection: false,
  auth: { token: auth.accessToken },
});

let updates = 0;
let statuses = 0;

socket.on("connect", () => console.log("[ws] conectado, id:", socket.id));
socket.on("connect_error", (error) =>
  console.log("[ws] connect_error:", error.message),
);
socket.on("live:ready", (payload) => {
  console.log("[ws] live:ready:", JSON.stringify(payload));
  socket.emit("subscribe:device", { deviceId: DEVICE_ID });
});
socket.on("live:subscribed", (payload) =>
  console.log("[ws] live:subscribed:", JSON.stringify(payload)),
);
socket.on("live:error", (payload) =>
  console.log("[ws] live:error:", JSON.stringify(payload)),
);
socket.on("location:update", (loc) => {
  updates += 1;
  console.log(
    `[ws] location:update #${updates}: lat=${loc.latitude} lon=${loc.longitude} accuracy=${loc.accuracyMeters}m recordedAt=${loc.recordedAt}`,
  );
});
socket.on("device:status", (status) => {
  statuses += 1;
  console.log(`[ws] device:status #${statuses}:`, JSON.stringify(status));
});

console.log(
  `Escuchando ${DURATION_MS / 1000}s al dispositivo ${DEVICE_ID} (envios cada 30 s)...`,
);

setTimeout(() => {
  console.log(
    `\nRESUMEN: location:update=${updates}, device:status=${statuses}`,
  );
  socket.close();
  process.exit(0);
}, DURATION_MS);
