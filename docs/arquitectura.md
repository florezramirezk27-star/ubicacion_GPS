# Arquitectura

## Vision general

Monorepositorio con tres aplicaciones y un paquete compartido. La regla de oro
es que **las reglas de negocio y las validaciones viven en el backend y en el
paquete compartido**, nunca solo en el cliente.

```
geolocalizador-movil/
├── apps/
│   ├── api/          NestJS + Prisma + PostGIS + Socket.IO   (puerto 3001)
│   ├── web/          Next.js 16 + Leaflet                     (puerto 3000)
│   └── mobile/       Expo 58 + React Native                   (Metro, puerto 8081)
├── packages/
│   └── shared/       Tipos y esquemas Zod compartidos
├── docs/             Esta documentacion
├── scripts/          Simulador de dispositivo y verificaciones end-to-end
├── docker-compose.yml   PostgreSQL 16 + PostGIS (puerto 5433)
├── pnpm-workspace.yaml
└── .env.example
```

## Por que un monorepositorio

El mismo contrato (`latitude`, `accuracyMeters`, `recordedAt`, estados de una
sesion de comparticion) se usa en tres lugares. Tenerlo una sola vez en
`packages/shared` evita que el movil acepte algo que el backend rechace, o que el
panel interprete la frescura con umbrales distintos a los del servidor.

`packages/shared` se compila a CommonJS en `dist/`. Las tres aplicaciones
consumen ese `dist`, de modo que no hay que configurar transpilacion especial en
cada una (Next lo transpila con `transpilePackages`, Metro lo empaqueta desde el
espacio de trabajo, y Nest lo importa como cualquier dependencia).

## Stack

| Capa            | Tecnologia                                 | Motivo                                                                                                        |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Movil           | React Native + Expo 58                     | Un solo codigo para Android e iOS; `expo-location` da acceso al GPS con permisos bien integrados.             |
| Movil (segundo plano) | `expo-task-manager` + servicio en primer plano | Tarea del sistema que sigue enviando con la pantalla bloqueada; cola persistente ante cortes de red.     |
| Panel           | Next.js 16 + TypeScript                    | Enrutado y despliegue sencillos; el mapa es Leaflet imperativo para no depender del ciclo de render de React. |
| API             | NestJS 12 + TypeScript                     | Modulos, inyeccion de dependencias y guardas: la autorizacion por propietario queda en un sitio claro.        |
| Datos           | PostgreSQL 16 + PostGIS + Prisma 7         | PostGIS aporta consultas geograficas reales; Prisma da tipos y migraciones versionadas.                       |
| Tiempo real     | Socket.IO                                  | Salas por dispositivo y reconexion automatica ya resueltas.                                                   |
| Mapas           | Leaflet + OpenStreetMap                    | Sin claves de API ni coste, y el mapa es verificable en el navegador.                                         |
| Validacion      | Zod 4                                      | Un unico esquema valida en cliente y servidor.                                                                |
| Geocodificacion | Nominatim (OpenStreetMap); Google opcional | Traduce coordenadas a una direccion aproximada, con cache y limite de ritmo.                                  |

## Decisiones de diseno

### El movil envia por HTTP; el WebSocket es para los observadores

El telefono **no** mantiene un socket permanente. Cuando iOS o Android suspenden
la app, un socket se cae; una peticion HTTP corta, en cambio, se completa. Asi
que el movil hace `POST /locations` con la cabecera `X-Share-Token` y el
servidor difunde por WebSocket a quien este mirando el mapa.

### El seguimiento vive en una tarea del sistema, no en la pantalla

La captura no depende de que la pantalla de React este montada. `index.js`
registra una tarea (`expo-task-manager`) en el ambito global del bundle y
`Location.startLocationUpdatesAsync` la alimenta. En Android el servicio corre en
**primer plano** (con notificacion permanente, requisito del sistema a partir de
Android 8 y con tipo `location` desde Android 14); en iOS usa el modo de
ubicacion en segundo plano con el indicador azul del sistema. La tarea lee su
configuracion y su cola de un almacen persistente, porque puede ejecutarse en un
contexto de JS distinto al de la app. Ver [`segundo-plano.md`](segundo-plano.md).

### Token de comparticion separado del JWT

El dispositivo se autentica con un `shareToken` propio, no con el token de
usuario. Ventajas:

- el token de usuario (que da acceso a toda la cuenta) nunca vive en el telefono
  que solo necesita enviar coordenadas;
- el servidor guarda solo el **hash SHA-256** del `shareToken`; si se roba la
  base de datos no se pueden falsificar envios;
- cerrar la comparticion invalida el token de inmediato.

### Una sola sesion activa por dispositivo

Si existieran dos sesiones activas, no habria forma de revocar el acceso de
verdad: quedaria otra puerta abierta. Al iniciar una sesion nueva, la anterior
pasa a `STOPPED` con el motivo registrado en la auditoria.

### Frescura calculada en el servidor

`CURRENT` / `STALE` / `OFFLINE` / `UNKNOWN` se derivan de `recordedAt` en el
backend, con los umbrales de `packages/shared`. El panel usa **la misma funcion**,
de modo que es imposible que la interfaz muestre como "en vivo" un dato que el
servidor considera viejo. Ver [`tiempo-real.md`](tiempo-real.md).

### Coordenadas en claro, metadatos de auditoria cifrados

Las coordenadas se guardan como `double precision` porque se consultan y se
indexan constantemente (y PostGIS necesita el valor en claro). Cifrarlas
impediria las consultas por radio. En cambio, los metadatos de auditoria —que
pueden contener contexto sensible— se cifran con AES-256-GCM. El equilibrio se
justifica en [`privacidad.md`](privacidad.md).

### PostGIS gestionado por disparador

Prisma no modela `geography`. La columna existe como
`Unsupported("geography(Point, 4326)")` y un disparador la mantiene sincronizada
con `longitude`/`latitude` en cada insercion. Hay un indice GIST para las
consultas por radio. El detalle esta en [`modelo-datos.md`](modelo-datos.md).

### El panel de administracion usa su propio namespace

El Superadministrador necesita un flujo **global** (todos los dispositivos), que
no encaja en el namespace raiz pensado para salas por dispositivo. Por eso
`AdminGateway` se monta en `/admin`, en una unica sala a la que solo se entra con
rol `SUPERADMIN`. Consecuencias de diseno:

- un usuario normal **jamas** recibe coordenadas ajenas: no puede ni conectarse a
  ese namespace;
- el rol se **revalida contra la base de datos** en cada conexion (no basta con
  que el JWT lo diga), de modo que quitar el privilegio surte efecto aunque el
  token siga vigente;
- `LocationsService` y `LocationSharesService` dependen de `AdminGateway` para
  difundir los cambios, sin que `AdminModule` dependa de ellos (no hay ciclos).

### Geocodificacion inversa: cache y ritmo limitado

La geocodificacion es un **servicio externo** y no debe convertir cada lectura GPS
en una consulta de red. `GeocodingModule` es global y expone un
`GeocodingService` con dos modos de uso:

- `resolve` (puede llamar al proveedor): se usa en la **ingesta** —en segundo
  plano, sin bloquear la respuesta— y al abrir la **ficha** de un dispositivo en
  el panel;
- `lookup` / `lookupMany` (solo cache): se usan en todas las lecturas de listas y
  resumenes, que nunca generan trafico.

Las coordenadas se redondean a 4 decimales (~11 m) como clave de cache, los
resultados negativos tambien se guardan, y las llamadas al proveedor se
serializan con un intervalo minimo. Si el proveedor esta deshabilitado o no
responde, la direccion es `null` y el panel lo indica: **nunca se inventa una
direccion**. Ver [`admin.md`](admin.md).

## Flujo completo de un dato

```
 expo-location (GPS)
        │  latitude, longitude, accuracyMeters, recordedAt
        ▼
 POST /locations            cabecera X-Share-Token
        │
   ShareTokenGuard  ── hash del token ──► ¿sesion ACTIVE y no expirada?
        │                                       │ no ─► 401 / 403
        ▼ sí
 LocationsService.ingest()
        │  INSERT en locations  (el disparador rellena geog)
        ├─► LiveGateway.emitLocation()      ─► sala device:<id> ─► panel web
        ├─► LiveGateway.emitDeviceStatus(CONNECTED)
        ├─► AdminGateway.emitLocation()     ─► sala admin ─► panel de administracion
        ├─► GeocodingService.resolve()  (segundo plano; cache + proveedor)
        └─► actualiza devices.last_seen_at
        │
        ▼
   201 PublicLocation
```

La ingesta **no** escribe en la auditoria: la autorizacion que la ampara ya quedo
registrada al abrir la sesion (`share.start`). Ver
[`seguridad.md`](seguridad.md).

## Compilacion y orden de dependencias

`packages/shared` debe compilarse **antes** que las aplicaciones, porque las
aplicaciones resuelven `@geo/shared` contra su `dist/`.

```bash
pnpm --filter @geo/shared build     # 1. el contrato compartido
pnpm --filter @geo/api build        # 2. la API
pnpm --filter @geo/web build        # 3. el panel
pnpm --filter @geo/mobile typecheck # 4. la app movil
```

`pnpm build` en la raiz hace las tres primeras en orden.

## Metro y pnpm en el monorepositorio

`apps/mobile/metro.config.js` declara `watchFolders` con la raiz del espacio de
trabajo y `nodeModulesPaths` con los dos `node_modules`. **No** se desactiva la
busqueda jerarquica de Metro: pnpm no eleva las dependencias transitivas, cada
paquete las tiene en `node_modules/.pnpm/<paquete>@<version>/node_modules/`, y
desactivarla impide resolver imports internos de `react-native` (por ejemplo
`invariant`).

## Fuera de alcance en esta version

- **Cookies httpOnly en el panel web**: la version actual guarda los tokens en
  `localStorage`. Suficiente para el alcance academico, documentado como deuda
  tecnica en [`seguridad.md`](seguridad.md).
- **Extraccion de ubicacion por numero de telefono**: descartado por imposible y
  por ilegal; el analisis esta en [`investigacion.md`](investigacion.md).

El seguimiento en segundo plano **ya no esta fuera de alcance**: forma parte de
esta version (ver [`segundo-plano.md`](segundo-plano.md)). Lo que no se promete
—porque no depende de la aplicacion— es el envio ininterrumpido tras una
detencion forzada, con el telefono apagado o con los permisos revocados.
