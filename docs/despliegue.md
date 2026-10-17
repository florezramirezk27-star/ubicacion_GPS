# Despliegue en Render y Supabase

Esta guia describe como publicar la plataforma en internet usando **Supabase**
como base de datos (PostgreSQL + PostGIS) y **Render** como plataforma de
ejecucion para la API y el panel. La app movil no se despliega en Render: se
compila como APK.

El archivo [`render.yaml`](../render.yaml) de la raiz es un **Blueprint**: define
los dos servicios con sus comandos de build, arranque y verificacion, de modo que
basta con apuntar Render al repositorio para crearlos.

## 1. Reparto de responsabilidades

| Componente         | Donde                         | Por que                                    |
| ------------------ | ----------------------------- | ------------------------------------------ |
| `apps/api`         | Render (Web Service, Node)    | HTTP + WebSocket (Socket.IO)               |
| `apps/web`         | Render (Web Service, Node)    | Next.js necesita `next start` (no estatico) |
| Base de datos      | Supabase (PostgreSQL+PostGIS) | Render no ofrece PostGIS                   |
| `apps/mobile`      | Fuera de Render (APK)         | Se instala en el telefono; ver seccion 7   |

La API y el panel se comunican por HTTPS. Render emite certificados TLS
automaticos en `*.onrender.com`, de modo que se cumple el requisito de HTTPS de
[`seguridad.md`](seguridad.md) y [`compilacion-android.md`](compilacion-android.md).

## 2. Requisitos previos

- Cuenta en [Supabase](https://supabase.com) y en [Render](https://render.com).
- El repositorio en GitHub (`origin`).
- Node 20+ y `pnpm` en tu equipo para migrar el esquema una vez (seccion 3).

## 3. Paso 1: base de datos en Supabase

1. **New project**. Guarda la **contrasena de la base de datos** que te pide al
   crearlo (no se vuelve a mostrar).
2. **Database > Extensions**, busca `postgis` y pulsa **Enable**. Si no se
   habilita aqui, la primera migracion puede fallar con
   `permission denied to create extension`.
3. Copia la **cadena de conexion**. En **Connect** usa el **Session Pooler**
   (IPv4, puerto `5432`). Evita la "Direct connection" y el "Transaction Pooler"
   (`6543`), que no admite migraciones con Prisma.

```
postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres?uselibpqcompat=true&sslmode=require
```

   - **¿Por que el Session Pooler y no la conexion directa?** Supabase solo expone
     la conexion directa por **IPv6** (`db.<ref>.supabase.co`, registro `AAAA`).
     Ni tu equipo ni Render suelen tener IPv6, asi que la conexion directa falla
     con `P1001: Can't reach database server`. El pooler (mismo usuario pero
     `postgres.<ref>`) escucha en **IPv4**.
   - **¿Por que `uselibpqcompat=true`?** Supabase presenta una cadena de
     certificado que Node no reconoce; con `pg` (que es lo que usa la API en
     tiempo de ejecucion a traves de `@prisma/adapter-pg`), `sslmode=require` se
     interpreta hoy como `verify-full` y falla con
     `self-signed certificate in certificate chain`. `uselibpqcompat=true` le da
     a `sslmode` la semantica clasica de libpq (cifra sin verificar la cadena) y
     **funciona tanto en runtime como en `prisma migrate`**. Alternativa
     equivalente: `?sslmode=no-verify`.

> Elige la **region de Supabase mas cercana** a la de Render (por defecto el
> Blueprint usa `ohio`, EE. UU. este) para reducir latencia y evitar saltos entre
> continentes.

## 4. Paso 2: aplicar el esquema (una sola vez)

Las migraciones crean las tablas, los enums, la columna `geography(Point,4326)`,
los triggers y los indices GIST. Se ejecutan **desde tu equipo** apuntando a
Supabase:

```powershell
$env:DATABASE_URL="postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres?uselibpqcompat=true&sslmode=require"
pnpm --filter @geo/api exec prisma migrate deploy
pnpm --filter @geo/api prisma:generate
```

En Render, el comando de arranque de la API ya vuelve a ejecutar
`prisma migrate deploy` en cada despliegue, asi que las migraciones futuras se
aplican solas. Esta primera vez se hace a mano para comprobar que la conexion y
PostGIS funcionan antes de desplegar.

> **No ejecutes el seed en produccion.** `pnpm --filter @geo/api seed` crea
> `demo@geo.test` / `Demo1234` y `admin@geo.test` / `Admin1234`, es decir,
> contrasenas conocidas. En produccion la cuenta de administrador se crea
> registrandose desde el panel (seccion 6).

## 5. Paso 3: desplegar en Render

**Opcion A: con Blueprint (recomendada).**

1. **New > Blueprint**, conecta el repositorio de GitHub.
2. Render lee `render.yaml` y propone los dos servicios. Acepta.
3. Rellena las variables marcadas como secretas (seccion 5.1) y despliega.

**Opcion B: manual.** Crea dos **Web Services** de tipo **Node** con estos
valores. Deja *Root Directory* vacio (el repositorio ya es la raiz del
monorepositorio).

| Ajuste            | API                                                  | Panel web                                            |
| ----------------- | ---------------------------------------------------- | ---------------------------------------------------- |
| Build Command     | `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @geo/shared build && pnpm --filter @geo/api build` | `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @geo/shared build && pnpm --filter @geo/web build` |
| Start Command     | `pnpm --filter @geo/api prisma:deploy && pnpm --filter @geo/api start:prod` | `pnpm --filter @geo/web start`                |
| Health Check Path | `/health`                                            | `/`                                                  |

### 5.1 Variables de entorno

**API** (`geolocalizador-api`):

| Variable              | Valor                                                        |
| --------------------- | ------------------------------------------------------------ |
| `NODE_ENV`            | `production`                                                 |
| `API_HOST`            | `0.0.0.0`                                                    |
| `DATABASE_URL`        | cadena del Session Pooler de Supabase (seccion 3)            |
| `JWT_ACCESS_SECRET`   | secreto aleatorio (>= 32 caracteres)                         |
| `JWT_REFRESH_SECRET`  | otro secreto aleatorio distinto                              |
| `DATA_ENCRYPTION_KEY` | 64 caracteres hexadecimales (32 bytes)                       |
| `CORS_ORIGINS`        | `https://<tu-web>.onrender.com` (ver seccion 6)              |
| `SUPERADMIN_EMAILS`   | tu correo real (seccion 6)                                   |
| `GEOCODING_PROVIDER`  | `nominatim` (o `disabled` / `google`)                        |
| `GEOCODING_USER_AGENT`| `geolocalizador-movil/1.0 (tu-correo)`                       |

No se define `API_PORT`: la API usa la variable `PORT` que inyecta Render
(ver seccion 8).

**Panel** (`geolocalizador-web`):

| Variable                   | Valor                                                  |
| -------------------------- | ------------------------------------------------------ |
| `NEXT_PUBLIC_API_URL`      | `https://<tu-api>.onrender.com`                        |
| `NEXT_PUBLIC_MAP_TILE_URL` | `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`   |

Genera los secretos (una vez por valor):

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_ACCESS_SECRET / JWT_REFRESH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # DATA_ENCRYPTION_KEY (64 hex)
```

> `DATA_ENCRYPTION_KEY` cifra los metadatos de auditoria. **No debe cambiar**
> despues del primer arranque: si se pierde o se rota, esos metadatos dejan de
> poder descifrarse. Tratala como un secreto permanente.

## 6. Paso 4: conectar el panel con la API y crear el administrador

Hay una dependencia circular (la API necesita la URL del panel en CORS, y el
panel necesita la URL de la API), que se resuelve en este orden:

1. Despliega primero la **API**. Copia su URL, `https://<api>.onrender.com`.
2. En el servicio del **panel**, define `NEXT_PUBLIC_API_URL` con esa URL y
   redespliega (se incrusta en el bundle durante el *build*).
3. Copia la URL del panel y ponla en `CORS_ORIGINS` de la **API**; redespliega la
   API.

   > Si `CORS_ORIGINS` queda vacio, la API abre CORS a cualquier origen
   > (`origin: true`), lo cual **no** es aceptable en produccion.

4. Abre el panel, **registra tu cuenta** con tu correo real.
5. En la API, pon ese correo en `SUPERADMIN_EMAILS` y redespliega.
6. Vuelve a iniciar sesion: el rol se aplica **en cada inicio de sesion**, asi que
   tu cuenta se convierte en `SUPERADMIN` y entra a `/admin`.

## 7. Paso 5: app movil

La app no se despliega en Render. Se compila un APK apuntando a la API publica:

```powershell
$env:EXPO_PUBLIC_API_URL="https://<tu-api>.onrender.com"
npx eas-cli build -p android --profile preview   # o bien: npx expo run:android
```

- La URL se incrusta en el bundle: hay que **recompilar** si cambia.
- La app **no funciona en Expo Go**: usa `react-native-webrtc` y tareas de
  segundo plano, que requieren un build nativo.
- Como la API ya va por **HTTPS**, **quita** el plugin
  `./plugins/withCleartextTraffic` de `apps/mobile/app.json`: solo era necesario
  para HTTP en la red local (ver [`compilacion-android.md`](compilacion-android.md)).
- `app.json > extra.apiUrl` contiene una IP local y se ignora cuando defines
  `EXPO_PUBLIC_API_URL`.

## 8. Puertos y verificacion de salud

Render espera que cada servicio escuche en `0.0.0.0:$PORT`, donde `PORT` lo
inyecta la plataforma. Para que esto funcione sin configuracion manual:

- la **API** da prioridad a `PORT` y, si no existe, usa `API_PORT` (desarrollo
  local);
- el **panel** arranca con `next start`, que respeta `PORT` y cae a `3000` en
  local.

Render comprueba `GET /health` en la API (responde `{ "status": "ok", ... }`) y
`GET /` en el panel para saber si el despliegue esta sano.

## 9. Limitaciones y avisos

- **Plan free de Render**: los servicios se suspenden tras ~15 minutos sin
  trafico y tardan ~1 minuto en despertar; los WebSocket se cortan al suspenderse.
  Para una demostracion o sustentacion en vivo, conviene mantenerlos despiertos o
  usar un plan pago.
- **WebRTC (acceso remoto)**: la configuracion ICE usa un **STUN publico**. Para
  atravesar NAT simetricos (redes moviles o corporativas) hace falta un **TURN**
  propio (coturn, Twilio o Metered). Sin TURN, el acceso remoto puede no
  conectar fuera de la red local.
- **Nominatim** puede limitar o bloquear IPs de nube. Si la geocodificacion
  falla, usa `GEOCODING_PROVIDER=disabled` (el panel mostrara "no disponible") o
  `google` con su clave.
- **Sin TURN ni HTTPS propio de dominio** el prototipo sigue siendo valido como
  demostracion academica; lo que un despliegue real necesitaria esta listado en
  [`privacidad.md`](privacidad.md).

## 10. Actualizaciones siguientes

- Un `git push` a `main` redespliega ambos servicios (`autoDeploy: true`).
- Cada arranque de la API aplica migraciones pendientes.
- Si cambia `NEXT_PUBLIC_API_URL`, hay que **redesplegar** el panel, no solo
  reiniciarlo.

## 11. Referencias

- [`arquitectura.md`](arquitectura.md) — vision de conjunto del sistema.
- [`seguridad.md`](seguridad.md) — TLS, secretos y auditoria.
- [`privacidad.md`](privacidad.md) — que faltaria para un despliegue real.
- [`compilacion-android.md`](compilacion-android.md) — compilacion del APK.
