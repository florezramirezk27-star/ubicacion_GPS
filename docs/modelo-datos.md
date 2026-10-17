# Modelo de datos

Siete tablas en PostgreSQL 16, gestionadas con Prisma 7 y migraciones versionadas
en `apps/api/prisma/migrations/`.

```
users ──┬──< sessions
        ├──< devices ──┬──< location_shares ──< locations
        │              └──< locations
        └──< audit_logs (actor)

geocode_cache   (independiente: cache de geocodificacion inversa)
```

## `users`

Cuenta de la persona que autoriza la comparticion.

| Columna                    | Tipo            | Nota                                          |
| -------------------------- | --------------- | --------------------------------------------- |
| `id`                       | text (CUID)     | clave primaria                                |
| `email`                    | text, unico     | normalizado a minusculas                      |
| `password_hash`            | text            | `scrypt$N$r$p$salt$hash`, nunca la contrasena |
| `role`                     | enum `UserRole` | `USER` \| `SUPERADMIN`, por defecto `USER`    |
| `created_at`, `updated_at` | timestamptz(6)  |                                               |

`role` solo puede valer `SUPERADMIN` si el correo figura en la lista de confianza
`SUPERADMIN_EMAILS`; se aplica en el registro y en cada inicio de sesion (ver
[`admin.md`](admin.md)). No hay forma de auto-promocionarse desde la API.

## `sessions`

Sesiones de refresco. Permiten cerrar sesion de verdad y rotar tokens.

| Columna        | Tipo                     | Nota                                                          |
| -------------- | ------------------------ | ------------------------------------------------------------- |
| `id`           | text (CUID)              |                                                               |
| `user_id`      | text → `users.id`        | `onDelete: Cascade`                                           |
| `refresh_hash` | text, unico              | **SHA-256** del refresh token; el token en claro no se guarda |
| `user_agent`   | text, opcional           | permite ver desde que cliente se abrio                        |
| `created_at`   | timestamptz(6)           |                                                               |
| `expires_at`   | timestamptz(6)           |                                                               |
| `revoked_at`   | timestamptz(6), opcional | `null` mientras sigue activa                                  |

Indice: `user_id`.

## `devices`

El equipo que puede compartir su ubicacion.

| Columna        | Tipo                     | Nota                 |
| -------------- | ------------------------ | -------------------- |
| `id`           | text (CUID)              |                      |
| `user_id`      | text → `users.id`        | `onDelete: Cascade`  |
| `platform`     | enum `DevicePlatform`    | `ANDROID` \| `IOS`   |
| `device_name`  | text                     | maximo 80 caracteres |
| `last_seen_at` | timestamptz(6), opcional |                      |
| `created_at`   | timestamptz(6)           |                      |

Indice: `user_id`.

### Metadatos opcionales del dispositivo

Columnas anadidas para el panel de administracion. Todas son **opcionales** y solo
se escriben cuando la app las reporta; si no llegan quedan en `null` y el panel
muestra "sin dato" (nunca un valor inventado).

| Columna               | Tipo                     | Nota                                       |
| --------------------- | ------------------------ | ------------------------------------------ |
| `app_version`         | text, opcional           | version de la app movil                    |
| `os_version`          | text, opcional           | version del sistema operativo              |
| `battery_level`       | integer, opcional        | 0 a 100                                    |
| `permission_status`   | text, opcional           | estado del permiso de ubicacion            |
| `metadata_updated_at` | timestamptz(6), opcional | ultima vez que se actualizo algun metadato |

`DevicesService.updateMetadata` solo escribe los campos presentes, de modo que un
envio sin bateria no borra la ultima bateria conocida.

## `location_shares`

Sesion de comparticion: el permiso temporal que autoriza a un dispositivo a
enviar coordenadas.

| Columna       | Tipo                       | Nota                                           |
| ------------- | -------------------------- | ---------------------------------------------- |
| `id`          | text (CUID)                |                                                |
| `device_id`   | text → `devices.id`        | `onDelete: Cascade`                            |
| `token_hash`  | text, unico                | **SHA-256** del `shareToken`                   |
| `status`      | enum `LocationShareStatus` | `ACTIVE`, `STOPPED`, `REVOKED`, `EXPIRED`      |
| `started_at`  | timestamptz(6)             |                                                |
| `expires_at`  | timestamptz(6)             |                                                |
| `stopped_at`  | timestamptz(6), opcional   |                                                |
| `revoked_at`  | timestamptz(6), opcional   |                                                |
| `stop_reason` | text, opcional             | motivo indicado por el usuario (dato sensible) |

Indices: `device_id`, `status`.

**Regla de negocio**: solo una sesion `ACTIVE` por dispositivo. Al crear una
nueva, la anterior pasa a `STOPPED` con motivo
`"Reemplazada por una nueva sesion de comparticion"`.

`status` es solo el estado almacenado; el estado **efectivo** de una sesion
`ACTIVE` cuya `expires_at` ya paso se trata como expirado en la logica de
ingesta.

## `locations`

Cada lectura GPS.

| Columna           | Tipo                                  | Nota                                                                |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------- |
| `id`              | text (CUID)                           |                                                                     |
| `device_id`       | text → `devices.id`                   | `onDelete: Cascade`                                                 |
| `share_id`        | text → `location_shares.id`, opcional | `onDelete: SetNull` (el historial sobrevive al cierre de la sesion) |
| `latitude`        | double precision                      |                                                                     |
| `longitude`       | double precision                      |                                                                     |
| `accuracy_meters` | double precision                      | 0 a 5000                                                            |
| `altitude_meters` | double precision, opcional            |                                                                     |
| `speed_mps`       | double precision, opcional            |                                                                     |
| `heading_degrees` | double precision, opcional            | 0 a 360                                                             |
| `recorded_at`     | timestamptz(6)                        | momento de la captura GPS                                           |
| `received_at`     | timestamptz(6)                        | momento de llegada al servidor                                      |
| `geog`            | `geography(Point,4326)`, opcional     | **PostGIS**, gestionada por disparador                              |

Indices: `(device_id, recorded_at)`, `share_id`.

### Por que `recorded_at` y `received_at` son distintos

`recorded_at` es cuando el GPS obtuvo la coordenada; `received_at`, cuando llego
al servidor. La politica de frescura se calcula sobre `recorded_at`: si un
telefono estuvo sin red 10 minutos y luego sube las lecturas en cola, esas
lecturas se muestran como antiguas, no como recientes. Mostrar `received_at`
seria fingir frescura.

## `geocode_cache`

Cache de **geocodificacion inversa**. Es independiente del resto del modelo: solo
guarda la traduccion de un punto redondeado a una direccion, para no consultar al
proveedor externo en cada lectura.

| Columna                                                                        | Tipo             | Nota                                               |
| ------------------------------------------------------------------------------ | ---------------- | -------------------------------------------------- |
| `id`                                                                           | text (CUID)      |                                                    |
| `cache_key`                                                                    | text, unico      | `${provider}:${lat4}:${lon4}`                      |
| `provider`                                                                     | text             | `nominatim` \| `google`                            |
| `latitude`, `longitude`                                                        | double precision | coordenadas redondeadas a 4 decimales (~11 m)      |
| `found`                                                                        | boolean          | `false` para resultados negativos cacheados        |
| `formatted_address`                                                            | text, opcional   | direccion completa del proveedor                   |
| `label`                                                                        | text, opcional   | etiqueta corta (calle + numero)                    |
| `street`, `number`, `neighborhood`, `city`, `region`, `country`, `postal_code` | text, opcional   | componentes normalizados                           |
| `created_at`, `updated_at`                                                     | timestamptz(6)   | la antiguedad (`updated_at`) define el vencimiento |

Indice: `provider`. La clave unica `cache_key` evita duplicados entre lecturas
simultaneas. El TTL se calcula comparando `updated_at` con
`GEOCODING_CACHE_TTL_DAYS` (por defecto 30 dias). Ver [`admin.md`](admin.md).

## `audit_logs`

Acciones sensibles. `metadata` se guarda **cifrado**.

| Columna      | Tipo                        | Nota                                                  |
| ------------ | --------------------------- | ----------------------------------------------------- |
| `id`         | text (CUID)                 |                                                       |
| `actor_id`   | text → `users.id`, opcional | `onDelete: SetNull` (el registro sobrevive)           |
| `action`     | text                        | `auth.login`, `share.start`, `admin.device.view`, ... |
| `metadata`   | text, opcional              | JSON cifrado con AES-256-GCM                          |
| `ip`         | text, opcional              |                                                       |
| `created_at` | timestamptz(6)              |                                                       |

Indices: `actor_id`, `action`, `created_at`.

Que un actor sea opcional y `onDelete: SetNull` es deliberado: si se elimina una
cuenta, el rastro de lo ocurrido debe permanecer para poder auditar.

**Alcance actual.** Se auditan el registro, el inicio de sesion (con los intentos
fallidos), el ciclo de vida de las sesiones de comparticion y las **acciones del
panel de administracion** (`admin.device.view`, `admin.history.view`,
`admin.share.revoke_all`, `admin.device.unlink`). El ciclo de vida de los
dispositivos (alta/baja por parte del usuario) y la ingesta de coordenadas **no**
se auditan; el motivo esta en [`seguridad.md`](seguridad.md).

---

## PostGIS

### La columna `geog`

Prisma no tiene un tipo espacial nativo, asi que `geog` se declara como
`Unsupported("geography(Point, 4326)")?`. Existe en la base de datos, pero
**Prisma Client no la lee ni la escribe**: por eso ninguna respuesta de la API la
incluye (hay una comprobacion en las pruebas de humo que lo verifica).

### Sincronizacion por disparador

La migracion inicial define:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE OR REPLACE FUNCTION locations_sync_geog() RETURNS trigger AS $$
BEGIN
  NEW.geog := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER locations_sync_geog_trg
BEFORE INSERT OR UPDATE OF latitude, longitude ON locations
FOR EACH ROW EXECUTE FUNCTION locations_sync_geog();

CREATE INDEX locations_geog_gist_idx ON locations USING GIST (geog);
```

Ventaja: la aplicacion no puede olvidarse de mantenerla, y da igual si la fila
se inserta desde la API o desde `psql`. **Atencion al orden de coordenadas**:
`ST_MakePoint` recibe `(longitude, latitude)`, no al reves.

### Consultas geograficas

Se hacen con `$queryRaw`, porque Prisma no entiende `geography`:

```sql
SELECT id, device_id, latitude, longitude, accuracy_meters,
       recorded_at, received_at,
       ST_Distance(geog, ST_MakePoint($1, $2)::geography) AS distance_meters
FROM locations
WHERE device_id IN (SELECT id FROM devices WHERE user_id = $3)
  AND ST_DWithin(geog, ST_MakePoint($1, $2)::geography, $4)
ORDER BY geog <-> ST_MakePoint($1, $2)::geography
LIMIT $5;
```

`ST_DWithin` usa el indice GIST; el operador `<->` ordena por distancia real
sobre la esfera. La API expone esto en `GET /locations/nearby`.

### Sobre las migraciones futuras

Como `geog`, el disparador y el indice GIST los gestiona SQL propio, una
migracion generada por Prisma puede detectar "deriva" y querer eliminarlos. El
procedimiento correcto es:

```bash
pnpm --filter @geo/api exec prisma migrate dev --create-only --name mi_cambio
# revisar el SQL generado y volver a anadir lo que Prisma quiera borrar
pnpm --filter @geo/api exec prisma migrate deploy
```

---

## Ciclo de vida de los datos

```
1. El usuario vincula un Device.
2. Inicia una LocationShare  ->  el servidor devuelve el shareToken UNA vez.
3. El dispositivo envia Locations mientras la sesion siga ACTIVE y vigente.
4. El usuario detiene o revoca la sesion  ->  la ingesta se rechaza (403).
5. Eliminar un Device borra en cascada sus sesiones y ubicaciones.
   Eliminar un User borra en cascada sus dispositivos (y por tanto sus datos),
   pero conserva los audit_logs con actor nulo.
6. La geocode_cache es independiente: se purga por vencimiento (TTL), no por baja
   de un usuario.
```

Los plazos de retencion y el procedimiento de supresion se detallan en
[`privacidad.md`](privacidad.md).
