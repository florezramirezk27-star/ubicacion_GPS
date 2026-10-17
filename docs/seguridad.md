# Seguridad

La seguridad se trata como un requisito transversal: afecta al diseno de la base
de datos, a los guardas de la API, a lo que se guarda en el telefono y a lo que
viaja por la red.

## Resumen de controles

| Control                                                        | Estado                                            | Donde                                |
| -------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| Contrasenas con `scrypt` y salt por usuario                    | Implementado                                      | `PasswordService`                    |
| Token de acceso JWT de vida corta                              | Implementado                                      | `AuthService`, `JwtAuthGuard`        |
| Refresh token opaco, de un solo uso, con rotacion              | Implementado                                      | `AuthService`, tabla `sessions`      |
| Refresh token y token de comparticion guardados solo como hash | Implementado                                      | `CryptoService.sha256`               |
| Autorizacion por propietario en cada recurso                   | Implementado                                      | `findOwnedOrThrow` en los servicios  |
| Guarda global de autenticacion con excepcion explicita         | Implementado                                      | `JwtAuthGuard` + `@Public()`         |
| Cifrado de metadatos de auditoria (AES-256-GCM)                | Implementado                                      | `CryptoService`, `AuditService`      |
| Comparacion en tiempo constante de secretos                    | Implementado                                      | `CryptoService.safeEquals`           |
| Validacion estricta de toda entrada                            | Implementado                                      | `ZodValidationPipe`                  |
| CORS restringido por lista blanca                              | Implementado                                      | `main.ts`, `env.ts`                  |
| Sin claves secretas en la app movil                            | Implementado                                      | el movil solo guarda su `shareToken` |
| Registro de auditoria de acciones sensibles                    | Implementado (auth, comparticiones, panel admin y acceso remoto) | `AuditService`                       |
| Autorizacion por rol (SUPERADMIN) para el panel global         | Implementado                                      | `AdminGuard`                         |
| Revalidacion del rol contra la BD en el WebSocket `/admin`     | Implementado                                      | `AdminGateway`                       |
| Consentimiento explicito para camara/microfono (WebRTC)        | Implementado (sin activacion silenciosa)          | `RemoteAccessService`, `/media`      |
| Clave de geocodificacion solo en el backend                    | Implementado                                      | `GeocodingService`                   |
| TLS obligatorio en produccion                                  | Pendiente (despliegue)                            | —                                    |
| Limitacion de intentos de inicio de sesion                     | **Pendiente**                                     | —                                    |
| Cabeceras de seguridad HTTP (helmet)                           | **Pendiente**                                     | —                                    |
| Cookies httpOnly en el panel web                               | **Pendiente**                                     | deuda tecnica documentada            |

## Contrasenas

`PasswordService` usa `scrypt` de Node.js, sin dependencias nativas:

```
N = 2^15 (32768)   r = 8   p = 1   keyLength = 64   salt = 16 bytes aleatorios
maxmem = 128 MB (el valor por defecto de Node son 32 MB, insuficiente con N=2^15)
```

Se almacena `scrypt$N$r$p$saltBase64$hashBase64`, de modo que los parametros
viajan con el hash y se pueden subir mas adelante sin invalidar las contrasenas
existentes.

- El salt es distinto en cada cuenta: dos personas con la misma contrasena
  obtienen hashes distintos.
- La verificacion usa `timingSafeEqual`: el tiempo de respuesta no revela cuanto
  coincidia.
- La contrasena se normaliza con `NFKC` antes de derivarla, para que el mismo
  texto escrito en distintos teclados produzca el mismo hash.
- La politica minima (8 caracteres, mayuscula, minuscula y numero) se valida
  **en el servidor** con Zod; el cliente tambien la aplica, pero solo como ayuda.

## Tokens de sesion

Dos tokens con propositos distintos:

**Token de acceso (JWT)**: vida corta (unos 15 minutos). Lleva `sub` (id de
usuario), `email`, `role` y `type: "access"`. Se firma con `JWT_ACCESS_SECRET`. El
guard comprueba tambien `type`, para que un token de otro proposito no sirva como
acceso. Un token **sin** `role` se trata como `USER`: nunca se eleva por omision.
El rol contenido en el token se **vuelve a comprobar contra la base de datos** en
cada peticion de administracion y en cada conexion al namespace `/admin`.

**Refresh token**: cadena opaca de **48 bytes aleatorios** en base64url. No es un
JWT: no lleva informacion, solo es una referencia. Se guarda **unicamente su
SHA-256** en `sessions.refresh_hash`. Es **de un solo uso**: al usarlo para
renovar, se marca `revoked_at` y se emite un par nuevo. Reutilizar un refresh
token ya usado devuelve `401`, lo que convierte un robo de token en un evento
detectable en lugar de un acceso silencioso.

Cerrar sesion (`POST /auth/logout`) revoca esa sesion;
`POST /auth/logout-all` revoca todas las del usuario.

## Token de comparticion

El dispositivo movil no usa el JWT del usuario. Al iniciar una sesion de
comparticion, el servidor genera un token aleatorio y devuelve **solo una vez**;
guarda su SHA-256 en `location_shares.token_hash`. La app lo guarda en
`expo-secure-store` (Keystore en Android, Keychain en iOS).

Consecuencias:

- el telefono nunca almacena el token que da acceso a toda la cuenta;
- quien lea la base de datos no puede fabricar envios validos;
- detener o revocar la sesion invalida el token al instante (la ingesta pasa a
  responder `403`).

La comparacion del token en `ShareTokenGuard` se hace sobre el hash, y las
respuestas de error no distinguen "no existe" de "expirado" para no dar pistas.

## Autorizacion por propietario

No basta con estar autenticado: cada recurso se comprueba contra su dueno.
Todos los accesos pasan por metodos del estilo:

```ts
findOwnedOrThrow(id: string, userId: string) {
  const device = await this.prisma.device.findFirst({ where: { id, userId } });
  if (!device) throw new NotFoundException();
  return device;
}
```

Se devuelve `404` (no `403`) cuando el recurso existe pero es de otra persona:
asi no se confirma su existencia. Esto aplica a dispositivos, sesiones de
comparticion, ubicaciones y auditoria.

En el WebSocket, la suscripcion a un dispositivo verifica la propiedad contra la
base de datos **antes** de unir al cliente a la sala. Suscribirse al dispositivo
de otra persona produce `live:error` y no une a ninguna sala.

## Roles y panel de administracion

Sobre la autorizacion por propietario se anade un rol global:

- `USER`: solo sus dispositivos (y los que otro usuario le autorice).
- `SUPERADMIN`: vision global de todos los dispositivos, con capacidad de revocar
  sesiones y desvincular equipos.

Reglas que lo sostienen:

1. **El rol no se puede auto-asignar.** Procede de la lista de confianza del
   operador `SUPERADMIN_EMAILS` y se reaplica en el registro y en cada inicio de
   sesion. La API no expone ninguna ruta para cambiar el rol.
2. **Doble comprobacion.** `AdminGuard` verifica el rol en cada peticion REST; el
   `AdminGateway` lo revalida contra la base de datos al conectar el WebSocket.
   Quitar el privilegio surte efecto aunque el JWT siga vigente.
3. **El canal global es exclusivo.** El panel usa el namespace `/admin`, en una
   unica sala a la que no puede entrar un usuario normal. Un `USER` jamas recibe
   coordenadas ajenas.
4. **Todo acceso queda auditado.** Abrir una ficha o un historial, revocar o
   desvincular genera un registro (`admin.device.view`, `admin.history.view`,
   `admin.share.revoke_all`, `admin.device.unlink`) con actor, IP y metadatos
   cifrados. El panel muestra ese feed: el administrador **no puede espiar en
   silencio**.
5. **Alcance honesto.** El panel solo ve lo que los dispositivos compartieron y
   los metadatos que la app reporta. No accede a conversaciones, fotos, llamadas
   ni a ubicaciones sin autorizacion, y no permite localizar un telefono por su
   numero. Ver [`admin.md`](admin.md).

Detalle de rutas, eventos y geocodificacion en [`admin.md`](admin.md).

## Cifrado

`CryptoService` con **AES-256-GCM**, que aporta confidencialidad y ademas
integridad (un texto manipulado no se puede descifrar). El formato almacenado es
`base64(iv | authTag | ciphertext)` con IV de 12 bytes y etiqueta de 16.

Se usa para los **metadatos de auditoria**, que pueden contener contexto sensible
(identificadores de dispositivo, motivos escritos por el usuario).

La clave viene de `DATA_ENCRYPTION_KEY` (64 caracteres hex = 32 bytes) y el
servicio **falla al arrancar** si no tiene esa longitud: es preferible no
levantar que arrancar sin poder cifrar.

### Que NO se cifra, y por que

Las coordenadas se guardan en claro (`double precision`). Es una decision
consciente, no un olvido:

- PostGIS necesita el valor en claro para calcular `ST_DWithin` y las distancias;
  cifrarlas haria imposible la consulta por radio sin descifrar toda la tabla;
- el cifrado en reposo del volumen del gestor de base de datos cubre el escenario
  principal (robo del disco);
- el riesgo real de privacidad no es el disco, sino **quien puede consultar**; eso
  se controla con la autorizacion por propietario y con la retencion limitada.

Si se necesitara defensa en profundidad frente a un administrador de base de
datos, la ruta seria cifrado a nivel de columna con claves por usuario, asumiendo
el coste en las consultas geograficas.

## Superficie de red

- **CORS por lista blanca**: `CORS_ORIGINS` en `.env`. Si queda vacia, se abre
  cualquier origen y el servidor avisa por log de que es solo para desarrollo. La
  misma politica se aplica al WebSocket mediante `ConfiguredIoAdapter`.
- **Sin secretos en el cliente**: el panel web solo recibe
  `NEXT_PUBLIC_API_URL` y `NEXT_PUBLIC_MAP_TILE_URL`. Las claves de firma, de
  cifrado y la de geocodificacion (`GEOCODING_API_KEY`, solo si se usa Google) se
  quedan en el backend (ver `.env.example`, que solo contiene valores de ejemplo).
- **Validacion de entrada en el borde**: cada cuerpo y cada parametro de consulta
  pasa por su esquema Zod. Una coordenada fuera de rango, una precision
  irreal (mas de 5000 m) o una fecha no ISO se rechazan con `400` antes de tocar
  la base de datos.

## Auditoria

`AuditService.record()` registra, hoy, estas acciones:

| Accion                   | Origen                                   |
| ------------------------ | ---------------------------------------- |
| `auth.register`          | creacion de cuenta                       |
| `auth.login`             | inicio de sesion correcto                |
| `auth.login_failed`      | credenciales invalidas                   |
| `share.start`            | inicio de una sesion de comparticion     |
| `share.stop`             | parada voluntaria                        |
| `share.revoke`           | revocacion                               |
| `admin.device.view`      | consulta de la ficha de un dispositivo   |
| `admin.history.view`     | consulta del historial de un dispositivo |
| `admin.share.revoke_all` | revocacion de las sesiones de un equipo  |
| `admin.device.unlink`    | desvinculacion de un dispositivo         |
| `remote.request.create`  | solicitud de acceso a camara/microfono   |
| `remote.request.cancel`  | cancelacion de una solicitud de acceso   |
| `remote.request.accept`  | aceptacion de la solicitud en el movil   |
| `remote.request.reject`  | rechazo de la solicitud en el movil      |
| `remote.session.start`   | apertura de una sesion de medios         |
| `remote.session.end`     | cierre de una sesion de medios           |

Cada registro incluye actor (cuando existe), accion, IP y metadatos cifrados.

Dos decisiones importantes:

- **La auditoria nunca tumba la peticion del usuario**: si falla al escribir, se
  registra en el log del servidor y la operacion continua.
- **Los registros sobreviven a la baja de la cuenta**: `actor_id` es anulable con
  `onDelete: SetNull`. Si alguien elimina su cuenta, el rastro de lo ocurrido
  sigue existiendo, ya sin datos personales asociados.

### Que no se audita, y por que

- **Cada coordenada ingerida.** A una frecuencia de 5 segundos, auditar cada punto
  duplicaria la escritura por cada lectura util y no aportaria seguridad: lo que
  importa es **quien estaba autorizado y cuando**, y eso ya queda fijado al inicio
  y al cierre de la sesion de comparticion. El historial de `locations` es, en la
  practica, el registro de lo enviado.
- **El ciclo de vida de los dispositivos por parte del usuario** (crear,
  renombrar, eliminar). Es una omision, no una decision de diseno: se recomienda
  anadirlo (bajo volumen y relevante para saber cuando se vinculo un equipo). Ver
  deuda tecnica. En cambio, las acciones equivalentes del **administrador**
  (abrir fichas e historiales, revocar, desvincular) **si** se auditan.

## Deuda tecnica reconocida

Lo que **no** esta resuelto y debe abordarse antes de un uso real:

1. **Sin limitacion de intentos.** No hay proteccion contra fuerza bruta sobre
   `/auth/login`. Es la carencia mas importante. Se resolveria con
   `@nestjs/throttler` (limite por IP y por cuenta) y un pequeno retardo
   progresivo tras varios fallos. Notese que los intentos fallidos **si** quedan
   en la auditoria (`auth.login_failed`), asi que el material para detectarlos ya
   existe; lo que falta es la reaccion automatica.
2. **`/auth/audit` sin tope superior.** El parametro `limit` se acepta tal cual
   si es positivo, de modo que un cliente podria pedir la tabla entera. Deberia
   acotarse (por ejemplo a 200).
3. **Auditoria incompleta.** Faltan el ciclo de vida de los dispositivos por parte
   del usuario y no se registra la ingesta (esta ultima, deliberadamente). Las
   acciones del panel de administracion ya se registran.
4. **Tokens en `localStorage` en el panel web.** Expuestos a XSS. En produccion
   deberian ir en cookies `httpOnly` + `SameSite`, con proteccion CSRF.
5. **Sin cabeceras de seguridad HTTP** (`helmet`): faltan
   `Strict-Transport-Security`, `X-Content-Type-Options`, `Content-Security-Policy`.
6. **TLS sin configurar**: en desarrollo todo va por HTTP. El despliegue debe
   forzar HTTPS y rechazar HTTP.
7. **Sin deteccion de reutilizacion de refresh token mas alla del `401`**: lo
   ideal seria revocar toda la familia de sesiones ante un intento de reutilizar
   un token ya rotado.
8. **Sin analisis de dependencias automatizado** (`pnpm audit`, Dependabot) en el
   flujo de trabajo.
9. **Sin limitacion de ritmo en las rutas de administracion.** `/admin/devices` y
   los disparadores de geocodificacion podrian generar trafico alto si el panel se
   recarga con frecuencia. La cache y el intervalo minimo del proveedor amortiguan
   el efecto, pero convendria un tope por administrador.

## Buenas practicas seguidas

- Sin secretos en el repositorio: `.env` esta en `.gitignore` y solo se versiona
  `.env.example` con valores de ejemplo. Las claves reales se generan con
  `randomBytes`.
- Principio de menor privilegio: el movil solo puede enviar; el panel de usuario
  solo lee y administra sus propios recursos; el panel de administracion accede a
  todo, pero cada acceso queda registrado en la auditoria.
- Fallar en cerrado: sin clave de cifrado valida, la API no arranca; sin token,
  la respuesta es `401`; sin propiedad, `404`.
- Revocacion real: detener una comparticion corta la ingesta de inmediato, y un
  dispositivo no puede tener dos sesiones activas a la vez. El administrador puede
  revocar todas las sesiones de un equipo o desvincularlo por completo.
