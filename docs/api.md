# Referencia de la API

Base local: `http://localhost:3001`. Todas las rutas devuelven JSON.

## Convenciones

- **Autenticacion de usuario**: cabecera `Authorization: Bearer <accessToken>`.
  Todas las rutas la exigen salvo las marcadas como publicas.
- **Autenticacion de dispositivo**: cabecera `X-Share-Token: <token>` en la
  ingesta de coordenadas. Es independiente del JWT.
- **Validacion**: cada entrada se valida con los esquemas Zod de
  `@geo/shared`. Un dato invalido devuelve `400` con la lista de problemas.
- **Codigos**: `201` cuando se crea un recurso, `200` en acciones y consultas,
  `400` entrada invalida, `401` sin autenticar o token invalido, `403` sin
  permiso sobre el recurso o sesion de comparticion no utilizable,
  `404` recurso inexistente, `409` conflicto (por ejemplo correo repetido).
- **Errores**: `{ "statusCode": number, "message": string | string[], "error": string }`.

## Salud

### `GET /health`

Comprueba que la API y la base de datos responden. Es publico.

```json
{ "status": "ok", "database": "up", "timestamp": "2026-10-16T03:20:00.000Z" }
```

`status` es `ok` cuando la base de datos responde y `degraded` cuando no.

---

## Autenticacion

### `POST /auth/register` — publico

```json
{ "email": "ana@correo.com", "password": "Clave1234" }
```

La contrasena debe tener al menos 8 caracteres, una mayuscula, una minuscula y
un numero. Devuelve `201` con `AuthResponse`. `409` si el correo ya existe.

### `POST /auth/login` — publico

```json
{ "email": "ana@correo.com", "password": "Clave1234" }
```

Devuelve `200` con `AuthResponse`. `401` si las credenciales no son validas.
Cada inicio de sesion correcto queda registrado en la auditoria.

### `POST /auth/refresh` — publico

```json
{ "refreshToken": "..." }
```

Devuelve `200` con un par nuevo. El refresh token es **de un solo uso**: el
anterior queda invalidado en la misma operacion (rotacion). Reutilizarlo
devuelve `401`.

### `POST /auth/logout` — publico

```json
{ "refreshToken": "..." }
```

Cierra esa sesion. Es idempotente: si el token ya no existe, tambien responde
`200` con `{ "success": true }`.

### `GET /auth/me`

Devuelve el `PublicUser` del token:
`{ id, email, role, createdAt }`. `role` es `USER` o `SUPERADMIN`. Nunca incluye
el hash de la contrasena.

### `POST /auth/logout-all`

Cierra todas las sesiones activas del usuario autenticado. Devuelve
`{ "revoked": number }`.

### `GET /auth/audit?limit=50`

Eventos de auditoria del propio usuario, mas recientes primero. Los metadatos se
guardan cifrados y se descifran al leerlos.

`limit` es opcional y por defecto 50. **No hay tope superior**: un valor positivo
arbitrario se usa tal cual (limitacion conocida, ver
[`seguridad.md`](seguridad.md)).

Acciones que se registran actualmente:

| Accion              | Cuando                             | `metadata`                                                          |
| ------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| `auth.register`     | se crea una cuenta                 | `{ email }`                                                         |
| `auth.login`        | inicio de sesion correcto          | `{ userAgent }`                                                     |
| `auth.login_failed` | credenciales invalidas             | `{ email, reason }` (`usuario_no_existe` o `contrasena_incorrecta`) |
| `share.start`       | se abre una sesion de comparticion | `{ shareId, deviceId, expiresInMinutes }`                           |
| `share.stop`        | el usuario detiene la comparticion | `{ shareId, deviceId, reason }`                                     |
| `share.revoke`      | se revoca la comparticion          | `{ shareId, deviceId, reason }`                                     |

Los intentos fallidos de inicio de sesion se registran **sin** actor cuando el
correo no existe (no hay usuario al que asociarlos) y **con** actor cuando la
contrasena es incorrecta.

```json
[
  {
    "id": "cm...",
    "actorId": "cm...",
    "action": "share.start",
    "metadata": {
      "shareId": "cm...",
      "deviceId": "cm...",
      "expiresInMinutes": 60
    },
    "ip": "190.0.0.12",
    "createdAt": "2026-10-16T03:19:44.272Z"
  }
]
```

> El ciclo de vida de los dispositivos (crear, renombrar, eliminar) y cada
> coordenada ingerida **no** se registran hoy en la auditoria. El motivo y la
> recomendacion estan en [`seguridad.md`](seguridad.md).

---

## Dispositivos

### `POST /devices`

```json
{ "platform": "ANDROID", "deviceName": "Pixel de Ana" }
```

`platform` es `ANDROID` o `IOS`. Devuelve `201` con `PublicDevice`.

### `GET /devices`

Lista los dispositivos del usuario autenticado.

### `GET /devices/:id`

Detalle de un dispositivo propio. `404` si no existe o si pertenece a otra
cuenta (no se filtra su existencia).

### `PATCH /devices/:id`

```json
{ "deviceName": "Pixel nuevo nombre" }
```

### `DELETE /devices/:id`

Elimina el dispositivo y, en cascada, sus sesiones y ubicaciones. Devuelve
`{ "success": true }`.

`PublicDevice`:

```json
{
  "id": "cm...",
  "userId": "cm...",
  "platform": "ANDROID",
  "deviceName": "Pixel de Ana",
  "lastSeenAt": "2026-10-16T03:20:00.000Z",
  "createdAt": "2026-10-15T10:00:00.000Z"
}
```

---

## Sesiones de comparticion

Una sesion autoriza a un dispositivo concreto a enviar coordenadas durante un
tiempo limitado. **Solo puede haber una sesion activa por dispositivo**: al
iniciar una nueva, la anterior pasa a `STOPPED` con el motivo
`"Reemplazada por una nueva sesion de comparticion"`.

### `POST /shares`

```json
{ "deviceId": "cm...", "expiresInMinutes": 60 }
```

`expiresInMinutes` es opcional (5 a 1440, por defecto 60). Devuelve `201` con
`CreatedLocationShare`. El campo **`shareToken` se devuelve una sola vez**: el
servidor guarda unicamente su hash SHA-256. Si se pierde, hay que abrir otra
sesion.

```json
{
  "id": "cm...",
  "deviceId": "cm...",
  "status": "ACTIVE",
  "startedAt": "2026-10-16T03:00:00.000Z",
  "expiresAt": "2026-10-16T04:00:00.000Z",
  "stoppedAt": null,
  "revokedAt": null,
  "shareToken": "4f3a...c9"
}
```

### `GET /shares?deviceId=cm...`

Historial de sesiones de ese dispositivo, mas recientes primero.

### `GET /shares/:id`

Detalle de una sesion propia. Nunca incluye el token.

### `POST /shares/:id/stop`

```json
{ "reason": "El usuario detuvo la comparticion" }
```

`reason` es opcional (maximo 280 caracteres) y queda en la auditoria. Devuelve
`200` con el estado `STOPPED`. A partir de ese momento la ingesta se rechaza con
`403`.

### `POST /shares/:id/revoke`

Igual que `stop`, pero deja el estado `REVOKED`. Se usa para un corte inmediato
ante una sospecha de abuso. Devuelve `200`.

---

## Ubicaciones

### `POST /locations` — token de comparticion

No usa JWT. Se autentica con `X-Share-Token`. Es la ruta que llama la app movil.

```json
{
  "latitude": 4.6768,
  "longitude": -74.0482,
  "accuracyMeters": 9.5,
  "altitudeMeters": 2551.3,
  "speedMps": 1.4,
  "headingDegrees": 90,
  "recordedAt": "2026-10-16T03:19:44.000Z"
}
```

- `latitude` y `longitude` son obligatorios y deben estar en rango fisico.
- `accuracyMeters` es obligatorio, no negativo y como maximo **5000**; un valor
  mayor indica una lectura poco fiable y se rechaza para no contaminar el
  historial.
- `altitudeMeters`, `speedMps` y `headingDegrees` admiten `null`.
- `recordedAt` es opcional (ISO 8601). Si se omite se usa la hora de recepcion.
  Se toleran hasta **60 segundos** de adelanto respecto al reloj del servidor.
- **Metadatos opcionales del dispositivo** (para el panel de administracion):
  `batteryLevel` (0–100), `appVersion`, `osVersion` y `permissionStatus`. Son
  todos opcionales; si se omiten, el panel muestra "sin dato" en lugar de un
  valor inventado. Ver [`admin.md`](admin.md).

Devuelve `201` con `PublicLocation`. La columna espacial `geog` de PostGIS es
interna y **nunca** se expone.

```json
{
  "id": "cm...",
  "deviceId": "cm...",
  "shareId": "cm...",
  "latitude": 4.6768,
  "longitude": -74.0482,
  "accuracyMeters": 9.5,
  "altitudeMeters": 2551.3,
  "speedMps": 1.4,
  "headingDegrees": 90,
  "recordedAt": "2026-10-16T03:19:44.000Z",
  "receivedAt": "2026-10-16T03:19:44.412Z"
}
```

**Errores**: `401` token ausente o invalido; `403` sesion detenida, revocada o
expirada; `400` coordenada o precision invalidas.

### `GET /locations/latest?deviceId=cm...`

Ultima ubicacion conocida de un dispositivo propio, con su clasificacion de
frescura.

```json
{
  "deviceId": "cm...",
  "lastLocation": { "...PublicLocation..." },
  "freshness": "CURRENT",
  "ageSeconds": 12
}
```

`freshness` es `CURRENT`, `STALE`, `OFFLINE` o `UNKNOWN` (ver
[`tiempo-real.md`](tiempo-real.md)). `lastLocation` es `null` y `ageSeconds`
tambien cuando el dispositivo nunca ha reportado.

### `GET /locations/summaries`

Igual que `latest`, pero para todos los dispositivos del usuario a la vez. Es la
consulta que usa el panel web para pintar la lista.

### `GET /locations/history?deviceId=cm...&from=...&to=...&limit=100`

Puntos de un dispositivo propio, mas recientes primero. `from` y `to` son
opcionales (ISO 8601), `limit` va de 1 a 1000 (por defecto 100).

### `GET /locations/nearby?latitude=4.67&longitude=-74.04&radiusMeters=5000&limit=100`

Consulta espacial real resuelta con PostGIS (`ST_DWithin` sobre la columna
`geography`, indexada con GIST). Devuelve los puntos del usuario dentro del
radio, ordenados por distancia.

`radiusMeters` por defecto 5000 (maximo 500000) y `limit` por defecto 100.

```json
[
  {
    "id": "cm...",
    "deviceId": "cm...",
    "latitude": 4.6768,
    "longitude": -74.0482,
    "accuracyMeters": 9.5,
    "recordedAt": "2026-10-16T03:19:44.000Z",
    "receivedAt": "2026-10-16T03:19:44.412Z",
    "distanceMeters": 143.7
  }
]
```

---

## Administracion (rol SUPERADMIN)

Todas estas rutas exigen el rol `SUPERADMIN`; con un usuario normal responden
`403`. Estan documentadas en detalle en [`admin.md`](admin.md).

| Metodo y ruta                     | Que hace                                                        |
| --------------------------------- | --------------------------------------------------------------- |
| `GET /admin/overview`             | Contadores globales (usuarios, dispositivos, en linea, alertas) |
| `GET /admin/devices`              | Lista global con ultima ubicacion, frescura y direccion (cache) |
| `GET /admin/devices/:id`          | Ficha ampliada (direccion bajo demanda) — **auditada**          |
| `GET /admin/devices/:id/history`  | Historial de puntos — **auditada**                              |
| `POST /admin/devices/:id/revoke`  | Revoca las sesiones de comparticion activas (`{ revoked }`)     |
| `DELETE /admin/devices/:id`       | Desvincula el dispositivo y su historial (`{ success: true }`)  |
| `GET /admin/audit?action=&limit=` | Feed de eventos de seguridad (auditoria administrativa)         |

Filtros de `GET /admin/devices`: `platform`, `status`, `q` (nombre o correo),
`userId` y `limit` (1–500, por defecto 200).

```json
// GET /admin/overview
{
  "totalUsers": 5,
  "totalDevices": 5,
  "onlineDevices": 1,
  "staleDevices": 1,
  "offlineDevices": 2,
  "unknownDevices": 1,
  "sharingDevices": 1,
  "activeShares": 1,
  "alerts": 3,
  "generatedAt": "2026-10-16T12:15:30.090Z"
}
```

---

## WebSocket (Socket.IO)

Mismo host y puerto que la API, en dos **namespaces**:

- el namespace raiz (`/`) para el seguimiento por dispositivo, y
- el namespace `/admin` para el panel de Superadministrador.

### Namespace raiz — seguimiento por dispositivo

El cliente se conecta enviando su token de acceso en el handshake:

```js
import { io } from "socket.io-client";

const socket = io("http://localhost:3001", {
  transports: ["websocket"],
  auth: { token: accessToken },
});
```

### Eventos que envia el servidor

| Evento              | Cuando                                    | Carga                      |
| ------------------- | ----------------------------------------- | -------------------------- |
| `live:ready`        | el token del handshake es valido          | `{ userId }`               |
| `live:error`        | token invalido o suscripcion no permitida | `{ message }`              |
| `live:subscribed`   | la suscripcion se acepto                  | `{ deviceId }`             |
| `live:unsubscribed` | la suscripcion se cancelo                 | `{ deviceId }`             |
| `location:update`   | se ingirio una coordenada del dispositivo | `PublicLocation`           |
| `device:status`     | cambio el estado de conexion              | `{ deviceId, status, at }` |

### Eventos que envia el cliente

| Evento               | Carga          | Efecto                                   |
| -------------------- | -------------- | ---------------------------------------- |
| `subscribe:device`   | `{ deviceId }` | une al cliente a la sala del dispositivo |
| `unsubscribe:device` | `{ deviceId }` | lo saca de la sala                       |

Antes de unir a la sala, el servidor comprueba contra la base de datos que el
usuario autenticado **sea el propietario** del dispositivo. Si no lo es, emite
`live:error` y no suscribe.

`device:status` vale `CONNECTED`, `STALE` u `OFFLINE`. Al recibir una coordenada
se emite `CONNECTED`; el panel pasa a `STALE`/`OFFLINE` por su cuenta segun la
politica de frescura.

### Ejemplo completo

```js
socket.on("live:ready", () => {
  socket.emit("subscribe:device", { deviceId });
});

socket.on("location:update", (location) => {
  // El marcador del mapa se mueve aqui, sin recargar la pagina.
  console.log(location.latitude, location.longitude, location.recordedAt);
});

socket.on("live:error", ({ message }) => console.warn(message));
```

### Namespace `/admin` — panel de Superadministrador

Conexion al namespace `/admin`, con el mismo access token en el handshake. El
servidor valida el token **y vuelve a comprobar el rol contra la base de datos**:
si el usuario no es `SUPERADMIN`, emite `admin:error` y cierra la conexion. No hay
que suscribirse a nada: al entrar se une a una unica sala global.

```js
const admin = io("http://localhost:3001/admin", {
  transports: ["websocket"],
  auth: { token: accessToken },
});
```

| Evento (servidor → panel) | Cuando                                             | Carga                         |
| ------------------------- | -------------------------------------------------- | ----------------------------- |
| `admin:ready`             | el token es valido **y** el rol es SUPERADMIN      | `{ userId, email }`           |
| `admin:error`             | token invalido o rol insuficiente                  | `{ message }`                 |
| `admin:location`          | cualquier dispositivo de la plataforma envia datos | `PublicLocation`              |
| `admin:device-status`     | cambia el estado de conexion de un dispositivo     | `{ deviceId, status, at }`    |
| `admin:device-change`     | cambio estructural (revocacion, baja)              | `{ deviceId, kind, at, ... }` |

`kind` de `admin:device-change` es `device.updated`, `device.removed` o
`share.changed`.
