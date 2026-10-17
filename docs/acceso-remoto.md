# Acceso remoto a camara y microfono (con consentimiento)

Este documento describe la unica via por la que la plataforma puede llegar a la
camara o al microfono de un telefono: una **solicitud** del Superadministrador
que la persona duena del dispositivo debe **aceptar de forma explicita**. No
existe activacion silenciosa.

Es la contraparte de la geolocalizacion: alli el usuario comparte su posicion,
aqui decide si abre un sensor y por cuanto tiempo. Las dos cosas comparten el
mismo principio: **el dato sale del dispositivo porque la persona lo autoriza**,
no porque el administrador tenga poder sobre el equipo.

## 1. Alcance honesto (leer antes que nada)

- El administrador **solo puede solicitar**. No hay ningun boton ni ruta que
  encienda la camara sin que alguien pulse "Permitir" en el telefono.
- **El silencio no es consentimiento.** Toda solicitud lleva una validez
  (`expiresAt`); si nadie responde, caduca sola.
- Mientras el sensor esta activo, la persona ve un **aviso fijo** con un boton
  para **cortar al instante** desde su propio dispositivo.
- **Nada se graba.** El servidor solo reenvia la senalizacion WebRTC (SDP e
  ICE); el audio y el video viajan de extremo a extremo entre el telefono y el
  visor del panel.
- **Limite conocido**: con la app cerrada no hay entrega. El sondeo de
  solicitudes vive en la app movil, y el sistema operativo no permite abrir la
  camara desde fuera sin pasar por ella. Si se solicita con la app cerrada, la
  peticion queda registrada y caduca; al reabrir la app aparece si aun esta
  vigente.
- Esto es coherente con [`privacidad.md`](privacidad.md) y
  [`seguridad.md`](seguridad.md): el acceso remoto tambien queda auditado.

> La plataforma **no** obtiene la ubicacion de un dispositivo por su numero, ni
> accede a conversaciones, fotos o llamadas. El acceso remoto a sensores es un
> caso distinto y **voluntario**: es la persona la que abre la camara.

## 2. Reglas de diseno

El codigo esta escrito para que la funcion sea **imposible de ocultar**:

1. **Solo el SUPERADMIN puede crear una solicitud**, y crearla se registra en la
   auditoria (`remote.request.create`).
2. **La solicitud caduca sola** (`REMOTE_REQUEST_DEFAULT_TTL_SECONDS`, 120 s por
   defecto). El silencio nunca se interpreta como aceptacion.
3. **Solo el dueno del dispositivo puede aceptar**, y aceptar crea una sesion de
   medios que queda registrada (`remote.request.accept` + `remote.session.start`).
4. **Cualquier cierre deja constancia** de quien lo hizo y por que: el
   administrador, la persona desde el telefono, el propio dispositivo o el
   sistema (`remote.session.end`).
5. **Los permisos del sistema se piden una sola vez.** Si la persona los concedio
   antes, no se repite el dialogo; si los revoco, la app lo explica y ofrece
   "Abrir ajustes" en vez de insistir en bucle.
6. **El indicador es siempre visible.** Mientras la camara o el microfono estan
   activos, la app muestra una sesion en directo con el boton de cortar.

## 3. Flujo del dato

```
Administrador (panel)
  -> POST /admin/devices/:id/remote-access   { sensor, reason, ttlSeconds }
     -> se guarda RemoteAccessRequest (PENDING, expira en ttlSeconds)
        -> WebSocket admin:remote-request   -> resto de administradores
        -> (sondeo) GET /remote-access/pending en el telefono
           -> notificacion local + dialogo de consentimiento en la app
              -> POST /remote-access/:id/respond { accept: true }
                 -> se crea MediaSession (ACTIVE)
                    -> WebSocket admin:media-session
                       -> el telefono abre camara/microfono (WebRTC)
                          <-> senalizacion media:offer / answer / ice (namespace /media)
                             -> el panel ve el flujo en directo
                                -> cualquiera de los dos extremos puede cortar
                                   -> POST .../sessions/:id/end  (o media:end)
                                      -> MediaSession ENDED + auditoria
```

El telefono **no** mantiene un canal permanente de senalizacion: la solicitud se
descubre por sondeo HTTP ligero cada `REMOTE_POLL_INTERVAL_MS` (8 s) mientras la
app esta abierta. El WebSocket `/media` se abre solo para una sesion ya aceptada.

## 4. Modelo de datos

Dos entidades nuevas (ver [`modelo-datos.md`](modelo-datos.md)):

### `RemoteAccessRequest`

| Campo           | Tipo                  | Notas                                              |
| --------------- | --------------------- | -------------------------------------------------- |
| `id`            | `String` (cuid)       |                                                    |
| `deviceId`      | `String`              | dispositivo destino                                |
| `requestedById` | `String`              | administrador que la creo                          |
| `sensor`        | `RemoteSensor`        | `CAMERA`, `MICROPHONE` o `CAMERA_AND_MICROPHONE`   |
| `reason`        | `String?` (280)       | motivo que vera la persona                         |
| `status`        | `RemoteRequestStatus` | `PENDING`, `ACCEPTED`, `REJECTED`, `EXPIRED`, `CANCELLED` |
| `expiresAt`     | `DateTime`            | validez; al vencer pasa a `EXPIRED`                |
| `respondedAt`   | `DateTime?`           | cuando se resolvio                                 |
| `session`       | `MediaSession?`       | a lo sumo una sesion (relacion 1-1)                |

Como maximo puede haber **una solicitud `PENDING` por dispositivo**: al crear una
nueva se cancela la anterior.

### `MediaSession`

| Campo         | Tipo                 | Notas                                                 |
| ------------- | -------------------- | ----------------------------------------------------- |
| `id`          | `String` (cuid)      |                                                       |
| `requestId`   | `String` (unique)    | solicitud que la origino                              |
| `deviceId`    | `String`             | dispositivo que emite                                 |
| `sensor`      | `RemoteSensor`       |                                                       |
| `status`      | `MediaSessionStatus` | `ACTIVE` o `ENDED`                                    |
| `startedAt`   | `DateTime`           |                                                       |
| `endedAt`     | `DateTime?`          |                                                       |
| `endedBy`     | `String?`            | id del usuario que cerro, o `device` / `system`       |
| `endedReason` | `String?` (160)      | motivo textual del cierre                             |

Al eliminar el dispositivo, solicitudes y sesiones caen en cascada.

## 5. API

Estan en `apps/api/src/remote-access/`. Se agrupan en dos bloques dentro de un
mismo controlador para que se lea de un vistazo quien puede hacer que.

### Bloque del administrador (rol `SUPERADMIN`, guarda `AdminGuard`)

| Metodo y ruta                            | Que hace                                                        |
| ---------------------------------------- | --------------------------------------------------------------- |
| `POST /admin/devices/:id/remote-access`  | Crea la solicitud (`{ sensor, reason?, ttlSeconds? }`) → `201`   |
| `GET /admin/remote-access`               | Lista solicitudes (filtros `deviceId`, `status`, `limit`)        |
| `POST /admin/remote-access/:id/cancel`   | Cancela una solicitud `PENDING`                                  |
| `POST /admin/media-sessions/:id/end`     | Finaliza una sesion activa (`{ reason? }`)                      |

`ttlSeconds` va de 15 a 600 (por defecto 120). `reason` es opcional (3 a 280
caracteres) pero, si se escribe, se muestra tal cual en el telefono.

### Bloque del dispositivo (cualquier usuario autenticado, solo sus equipos)

| Metodo y ruta                              | Que hace                                                        |
| ------------------------------------------ | --------------------------------------------------------------- |
| `GET /remote-access/pending`               | Solicitudes `PENDING` y vigentes de sus dispositivos            |
| `POST /remote-access/:id/respond`          | Responde (`{ accept: boolean }`); `accept: true` abre la sesion |
| `GET /remote-access/sessions/active`       | Sesiones de medios abiertas en sus dispositivos                 |
| `POST /remote-access/sessions/:id/end`     | Corta una sesion desde el telefono (`{ reason? }`)              |

**No hay ninguna ruta que active la camara sin pasar por `respond` con
`accept: true`**, que es donde la persona da su consentimiento. El servicio
valida en cada caso que el usuario sea el dueno del dispositivo.

`PublicRemoteAccessRequest` (lo que ve el panel y la app):

```json
{
  "id": "cm...",
  "deviceId": "cm...",
  "deviceName": "Pixel de Ana",
  "sensor": "CAMERA",
  "status": "PENDING",
  "reason": "Verificar un incidente reportado",
  "requestedByEmail": "admin@geo.test",
  "expiresAt": "2026-10-16T12:17:30.000Z",
  "createdAt": "2026-10-16T12:15:30.000Z",
  "respondedAt": null,
  "session": null
}
```

**Errores**: `403` si no es administrador (bloque admin) o no es el dueno (bloque
dispositivo); `404` si la solicitud no existe; `409` si ya fue resuelta o la
sesion ya estaba cerrada; `410` (`Gone`) si la solicitud caduco antes de
responder.

## 6. Senalizacion WebRTC

El transporte de audio y video es **WebRTC de extremo a extremo**. El telefono es
la fuente y crea la oferta; el visor del panel responde. El servidor **no ve ni
almacena el contenido**: solo reenvia las senales por un namespace propio de
Socket.IO (`/media`) para no mezclarlas con el flujo de ubicacion.

Autorizacion por sesion:

- `media:join` comprueba que la sesion esta `ACTIVE` y que el cliente es el dueno
  del dispositivo o un `SUPERADMIN`.
- Cada reenvio se limita a salas en las que el cliente esta realmente unido, y
  solo mientras el servicio mantiene la sesion marcada como activa.

| Evento (cliente → servidor) | Carga                                   |
| --------------------------- | --------------------------------------- |
| `media:join`                | `{ sessionId }` (con acuse `media:joined`) |
| `media:offer`               | `{ sessionId, type: "offer", sdp }`     |
| `media:answer`              | `{ sessionId, type: "answer", sdp }`    |
| `media:ice`                 | `{ sessionId, type: "candidate", ... }` |
| `media:end`                 | `{ sessionId }`                         |

| Evento (servidor → cliente) | Cuando                                        |
| --------------------------- | --------------------------------------------- |
| `media:error`               | senal no valida, no unido o sesion no activa  |
| `media:end`                 | el servicio cerro la sesion (`session-ended`) |

La sala de cada sesion es `media:<sessionId>`. La oferta se reenvia cada pocos
segundos hasta recibir respuesta, de modo que si el administrador abre el visor
tarde, la conexion se completa igualmente. La configuracion ICE usa un STUN
publico (suficiente en la red de pruebas); si hiciera falta atravesar un NAT
simetrico habria que anadir un TURN propio.

El panel se entera de las solicitudes y sesiones por el namespace `/admin`
(eventos `admin:remote-request` y `admin:media-session`).

## 7. App movil

Archivos principales: `src/hooks/useRemoteAccess.ts`,
`src/components/RemoteAccessOverlay.tsx`, `src/lib/media-session.ts`,
`src/lib/permissions.ts`, `src/lib/remote-notify.ts`.

- **Descubrimiento**: sondeo HTTP de `pending` y `active` cada 8 s y al volver la
  app a primer plano. Una notificacion **local** avisa de cada solicitud nueva
  (canal de Android `acceso-remoto`). No usa push de terceros: por eso, con la
  app cerrada, no hay aviso.
- **Consentimiento**: cada solicitud abre un **dialogo bloqueante** con lo que se
  activaria ("Si aceptas, la camara se activara..."), el motivo y una cuenta
  atras. Se puede **posponer**, y entonces queda un aviso fijo hasta responder o
  hasta que caduque.
- **Permisos**: se resuelven **antes** de decirle al servidor que si. Si el
  sistema los bloquea, se rechaza de forma honesta y se ofrece "Abrir ajustes".
- **Indicador**: mientras emite, hay un aviso fijo ("Camara activa" /
  "Microfono activo") con el estado de la conexion y el boton "Cortar ahora".
- **Reanudar**: si la sesion ya fue aceptada pero la app se reinicio, aparece un
  aviso para reanudar (revalida permisos; nunca abre en silencio).
- **Corte por el servidor**: si el servidor deja de considerar la sesion activa
  (caducada o cerrada desde el panel), el telefono corta la captura en el
  siguiente sondeo.

## 8. Panel web

Componentes: `components/admin-remote-media.tsx` y `lib/media-viewer.ts`. Se
muestra dentro de la ficha de un dispositivo en `/admin`.

- **Solicitar** el sensor (camara, microfono o ambos), con validez (30/60/120/300
  s) y un motivo opcional.
- **Ver el estado** de la solicitud y el **flujo en directo** cuando la persona
  acepta, con boton de sonido (arranca en mudo por la politica de autoplay del
  navegador) y **Finalizar sesion**.
- **No puede activar nada**: no existe boton que encienda la camara sin
  aceptacion. Si nadie responde, la solicitud caduca.
- El visor **no pide camara ni microfono** en el navegador del administrador:
  solo visualiza lo que la persona acepto en su telefono.

## 9. Auditoria

Todas las acciones sensibles quedan en `audit_logs` (actor, accion, IP y
metadatos cifrados):

| Accion                    | Cuando                                        |
| ------------------------- | --------------------------------------------- |
| `remote.request.create`   | el administrador crea una solicitud           |
| `remote.request.cancel`   | el administrador cancela una solicitud        |
| `remote.request.accept`   | la persona acepta desde el telefono           |
| `remote.request.reject`   | la persona rechaza desde el telefono          |
| `remote.session.start`    | se abre la sesion de medios                   |
| `remote.session.end`      | se cierra (administrador, usuario, dispositivo o sistema) |

El feed "Eventos de seguridad" del panel muestra estas entradas junto con las
consultas administrativas.

## 10. Limites conocidos

- **Con la app cerrada no hay entrega.** El sistema operativo no permite abrir la
  camara de forma remota sin ejecutar codigo en el dispositivo; la solicitud
  queda registrada y caduca si nadie la ve a tiempo.
- **Sin TURN.** La configuracion ICE usa un STUN publico, suficiente en la red de
  pruebas; un NAT simetrico necesitaria un TURN propio.
- **iOS no permite consultar el permiso por adelantado** sin pedirlo: alli el
  dialogo lo dispara WebRTC la primera vez y el sistema recuerda la respuesta.
- Una sesion aceptada que nadie mira se cierra por caducidad del ticket de
  comparticion de la oferta (reintentos limitados) y desde el propio servidor si
  se finaliza.

## 11. Verificacion

No hay todavia un script automatizado especifico para el acceso remoto (el resto
de la plataforma si los tiene, ver [`pruebas.md`](pruebas.md)). Para comprobarlo
manualmente, con la API, el panel y un telefono (o emulador) en marcha:

1. Entra al panel como `admin@geo.test` / `Admin1234`, abre la ficha de un
   dispositivo y solicita camara o microfono.
2. En el telefono debe aparecer el dialogo de consentimiento y, si aceptas, el
   aviso fijo con "Cortar ahora"; en el panel se ve el flujo en directo.
3. Pulsa **Cortar ahora** en el telefono: el panel vuelve a "Sin sesion" y queda
   el evento `remote.session.end` en la auditoria.
4. Repite dejando caducar la solicitud sin responder: pasa a `EXPIRED` y no se
   abre nada.

## 12. Referencias

- [`seguridad.md`](seguridad.md) — contrasenas, sesiones, autorizacion y
  auditoria.
- [`privacidad.md`](privacidad.md) — Ley 1581 de 2012, finalidad y retencion.
- [`admin.md`](admin.md) — panel de Superadministrador.
- [`modelo-datos.md`](modelo-datos.md) — entidades y relaciones.
