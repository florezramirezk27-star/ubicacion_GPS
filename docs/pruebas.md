# Estrategia de pruebas

> Que se comprueba, como se ejecuta y que **no** esta cubierto todavia.

## Filosofia

El proyecto se verifica en cuatro niveles, de mas barato a mas realista:

| Nivel              | Que prueba                                              | Necesita                              | Coste    |
| ------------------ | ------------------------------------------------------- | ------------------------------------- | -------- |
| **Unitarias**      | Logica pura: cifrado, contrasenas, validacion, frescura | Nada (sin base de datos ni red)       | Segundos |
| **Humo de la API** | La API completa sobre HTTP real, con base de datos      | PostgreSQL + API en marcha            | Segundos |
| **Canal en vivo**  | Que una coordenada viaje de HTTP a WebSocket            | Lo anterior + un observador WebSocket | Segundos |
| **Manual**         | La app en un telefono, el mapa en un navegador          | Dispositivos reales                   | Minutos  |

La regla es: **lo que se puede automatizar, se automatiza**; lo que depende de
hardware o de la vista, se documenta como lista de comprobacion manual.

## Requisitos previos

Las pruebas unitarias no necesitan nada. Las otras tres necesitan la base de
datos migrada y sembrada, y la API escuchando:

```bash
pnpm db:up                 # contenedor PostGIS (host 5433)
pnpm prisma:migrate        # aplica migraciones
pnpm --filter @geo/api seed   # datos de demostracion
pnpm dev:api               # API en http://localhost:3001
```

> El seed crea `demo@geo.test` / `Demo1234` con dos dispositivos y un historial,
> y la cuenta de **Superadministrador** `admin@geo.test` / `Admin1234`.
> Los scripts de humo crean su **propio** usuario con un correo aleatorio, asi
> que no ensucian la cuenta de demostracion.

## 1. Pruebas unitarias (Jest)

```bash
pnpm test:unit
```

**Resultado actual: 5 suites, 50 pruebas, todas correctas.**

| Archivo                                        | Pruebas | Que fija                                                                                                                                                      |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/crypto/crypto.service.spec.ts`            | 13      | AES-256-GCM ida y vuelta, IV aleatorio, **deteccion de manipulacion**, rechazo de clave invalida, `sha256`, `randomToken`, comparacion en tiempo constante    |
| `src/auth/password.service.spec.ts`            | 7       | Formato `scrypt$N$r$p$salt$hash`, salt unico por hash, verificacion correcta/incorrecta, **normalizacion NFKC**, rechazo de valores malformados sin excepcion |
| `src/common/pipes/zod-validation.pipe.spec.ts` | 7       | Datos validos pasan, invalidos lanzan `BadRequestException` con campo y motivo, limites de precision y de fecha                                               |
| `src/locations/freshness.spec.ts`              | 15      | Politica de frescura (limites exactos de `CURRENT` / `STALE` / `OFFLINE` / `UNKNOWN`) y limites fisicos del esquema de ingesta                                |
| `src/geo/geocoding.parsers.spec.ts`            | 8       | Parseo de respuestas de Nominatim y Google a `GeocodedAddress`, caminos vacios, errores y campos faltantes (**nunca se rellena lo que no viene**)             |

### Por que `--experimental-vm-modules`

`@nestjs` 12 se publica como **ESM puro** (`"type": "module"`). Jest solo puede
cargar ESM de `node_modules` mediante el `require(esm)` nativo de Node, y eso
requiere que exista `vm.SourceTextModule`, que a su vez exige arrancar Node con
`--experimental-vm-modules`. Por eso el script no invoca `jest` directamente:

```json
"test": "node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config jest.config.js --runInBand"
```

Es una particularidad del entorno (Node 24 + Jest 30 + NestJS 12 ESM), no un
capricho de configuracion; esta anotada en `jest.config.js`.

## 2. Prueba de humo de la API

```bash
pnpm test:api
```

**Resultado actual: 35 comprobaciones, todas correctas.**

Recorre la API de punta a punta sobre HTTP real. Agrupadas por area:

| Area         | Comprueba                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Salud        | `GET /health` responde 200 y la base de datos esta arriba                                                                                     |
| Registro     | Crea la cuenta (201), devuelve `accessToken` y `refreshToken`, **no expone el hash**, rechaza contrasena debil (400) y correo duplicado (409) |
| Sesion       | `GET /auth/me` con y sin token (200 / 401), login correcto (200) e incorrecto (401)                                                           |
| Rotacion     | `POST /auth/refresh` rota los tokens y **el refresh anterior queda invalidado**                                                               |
| Dispositivos | Vinculacion (201), rechazo de plataforma invalida (400), listado                                                                              |
| Comparticion | Inicio (201), el token se devuelve **una sola vez**, nace `ACTIVE`                                                                            |
| Ingesta      | Guarda la coordenada (201), **no filtra la columna `geog`**, rechaza latitud fuera de rango (400) y token invalido (401)                      |
| Consulta     | `latest` (con frescura `CURRENT`), `history`, `nearby` (PostGIS, con distancia en metros), `summaries`                                        |
| Corte        | Detener responde 200, la sesion queda `STOPPED` y **la ingesta posterior se rechaza con 403**                                                 |
| Auditoria    | `GET /auth/audit` registra `auth.register` y `share.start`, y **los metadatos se descifran**                                                  |

## 3. Canal en vivo (HTTP -> WebSocket)

```bash
pnpm test:live
```

**Resultado actual: 19 comprobaciones, todas correctas.**

Verifica el requisito central del proyecto completo:

```
  movil --HTTP POST /locations--> API --WebSocket location:update--> panel
```

| Grupo                   | Comprueba                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Autenticacion del canal | Un token invalido recibe `live:error`; uno valido recibe `live:ready`                      |
| Autorizacion            | Suscribirse a un **dispositivo ajeno** devuelve error; al propio, confirmacion             |
| Difusion                | El panel recibe `location:update` con las **coordenadas exactas** y el `deviceId` correcto |
| Movimiento              | Una segunda coordenada llega y **el marcador se mueve**                                    |
| Estado                  | Se difunde `device:status = CONNECTED`                                                     |
| Corte                   | Tras detener la comparticion, la ingesta se rechaza con 403                                |

### 3.1 Panel de administracion y geocodificacion

```bash
pnpm test:admin
```

**Resultado actual: 35 comprobaciones, todas correctas.**

Verifica el requisito del Superadministrador de punta a punta, contra la API en
marcha y sembrada (`node scripts/check-admin.mjs`):

| Grupo           | Comprueba                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Rol             | La sesion del administrador expone `SUPERADMIN`; **un usuario normal recibe 403** y un anonimo **401** en `/admin/*`     |
| Canal `/admin`  | Namespace propio: token valido entra (`admin:ready`); un token **invalido** y el de un **usuario normal** son rechazados |
| Difusion global | Una coordenada ingerida llega a todos los administradores como `admin:location` y `admin:device-status = CONNECTED`      |
| Resumen         | `overview` 200 con los contadores reales (`totalDevices`, `onlineDevices`, `activeShares`, `alerts`)                     |
| Lista global    | `devices` 200, el administrador ve el dispositivo de otro usuario, con propietario, plataforma y frescura                |
| Metadatos       | La fila reporta lo que envio la app (bateria, version de app y de sistema)                                               |
| Filtros         | `?q=<correo>` acota los resultados a ese propietario                                                                     |
| Ficha           | `detail` 200 y **`address` presente** (direccion o `null`); si hay direccion, su `formattedAddress` no esta vacio        |
| Historial       | `history` 200 con los puntos del dispositivo                                                                             |
| Auditoria       | `admin.device.view` y `admin.history.view` quedan registrados con actor e IP                                             |
| Gestion         | `POST /revoke` 200 revoca al menos una sesion y **la ingesta posterior se rechaza con 403**                              |

**Geocodificacion (manual).** La presencia de la direccion depende del proveedor
(esta desactivado sin red), asi que `check-admin` solo comprueba que el campo
exista. La cache se verifico a mano: una primera `GET /admin/devices/:id` resuelve
la direccion con Nominatim y crea la fila en `geocode_cache`; una consulta
posterior a `GET /admin/devices` devuelve esa direccion **sin volver a llamar al
proveedor**.

### 3.2 Seguimiento en segundo plano (cableado)

```bash
pnpm test:background
```

`node scripts/check-mobile-background.mjs` no puede mover un telefono, pero si
comprueba —leyendo archivos— que el seguimiento en segundo plano esta **bien
cableado**, que es donde se cometen los errores tipicos:

| Grupo                | Comprueba                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| Configuracion nativa | `app.json` activa los flags del plugin `expo-location` (iOS background, Android background y foreground service) |
| Permisos generados   | La introspeccion de `expo prebuild` incluye `ACCESS_BACKGROUND_LOCATION`, `FOREGROUND_SERVICE(_LOCATION)` y `POST_NOTIFICATIONS` |
| iOS                  | `UIBackgroundModes` contiene `location`; existen las descripciones `NSLocation*UsageDescription`            |
| Registro de la tarea | `index.js` importa el modulo de segundo plano; existe `defineTask` y el nombre `geo-background-location`    |
| Arranque/parada      | `startLocationUpdatesAsync` lleva `foregroundService`; existe `stopLocationUpdatesAsync`                     |
| Cola persistente     | El almacen usa `AsyncStorage` y guarda sesion, cola y estadisticas; los envios se serializan                |
| Permisos de la app   | El flujo pide primero primer plano y luego segundo plano, y no re-pregunta tras la primera vez             |

**Limitacion honesta.** Esta prueba verifica el **cableado**, no el
comportamiento del sistema operativo en un telefono concreto. La captura con la
pantalla bloqueada y la cola sin conexion se comprueban a mano (ver la lista de
la seccion 10).

### 3.3 Acceso remoto a camara y microfono (cableado)

```bash
pnpm test:remote
```

`node scripts/check-remote-access.mjs` no puede abrir una camara ni establecer una
conexion WebRTC real, pero comprueba —leyendo archivos— que las garantias del
acceso remoto estan cableadas de extremo a extremo:

| Grupo                | Comprueba                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Contrato compartido  | `@geo/shared` define sensores, los cinco estados (incluido `EXPIRED`), eventos de WebSocket, esquemas Zod y limites (TTL y tamano de SDP) |
| Modelo de datos      | Prisma tiene `RemoteAccessRequest` y `MediaSession`, sus enums y las relaciones **en cascada** (`requestId @unique`) |
| Autorizacion         | Las rutas de administracion exigen `AdminGuard`; **audita** crear/cancelar/rechazar/aceptar/iniciar/terminar       |
| Sin activacion       | La sesion **solo** se crea tras la aceptacion (`accept: false` deja constancia); el panel web **no usa `getUserMedia`** |
| Caducidad y canal    | `expireStale` / `expiresAt`; el gateway `/media` exige sesion `ACTIVE` y ser el dueno o `SUPERADMIN`             |
| App movil            | Consentimiento bloqueante (Modal, Permitir/Rechazar), permisos resueltos antes de aceptar, aviso fijo y "Cortar ahora", notificacion local |

El script actual responde **46 comprobaciones, todas correctas**. Nota: parte del
cableado del lado del telefono ya estaba cubierto por `pnpm test:background`
(seccion 11 de ese script).

**Limitacion honesta.** Esto verifica el **cableado**; el flujo real (permisos del
sistema, WebRTC, NAT) se comprueba a mano con un telefono y un navegador (puntos 17
de la seccion 10).

## 4. Medicion de latencia

```bash
pnpm measure:latency
# o con parametros propios:
COUNT=50 INTERVAL_MS=250 pnpm measure:latency
```

Mide el tiempo que tarda una coordenada en ir de la peticion HTTP al evento
WebSocket, emparejando cada evento con su peticion por identificador. Los
resultados y su interpretacion estan en
[`investigacion.md`](investigacion.md); en resumen, decenas de milisegundos en
local, con el coste concentrado en el HTTP.

## 5. Simulador de dispositivo

```bash
pnpm simulate
# o reutilizando una sesion ya abierta:
SHARE_TOKEN=<token> node scripts/simulate-mobile.mjs
```

Simula un telefono recorriendo un circulo alrededor del Parque de la 93 (Bogota)
y permite comprobar visualmente el mapa en vivo sin un telefono.

## 6. Comprobaciones estaticas

| Comando          | Que verifica                                                    | Estado   |
| ---------------- | --------------------------------------------------------------- | -------- |
| `pnpm typecheck` | Tipos en `shared`, `api`, `web` y `mobile`                      | Correcto |
| `pnpm lint`      | Formato con Prettier (`--check`)                                | Correcto |
| `pnpm build`     | Compila `shared` (tsc) y `api` (nest), y construye `web` (Next) | Correcto |

Detalle de la verificacion de tipos del backend: se comprueba **dos** veces: el
codigo de `src/` con `tsconfig.json` (que excluye las pruebas, para que `nest
build` no las empaquete) y el conjunto completo, incluidas las pruebas, con
`tsconfig.spec.json`. Asi las pruebas tambien estan tipadas.

## 7. Trazabilidad: criterios de aceptacion -> prueba

| Criterio de aceptacion                                        | Donde se comprueba                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| Registro e inicio de sesion funcionan                         | Humo: registro (201), login (200), `/auth/me`, rotacion             |
| Android/iPhone pueden autorizar la ubicacion                  | **Manual**, verificado en dispositivo real (10.1)                   |
| La API guarda coordenadas validas                             | Humo: `POST /locations` 201 y rechazo de valores fuera de rango     |
| El mapa muestra la ultima ubicacion y la hora de recepcion    | Canal en vivo: `location:update`; la vista, **manual**              |
| El historial solo es visible para usuarios autorizados        | Humo: `history`; en vivo: suscripcion a dispositivo ajeno rechazada |
| Revocar o detener la comparticion bloquea nuevas ubicaciones  | Humo, en vivo y dispositivo real: **403** tras detener (10.1)       |
| La app maneja permiso denegado, sin conexion y datos antiguos | Unitarias: frescura. GPS del sistema apagado verificado (10.1)      |
| El Superadministrador ve todos los dispositivos               | `pnpm test:admin`: `overview`, `devices`, `detail`, `history`       |
| Un usuario normal **no** accede al panel de administracion    | `pnpm test:admin`: **403** en REST y **rechazo** en el namespace    |
| Cada consulta administrativa queda auditada                   | `pnpm test:admin`: `admin.device.view`, `admin.history.view`        |
| La direccion aproximada se muestra sin inventar datos         | `pnpm test:admin` (campo `address`); la cache, verificacion manual  |
| Revocar desde el administracion corta la ingesta              | `pnpm test:admin`: **403** tras `POST /admin/devices/:id/revoke`    |
| La app sigue compartiendo con la pantalla bloqueada           | `pnpm test:background` (cableado) + **manual** (dispositivo real)   |
| El permiso de segundo plano no se re-pide en cada arranque    | `pnpm test:background`: flujo de permisos con marca `primed`        |
| Sin conexion, las lecturas se guardan y se reenvian           | `pnpm test:background` (cola persistente) + **manual** (modo avion) |
| El acceso remoto exige consentimiento explicito               | `pnpm test:remote`: la sesion solo nace tras `accept: true` (Permitir/Rechazar en el movil) |
| Cada sesion remota queda auditada y caduca sin respuesta      | `pnpm test:remote`: acciones `remote.*` y `expireStale`             |
| El panel **no** captura; solo lo hace el dispositivo          | `pnpm test:remote`: el visor web no usa `getUserMedia`              |
| Despliegue con HTTPS sin exponer secretos                     | **Manual**: guia en [`despliegue.md`](despliegue.md) (no automatizado) |
| El informe explica por que el numero no da el GPS             | [`investigacion.md`](investigacion.md)                              |

## 8. Trazabilidad: caracteristicas de tiempo real

| Caracteristica                                              | Donde se comprueba                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Ubicacion en vivo                                           | Canal en vivo: `location:update` con coordenadas exactas           |
| Frecuencia configurable                                     | **Manual** (selector en la app)                                    |
| Estado del dispositivo (conectado / desconectado / antiguo) | Unitarias: frescura. En vivo: `device:status = CONNECTED`          |
| Precision del GPS en metros                                 | Unitarias: obligatoria y con tope de 5000 m                        |
| Historial con retencion                                     | Humo: `history`; la retencion, en [`privacidad.md`](privacidad.md) |
| Pausa de la comparticion                                    | Humo y en vivo: detener -> 403                                     |
| Panel global de administracion                              | `pnpm test:admin`: `admin:location` y `admin:device-status`        |
| Direccion aproximada (geocodificacion inversa)              | Unitarias: parsers. `pnpm test:admin`: campo `address`             |
| Circulos de incertidumbre en el mapa                        | **Manual** (el radio sale de `accuracyMeters`, ya probado)         |
| Seguimiento en segundo plano                                | `pnpm test:background` (cableado); el comportamiento, **manual**   |
| Cola sin conexion persistente                               | `pnpm test:background` (persistencia) + **manual** (modo avion)    |
| Acceso remoto a camara/microfono                            | `pnpm test:remote` (cableado); el flujo WebRTC, **manual**         |

## 9. Lo que NO esta automatizado

Honestidad sobre los limites de esta suite:

- **La app en un dispositivo real.** La captura del GPS, el permiso del sistema
  operativo, la cola sin conexion y el paso a segundo plano no tienen prueba
  automatica: dependen del telefono. El **cableado** del segundo plano si se
  verifica (`pnpm test:background`), pero que el servicio del sistema siga con la
  pantalla bloqueada solo se comprueba a mano. Varias de estas se verificaron a
  mano el 2026-10-16 (ver 10.1); la lista manual recoge lo que falta.
- **El panel en un navegador.** `apps/web` compila (`next build`) y verifica
  tipos, y la ruta `/admin` se genera sin errores; pero que el mapa multi-marcador
  dibuje, que el circulo de incertidumbre tenga el radio correcto y que el panel
  se comporte no se comprueba sin abrir un navegador. Lo que **si** esta
  automatizado es el contrato de datos del panel (`pnpm test:admin`) y el parseo
  de direcciones (unitarias).
- **Pruebas de carga y concurrencia.** No se mide comportamiento con muchos
  dispositivos simultaneos.
- **El acceso remoto a camara/microfono.** El **cableado** si se verifica
  (`pnpm test:remote`, seccion 3.3): el contrato y los esquemas de `@geo/shared`,
  el modelo de Prisma, la autorizacion y la auditoria de la API, el gateway
  `/media` y el que el panel no capture. Lo que sigue siendo manual es el flujo
  real: la senalizacion WebRTC y el consentimiento dependen de un telefono (o
  emulador) y de un navegador (punto 17 de la seccion 10). Ver
  [`acceso-remoto.md`](acceso-remoto.md).
- **Pruebas de integracion con la base de datos en Jest.** Las pruebas unitarias
  evitan la base de datos a proposito; su cobertura real la aportan los scripts
  de humo y de canal en vivo, que si la usan.

## 10. Lista de comprobacion manual (dispositivo y navegador)

Ejecutada parcialmente en un telefono real; lo verificado esta en 10.1. Los puntos
sin marcar dependen de la vista del navegador o de condiciones que no se
reprodujeron.

1. [x] Instalar la app e iniciar sesion con `demo@geo.test`.
2. [x] Conceder el permiso de ubicacion: la comparticion empieza y envia
       coordenadas (el movimiento del marcador no se verifico a simple vista, pero si
       el evento WebSocket que lo produce).
3. [~] **Denegar** el permiso: no se probo denegando el permiso, pero si con el
   **GPS del sistema apagado**, y la app explico el problema sin colgarse.
4. [ ] Activar el modo avion: deben acumularse puntos en la cola y enviarse al
       recuperar la conexion.
5. [x] Detener la comparticion desde el panel: la app detiene el envio con "sesion
       ya no es valida".
6. [ ] Dejar el telefono sin enviar mas de 2 minutos: el panel debe pasar a **datos
       antiguos**; mas de 15, a **desconectado**.
7. [ ] Abrir el panel en el navegador y comprobar que el marcador se mueve en vivo
       y que se muestra la hora de la ultima recepcion.
8. [ ] Entrar con `admin@geo.test` y comprobar que `/admin` lista **todos** los
       dispositivos de la plataforma, y que una cuenta `USER` no puede abrir esa
       ruta.
9. [ ] Verificar en el navegador que cada punto dibuja su **circulo de
       incertidumbre** con el radio de la precision y que cambia de color al
       pasar de datos actuales a antiguo / desconectado.
10. [ ] Comprobar que la ficha muestra la direccion aproximada; y que sin proveedor
        activo dice "Sin direccion disponible" en lugar de inventarla.
11. [ ] Probar **Revocar acceso** y **Desvincular dispositivo** desde el panel y
        verificar los avisos y que la auditoria registra la accion.
12. [ ] Conceder el permiso de ubicacion **"Permitir todo el tiempo" / "Siempre"**
        y comprobar que la app lo indica como "Permitido" sin volver a pedirlo.
13. [ ] Iniciar la comparticion y **bloquear la pantalla**: en Android debe verse
        la notificacion permanente y deben seguir llegando `location:update`; en
        iOS, el indicador azul del sistema.
14. [ ] Cambiar a otra aplicacion un par de minutos: el envio continua y "Ultimo
        intento de envio" en la pantalla avanza.
15. [ ] **Modo avion**: se acumulan "Pendientes por reenviar"; al reactivar la red
        se reenvian y el panel los muestra con su **hora de captura** (antiguos),
        no como recien llegados.
16. [ ] **Forzar la detencion** desde los recientes: el envio se detiene; se
        documenta como comportamiento esperado del sistema, no como fallo.
17. [ ] **Acceso remoto**: desde la ficha en `/admin`, solicitar camara o
        microfono. El telefono debe mostrar el dialogo de consentimiento; al
        aceptar, el aviso fijo y el flujo en directo en el panel; "Cortar ahora"
        en el telefono debe cerrar la sesion y dejar `remote.session.end` en la
        auditoria. Repetir dejando caducar la solicitud: pasa a `EXPIRED` sin
        abrir nada.

### 10.1 Evidencia en dispositivo real (2026-10-16)

Equipo: Huawei STK-LX3, **Android 9 (API 28)**, arm64-v8a. Se instalo el **APK
release** (arm64-v8a, 22,3 MB) generado con el proceso de
[`compilacion-android.md`](compilacion-android.md), con `adb install -r`, y se
abrio con `adb shell am start`.

| Comprobacion                           | Resultado                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Login con `demo@geo.test` en el APK    | Correcto; lista los dispositivos de la cuenta                                                                    |
| Iniciar comparticion desde el telefono | Correcto; crea la sesion `ACTIVE` y **detiene la anterior** ("Reemplazada por una nueva sesion de comparticion") |
| GPS apagado a nivel de sistema         | La app muestra "El GPS del telefono esta desactivado. Activalo para compartir tu posicion."                      |
| Captura y envio de coordenadas reales  | `7.12230, -73.13691`, precision **16 m**; la fila aparece en `locations`                                         |
| Cadena en vivo (WebSocket)             | **3 `location:update` + 3 `device:status = CONNECTED` en 75 s**, uno por envio (cada 30 s)                       |
| Detener la comparticion desde la API   | La app pasa a "La sesion de comparticion ya no es valida (...)"; **no entra ninguna ubicacion nueva**            |

Para reproducir la observacion del canal en vivo mientras un telefono comparte:
`node scripts/watch-live.mjs`.

**Lo que sigue sin verificar en hardware:** la cola sin conexion (modo avion), la
transicion visual a _datos antiguos_ / _desconectado_ en el mapa, y el mapa
Leaflet en un navegador real (el panel compila y verifica tipos, pero el dibujo
no).
