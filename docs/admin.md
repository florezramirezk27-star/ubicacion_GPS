# Panel de Superadministrador y geocodificacion inversa

Este documento describe dos funciones anadidas sobre la plataforma base:

1. el **panel de Superadministrador** (`GEOTRACK · ADMINISTRACION`), con vision
   global de dispositivos, mapa con circulos de incertidumbre, historial,
   gestion de cada equipo y auditoria de cada consulta;
2. la **geocodificacion inversa**, que traduce coordenadas a una direccion
   aproximada con cache y limitacion de ritmo.

## 1. Alcance honesto (leer antes que nada)

Ser Superadministrador **no** concede acceso ilimitado al telefono. El panel
muestra exclusivamente:

- las **coordenadas que cada dispositivo ha compartido** con autorizacion;
- los **metadatos que la app reporta** (version de app y de sistema, estado del
  permiso de ubicacion y, si estuviera disponible, nivel de bateria).

No accede a conversaciones, fotos, llamadas, contactos ni a la ubicacion sin
autorizacion. **No** permite localizar un telefono por su numero. La camara o el
microfono solo se abren con **consentimiento explicito** del usuario (ver
[`acceso-remoto.md`](acceso-remoto.md)), nunca en silencio. Un dato antiguo se
marca siempre como _datos antiguos_ o _desconectado_; nunca se presenta como
actual. Cada consulta de ficha o historial queda registrada en la auditoria.

Esta delimitacion es coherente con `docs/tiempo-real.md`, `docs/privacidad.md` y
`docs/seguridad.md`.

## 2. Roles

| Rol          | Alcance                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| `USER`       | Sus propios dispositivos y aquellos que otro usuario le autorice expresamente.   |
| `SUPERADMIN` | Vision global de todos los dispositivos, con gestion y auditoria de cada acceso. |

El rol viaja en el JWT de acceso y en `PublicUser.role`. Un token sin `role` se
trata como `USER` (nunca se eleva por omision).

### Como se otorga el rol

El rol se asigna mediante la lista de confianza del operador
`SUPERADMIN_EMAILS` (correos separados por coma). Se aplica en el **registro** y
en cada **inicio de sesion**: si el correo esta en la lista, la cuenta pasa a
`SUPERADMIN`; si no, a `USER`. Un usuario no puede auto-promocionarse desde la
API ni desde el panel.

```bash
# .env
SUPERADMIN_EMAILS=admin@geo.test,rector@universidad.edu.co
```

El gateway de administracion **vuelve a comprobar el rol contra la base de
datos** en cada conexion, de modo que revocar el privilegio surte efecto aunque
el token siga vigente.

## 3. API

Todas las rutas exigen el rol `SUPERADMIN` (guarda `AdminGuard`); con un usuario
normal responden `403`.

| Metodo y ruta                    | Que hace                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /admin/overview`            | Contadores: usuarios, dispositivos, en linea, compartiendo, alertas, sesiones activas |
| `GET /admin/devices`             | Lista global con ultima ubicacion, frescura y direccion (cache)                       |
| `GET /admin/devices/:id`         | Ficha ampliada con direccion (bajo demanda) e historial de sesiones — **auditada**    |
| `GET /admin/devices/:id/history` | Historial de puntos del dispositivo — **auditada**                                    |
| `POST /admin/devices/:id/revoke` | Revoca las sesiones de comparticion activas                                           |
| `DELETE /admin/devices/:id`      | Desvincula (elimina) el dispositivo y su historial                                    |
| `GET /admin/audit`               | Feed de eventos de seguridad, mas recientes primero                                   |

Filtros de `GET /admin/devices`: `platform` (`ANDROID`/`IOS`), `status`
(`CURRENT`/`STALE`/`OFFLINE`/`UNKNOWN`), `q` (nombre o correo del propietario),
`userId` y `limit` (1–500, por defecto 200).

`GET /admin/devices/:id` devuelve `AdminDeviceDetail`: los campos de la fila mas
`shares`, `locationCount`, `firstLocationAt` y `lastLocationAt`.

### Datos de contexto que envia la app

El esquema de ingesta `ingestLocationSchema` admite cuatro campos **opcionales**
que la app adjunta "si los tiene":

| Campo              | Ejemplo                | Uso en el panel                 |
| ------------------ | ---------------------- | ------------------------------- |
| `batteryLevel`     | `47`                   | Nivel de bateria (0–100)        |
| `appVersion`       | `"0.1.0"`              | Version de la app movil         |
| `osVersion`        | `"Android 9"`          | Version del sistema operativo   |
| `permissionStatus` | `"granted_foreground"` | Estado del permiso de ubicacion |

Si un campo no llega, el backend lo deja en `null` y el panel muestra "sin dato".
Nunca se inventa un valor. En esta compilacion la app reporta `appVersion`,
`osVersion` y `permissionStatus`; `batteryLevel` queda `null` porque requeriria el
modulo nativo `expo-battery` (ver 4).

## 4. Metadatos en la app movil

`apps/mobile/src/lib/device-metadata.ts` reune los metadatos disponibles:

- `appVersion` desde `expo-constants` (`Constants.expoConfig.version`);
- `osVersion` desde `expo-device` (`Device.osName` + `Device.osVersion`);
- `permissionStatus` a partir del permiso solicitado (`granted_foreground`,
  `denied`, ...).

`useTracking` guarda ese objeto una vez al iniciar y lo adjunta a **cada** envio.
Anadir bateria es inmediato: instalar `expo-battery`, leer el nivel en
`collectDeviceMetadata` y reconstruir el APK.

## 5. Tiempo real del panel

El panel usa un **namespace propio** de Socket.IO (`/admin`) para no mezclarse con
el seguimiento por dispositivo del namespace raiz. Es una sala unica a la que
solo entran administradores autenticados.

| Evento (servidor → panel) | Cuando                                             | Carga                         |
| ------------------------- | -------------------------------------------------- | ----------------------------- |
| `admin:ready`             | el token es valido **y** el rol es SUPERADMIN      | `{ userId, email }`           |
| `admin:error`             | token invalido o rol insuficiente                  | `{ message }`                 |
| `admin:location`          | cualquier dispositivo de la plataforma envia datos | `PublicLocation`              |
| `admin:device-status`     | cambia el estado de conexion de un dispositivo     | `{ deviceId, status, at }`    |
| `admin:device-change`     | cambio estructural (revocacion, baja)              | `{ deviceId, kind, at, ... }` |

`kind` es `device.updated`, `device.removed` o `share.changed`.

## 6. Geocodificacion inversa

Convertir coordenadas en una direccion legible es un servicio **externo**. El GPS
determina _donde_ esta el dispositivo; la geocodificacion traduce esa posicion a
una direccion aproximada (calle, numero, barrio). Que el proveedor devuelva el
nombre de una via **no** significa que el GPS conozca la puerta exacta: la
direccion es una estimacion.

### Configuracion

```bash
GEOCODING_PROVIDER=nominatim      # disabled | nominatim | google
GEOCODING_API_KEY=                # solo para google; se guarda SOLO en el backend
GEOCODING_BASE_URL=               # opcional (proveedor propio/compatible)
GEOCODING_TIMEOUT_MS=4000
GEOCODING_MIN_INTERVAL_MS=1100    # Nominatim: max 1 peticion/segundo
GEOCODING_CACHE_TTL_DAYS=30
GEOCODING_LANGUAGE=es
GEOCODING_USER_AGENT=geolocalizador-movil/0.1 (proyecto academico)
```

Por defecto se usa **Nominatim** (OpenStreetMap): sin clave y adecuado para un
proyecto academico. Google se admite con clave en el servidor; la clave **nunca**
llega al cliente.

### Cache y limitacion de ritmo

- Las coordenadas se redondean a 4 decimales (~11 m) como clave de cache
  (`roundForGeocode`). Asi miles de lecturas del mismo tramo reutilizan una sola
  consulta.
- La tabla `geocode_cache` guarda el resultado con marca de tiempo; se reutiliza
  mientras no supere `GEOCODING_CACHE_TTL_DAYS`.
- Los resultados **negativos** tambien se cachean (`found = false`): si el
  proveedor no tiene direccion para ese punto, no se vuelve a preguntar en cada
  lectura.
- Las llamadas al proveedor se **serializan** con un intervalo minimo
  (`GEOCODING_MIN_INTERVAL_MS`), para respetar los limites de uso y evitar
  bloqueos.

### Cuando se llama al proveedor

| Ruta                                  | Comportamiento                                      |
| ------------------------------------- | --------------------------------------------------- |
| `POST /locations` (ingesta)           | resuelve en segundo plano (no bloquea la respuesta) |
| `GET /admin/devices` (lista)          | **solo cache** (no genera trafico)                  |
| `GET /admin/devices/:id` (ficha)      | resuelve bajo demanda y rellena la cache            |
| `GET /locations/summaries` / `latest` | **solo cache**                                      |

### Limites honestos

- Si el proveedor esta `disabled`, no responde o no hay datos suficientes, la
  direccion queda en `null` y el panel lo dice: **nunca se inventa una
  direccion**.
- El redondeo a ~11 m implica que la direccion es del **tramo**, no de la puerta.
- Nominatim devuelve a veces toponimos administrativos ("UPZs de Bogota") cuando
  el punto cae entre vias.

## 7. Circulos de incertidumbre en el mapa

Cada marcador dibuja un circulo cuyo radio es `accuracyMeters` (la precision que
reporta el GPS). Un circulo grande significa **menos certeza** sobre la posicion
exacta. El color del punto refleja la frescura: verde `CURRENT`, ambar `STALE`,
rojo `OFFLINE`, gris `UNKNOWN`.

## 8. Auditoria administrativa

Cada consulta sensible deja rastro en `audit_logs` (actor, accion, IP y metadatos
cifrados):

| Accion                   | Cuando                                     |
| ------------------------ | ------------------------------------------ |
| `admin.device.view`      | se abre la ficha de un dispositivo         |
| `admin.history.view`     | se consulta el historial de un dispositivo |
| `admin.share.revoke_all` | se revocan las sesiones de un dispositivo  |
| `admin.device.unlink`    | se desvincula un dispositivo               |
| `remote.request.create`  | se solicita acceso a camara/microfono      |
| `remote.request.cancel`  | se cancela una solicitud de acceso         |
| `remote.request.accept`  | la persona acepta la solicitud en el movil |
| `remote.request.reject`  | la persona rechaza la solicitud en el movil |
| `remote.session.start`   | se abre una sesion de medios               |
| `remote.session.end`     | se cierra (administrador, usuario o sistema) |

El panel muestra ese feed en "Eventos de seguridad". La idea es que el
administrador **no pueda espiar en silencio**: queda constancia de quien miro que
y cuando.

## 9. Uso del panel web

1. Arranca la API y el panel (`pnpm dev:api`, `pnpm dev:web`).
2. Entra en `http://localhost:3000` con la cuenta de superadministrador creada por
   el seed: `admin@geo.test` / `Admin1234`.
3. El panel abre directamente en `/admin`
   (`http://localhost:3000/admin`).

Funciones:

- **Contadores**: usuarios, dispositivos, en linea, compartiendo, alertas y
  sesiones activas.
- **Lista global** con busqueda por nombre/correo y filtros por plataforma y
  estado; cada fila muestra propietario, direccion y bateria.
- **Mapa global** con todos los dispositivos, circulos de incertidumbre, leyenda
  por frescura, recorrido del dispositivo seleccionado y boton "Centrar".
- **Ficha** del dispositivo: coordenadas, precision, direccion aproximada,
  metadatos, historial de sesiones y acciones **Revocar acceso** y
  **Desvincular dispositivo**.
- **Historial** de puntos y **feed de auditoria**.

El Superadministrador tambien puede entrar al panel de usuario normal
(`/dashboard`) desde el enlace de la barra superior.

## 10. Verificacion automatizada

```bash
pnpm test:admin        # node scripts/check-admin.mjs
```

Comprueba, contra una API en marcha y sembrada (35 comprobaciones): rol
`SUPERADMIN` en la sesion, `403` para un usuario normal, autenticacion del
namespace `/admin`, difusion global de coordenadas (`admin:location` +
`admin:device-status`), los endpoints de consulta, la auditoria y que la
revocacion corta la ingesta con `403`.

## 11. Semilla de demostracion

`pnpm --filter @geo/api seed` crea, ademas del usuario `demo@geo.test`, la cuenta
`admin@geo.test` / `Admin1234` con rol `SUPERADMIN` y metadatos de ejemplo en los
dos dispositivos (version de app, sistema, bateria y permiso), para que el panel
tenga datos que mostrar.

## 12. Acceso remoto a camara y microfono

Desde la ficha de un dispositivo, el Superadministrador puede **solicitar** una
sesion de camara o microfono. Es la unica via por la que el panel llega a esos
sensores, y **no puede activarlos**: la persona debe aceptar de forma explicita
en su telefono, ve un aviso fijo con boton para cortar, y toda la operacion queda
auditada. La solicitud caduca sola si nadie responde (el silencio no es
consentimiento). Con la app cerrada no hay entrega.

Reglas, modelo de datos, senalizacion WebRTC y limites en
[`acceso-remoto.md`](acceso-remoto.md). Las acciones asociadas
(`remote.request.*`, `remote.session.*`) aparecen en el feed de "Eventos de
seguridad" descrito en la seccion 8.
