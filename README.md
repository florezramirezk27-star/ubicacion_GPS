# Geolocalizador Movil

Plataforma de **seguimiento de ubicacion con autorizacion explicita** para
proyecto de ingenieria de software. El usuario decide compartir la posicion de
su propio dispositivo; un panel web la muestra en un mapa y en tiempo real.

Ademas, una cuenta de **Superadministrador** tiene su propio panel de
administracion: ve todos los dispositivos autorizados de la plataforma en vivo con
su circulo de incertidumbre, consulta historiales, revoca o desvincula equipos y
cada una de esas consultas queda registrada en la auditoria.

> **Aclaracion de alcance.** Esta plataforma **no** obtiene la ubicacion de un
> dispositivo a partir de un numero de telefono. Eso es tecnicamente imposible
> sin acceso privilegiado a la red del operador y carece de base legal. Solo se
> geolocaliza un equipo que ejecuta la app y autoriza la comparticion. Ver
> [`docs/investigacion.md`](docs/investigacion.md) y
> [`docs/privacidad.md`](docs/privacidad.md).

## Que hace

- Registro e inicio de sesion con tokens de acceso y refresco rotativos.
- Vinculacion de dispositivos (Android / iPhone) a una cuenta.
- Sesiones de comparticion con expiracion y token de un solo uso.
- Ingesta de coordenadas GPS por HTTP desde la app movil.
- **Seguimiento en segundo plano**: sigue enviando con la app minimizada o la
  pantalla bloqueada (servicio en primer plano en Android con notificacion, modo
  de ubicacion en iOS). Reanuda el envio tras un corte de red; el sistema puede
  suspenderlo si se fuerza la detencion (`docs/segundo-plano.md`).
- **Mapa en vivo**: el marcador se mueve al recibir coordenadas nuevas, sin
  recargar la pagina (WebSocket / Socket.IO).
- Estado honesto del dato: `CURRENT`, `STALE`, `OFFLINE`, `UNKNOWN`.
- Historial de recorridos y consultas geograficas por radio (PostGIS).
- **Panel de administracion** (`/admin`, rol `SUPERADMIN`): vision global de
  todos los dispositivos autorizados, en vivo, con filtros, ficha completa y
  gestion (revocar sesiones / desvincular equipos).
- **Acceso remoto a camara y microfono** (consentimiento explicito): el
  Superadministrador solo puede **solicitar**; la camara o el microfono se abren
  unicamente si la persona acepta en su telefono, muestra un aviso fijo con boton
  para cortar y todo queda auditado. Con la app cerrada no hay entrega
  (`docs/acceso-remoto.md`).
- **Direccion aproximada**: geocodificacion inversa con cache y limite de ritmo;
  si no hay datos, el panel lo dice en vez de inventar una direccion.
- **Circulos de incertidumbre** en el mapa: el radio del punto es la precision
  que reporta el GPS.
- Auditoria de acciones sensibles con metadatos cifrados, incluidas todas las
  consultas del administrador.

## Arquitectura

```
apps/mobile   Expo 58 + React Native   captura GPS y envia por HTTP
apps/web      Next.js 16 + Leaflet     panel con mapa en vivo (Socket.IO)
apps/api      NestJS + Prisma + PostGIS  reglas de negocio, ingesta, difusion
packages/shared  tipos y validaciones Zod compartidos por los tres
```

Detalle en [`docs/arquitectura.md`](docs/arquitectura.md).

### Flujo del dato

```
GPS del telefono
  -> POST /locations            (cabecera X-Share-Token)
     -> se valida el token contra el hash de la sesion ACTIVE
        -> INSERT en locations (trigger sincroniza geography de PostGIS)
           -> WebSocket location:update  -> panel web (marcador se mueve)
           -> WebSocket device:status    -> panel web (estado del equipo)
           -> WebSocket admin:location   -> panel de administracion (sala global)
           -> geocodificacion inversa    -> cache -> direccion aproximada
```

El movil no mantiene un socket permanente: envia por HTTP porque es mas fiable
cuando el sistema operativo suspende la app. El WebSocket existe para difundir
a los observadores. La captura corre en una **tarea del sistema**
(`expo-task-manager`), de modo que el envio no depende de tener la pantalla
abierta; ver [`docs/segundo-plano.md`](docs/segundo-plano.md).

## Requisitos

- Node.js >= 20 (probado con 24)
- pnpm 11
- Docker (para PostgreSQL 16 + PostGIS)

## Puesta en marcha

```bash
# 1. Dependencias
pnpm install

# 2. Variables de entorno (copia y ajusta si hace falta)
cp .env.example .env          # en Windows: Copy-Item .env.example .env

# 3. Base de datos con PostGIS (contenedor en el puerto 5433)
pnpm db:up

# 4. Esquema, migraciones y datos de demostracion
pnpm prisma:migrate
pnpm --filter @geo/api seed

# 5. Compilar el paquete compartido (antes de arrancar apps)
pnpm --filter @geo/shared build

# 6. Arrancar la API (http://localhost:3001) y el panel (http://localhost:3000)
pnpm dev:api
pnpm dev:web                  # en otra terminal
```

El puerto **5433** evita el choque con un PostgreSQL nativo que use el 5432.

### Datos de demostracion

El `seed` crea dos cuentas:

- `demo@geo.test` / `Demo1234` — usuario normal, con dos dispositivos y un
  recorrido de ejemplo en Bogota.
- `admin@geo.test` / `Admin1234` — **Superadministrador** del panel de
  administracion.

El rol se asigna mediante la lista de confianza `SUPERADMIN_EMAILS` en `.env`, que
se aplica en el registro y en cada inicio de sesion: nadie puede auto-promocionarse
desde la API.

## App movil

```bash
pnpm dev:mobile          # inicia el servidor de Expo
```

Luego escanea el codigo QR con **Expo Go** (Android/iOS) o ejecuta
`pnpm --filter @geo/mobile android` con un emulador.

> **Importante.** Las funciones de **ubicacion en segundo plano** (servicio en
> primer plano en Android, modo de ubicacion en iOS) **no** estan disponibles en
> Expo Go: requieren un **build nativo**. Para el seguimiento en segundo plano,
> instala el APK descrito abajo en lugar de usar Expo Go. En Expo Go la app
> funciona, pero solo captura con la pantalla abierta.

La app detecta sola la direccion de la API a partir del servidor de Expo, asi
que funciona en un telefono real conectado a la misma red sin configuracion
manual. Si usas otro equipo o un tunel, la direccion se puede cambiar desde la
pantalla de inicio de sesion.

Flujo en el telefono: iniciar sesion -> elegir el dispositivo -> **Iniciar
comparticion**. La app pide el permiso de ubicacion (y, para el segundo plano,
"Permitir todo el tiempo" / "Siempre"), abre la sesion en el servidor y empieza a
enviar coordenadas con la frecuencia elegida. Mientras comparte, Android muestra
una notificacion permanente e iOS el indicador azul del sistema. Desde la misma
pantalla se puede **Detener** en cualquier momento.

### APK instalable (release)

Para generar un APK que se instala y abre en el telefono **sin** Expo Go ni
cable, ver [`docs/compilacion-android.md`](docs/compilacion-android.md). Incluye
la resolucion de dos problemas reales: el HTTP en claro en Android 9+ (plugin
`withCleartextTraffic`) y el limite de 260 caracteres de Windows (ninja).

## Demostrar el tiempo real sin telefono

Con la API y el panel en marcha:

1. Entra al panel en `http://localhost:3000` con la cuenta de demostracion.
2. Selecciona un dispositivo y pulsa **Iniciar comparticion**; copia el token.
3. En otra terminal, simula el telefono con el token:

```bash
SHARE_TOKEN=<token> node scripts/simulate-mobile.mjs
```

El marcador se movera en el mapa. Si detienes la simulacion, el panel pasara a
**datos antiguos** a los 2 minutos y a **desconectado** a los 15.

> Con `pnpm simulate` el script se encarga solo: inicia sesion, abre la sesion de
> comparticion y envia el recorrido.

Para observar la cadena con un **telefono real** que ya esta compartiendo, se
puede escuchar el WebSocket directamente:

```bash
node scripts/watch-live.mjs      # se suscribe y registra location:update / device:status
```

## Panel de administracion (rol SUPERADMIN)

1. Entra con `admin@geo.test` / `Admin1234`. El panel abre directamente en
   `http://localhost:3000/admin` (un usuario normal redirige a `/dashboard`).
2. Veras el recuento global, la lista de **todos** los dispositivos de la
   plataforma y su mapa, con el circulo de incertidumbre de cada punto.
3. Selecciona un dispositivo (desde la lista o desde el mapa) para ver su ficha:
   direccion aproximada, precision, metadatos (app, sistema, bateria, permiso),
   sesiones recientes e historial con su recorrido en el mapa.
4. **Revocar acceso** corta las sesiones de comparticion y **Desvincular
   dispositivo** elimina el equipo y su historial; ambas piden confirmacion y
   quedan auditadas.
5. En la ficha, **Acceso remoto a camara y microfono**: el administrador **solo
   puede solicitar**. Si la persona acepta en su telefono, ve el flujo en
   directo y puede finalizarlo en cualquier momento; ver
   [`docs/acceso-remoto.md`](docs/acceso-remoto.md).
6. Al final, **Eventos de seguridad** muestra quien miro que y cuando.

Si la llegada en vivo se cae, el panel lo avisa y sigue refrescando por consulta.

> **Alcance honesto.** El administrador solo ve lo que los dispositivos
> **compartieron** y los metadatos que la app reporta. No accede a conversaciones,
> fotos ni llamadas, y **no** puede localizar un telefono por su numero. La
> camara o el microfono solo se abren con **consentimiento explicito** del
> usuario, nunca en silencio. Un dato viejo se marca como antiguo o desconectado;
> nunca como actual. Detalle en [`docs/admin.md`](docs/admin.md) y
> [`docs/acceso-remoto.md`](docs/acceso-remoto.md).

## Scripts utiles

| Comando                       | Que hace                                          |
| ----------------------------- | ------------------------------------------------- |
| `pnpm db:up` / `pnpm db:down` | Levanta / detiene el contenedor de PostGIS        |
| `pnpm prisma:migrate`         | Aplica migraciones                                |
| `pnpm prisma:studio`          | Explorador visual de la base de datos             |
| `pnpm typecheck`              | Verifica tipos en todo el monorepositorio         |
| `pnpm lint`                   | Comprueba el formato con Prettier                 |
| `pnpm format`                 | Aplica el formato con Prettier                    |
| `pnpm build`                  | Compila paquetes y aplicaciones                   |
| `pnpm test:unit`              | Pruebas unitarias del backend (Jest)              |
| `pnpm test:api`               | Prueba de humo end-to-end de la API               |
| `pnpm test:live`              | Verifica la cadena HTTP -> WebSocket              |
| `pnpm test:admin`             | Verifica el panel de administracion y su canal    |
| `pnpm test:background`        | Verifica el cableado del seguimiento en segundo plano |
| `pnpm measure:latency`        | Mide la latencia del canal en vivo (estadisticas) |
| `pnpm simulate`               | Simula un telefono enviando coordenadas           |

## Documentacion

| Documento                                                    | Contenido                                       |
| ------------------------------------------------------------ | ----------------------------------------------- |
| [`docs/arquitectura.md`](docs/arquitectura.md)               | Stack, decisiones y estructura                  |
| [`docs/api.md`](docs/api.md)                                 | Referencia de endpoints                         |
| [`docs/modelo-datos.md`](docs/modelo-datos.md)               | Entidades, relaciones y PostGIS                 |
| [`docs/tiempo-real.md`](docs/tiempo-real.md)                 | Tabla de caracteristicas y politica de frescura |
| [`docs/segundo-plano.md`](docs/segundo-plano.md)             | Ubicacion en segundo plano: limites y permisos  |
| [`docs/admin.md`](docs/admin.md)                             | Panel de Superadministrador y geocodificacion   |
| [`docs/acceso-remoto.md`](docs/acceso-remoto.md)             | Camara/microfono con consentimiento: WebRTC y limites |
| [`docs/seguridad.md`](docs/seguridad.md)                     | Contrasenas, sesiones, autorizacion, auditoria  |
| [`docs/privacidad.md`](docs/privacidad.md)                   | Ley 1581 de 2012, guias de la SIC y retencion   |
| [`docs/investigacion.md`](docs/investigacion.md)             | Comparacion de los tres metodos de localizacion |
| [`docs/pruebas.md`](docs/pruebas.md)                         | Estrategia de pruebas y como ejecutarlas        |
| [`docs/compilacion-android.md`](docs/compilacion-android.md) | Compilar e instalar el APK release (Windows)    |

## Estado

- [x] Paquete compartido (tipos y validaciones Zod)
- [x] API: autenticacion, dispositivos, sesiones de comparticion, ingesta, historial, PostGIS
- [x] Tiempo real: gateway WebSocket con autenticacion y salas por dispositivo
- [x] Panel web: mapa Leaflet con marcador en vivo, estado, historial, busqueda por radio
- [x] Panel de administracion (`/admin`, rol `SUPERADMIN`): vision global, mapa
      multi-dispositivo con circulos de incertidumbre, ficha, historial, gestion y
      auditoria de cada consulta
- [x] Geocodificacion inversa con cache y limite de ritmo (direccion aproximada)
- [x] Acceso remoto a camara y microfono con consentimiento explicito: solicitud
      auditable que caduca sola, sesion de medios WebRTC, visor en el panel y
      aviso fijo cortable desde el telefono (sin activacion silenciosa)
- [x] App movil (Expo 58): inicio de sesion, vinculacion, captura GPS en primer plano,
      frecuencia configurable, cola de reintento sin conexion y deteccion de sesion revocada
- [x] Seguimiento en segundo plano (servicio en primer plano en Android, modo de
      ubicacion en iOS): sigue con la pantalla bloqueada, cola persistente y
      flujo de permisos que no re-pregunta en cada arranque
- [x] Simulador de dispositivo (recorrido GPS sintetico)
- [x] Pruebas: unitarias del backend, de humo de la API, del canal en vivo y del panel de administracion
- [x] APK release compilado, instalado y verificado en un telefono Android real
      (login y envio de coordenadas en vivo por WebSocket)
- [ ] Despliegue con HTTPS
- [ ] Informe academico final
