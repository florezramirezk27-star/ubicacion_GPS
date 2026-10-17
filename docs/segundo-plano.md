# Seguimiento de ubicacion en segundo plano

Este documento explica como la app movil sigue compartiendo la ubicacion **con la
pantalla bloqueada, la app minimizada o el usuario en otra aplicacion**, y —con
la misma honestidad— **que no se puede prometer**.

> **Resumen en una frase.** El envio ya no depende de mirar la pantalla: una
> tarea del sistema captura y envia la ubicacion. Pero el sistema operativo
> conserva el control y puede suspender o terminar la app; forzar la detencion
> no garantiza seguimiento.

## 1. Por que no basta con un WebSocket

El telefono **no** mantiene un socket permanente hacia la API. Cuando Android o
iOS suspenden la app, un socket se cae y no se recupera hasta que la app vuelve a
primer plano. Por eso el movil envia por **HTTP** (`POST /locations`, cabecera
`X-Share-Token`), que es una operacion corta y se completa aunque la app se
suspenda justo despues. El WebSocket existe al otro lado, para difundir a los
observadores (panel web y panel de administracion).

## 2. Como funciona la tarea del sistema

La captura vive en una **tarea del sistema** registrada con `expo-task-manager`:

```
expo-location (GPS del sistema)
      │  Location.startLocationUpdatesAsync("geo-background-location", …)
      ▼
expo-task-manager  ── entrega coordenadas ──►  src/lib/background-location.ts
      │                                              │ lee sesion y cola de
      │                                              │ tracking-store (AsyncStorage)
      ▼                                              ▼
 servicio de ubicacion                        POST /locations  (X-Share-Token)
 (Android: servicio en primer plano                    │
  con notificacion; iOS: modo background)             ▼
                                              API -> INSERT -> WebSocket -> panel
```

Puntos clave del diseno:

- `TaskManager.defineTask` se ejecuta en el **ambito global del bundle**
  (`apps/mobile/index.js` importa `src/lib/background-location.ts`). Es un
  requisito de `expo-task-manager`: cuando el sistema despierta la app en segundo
  plano **no se monta ninguna pantalla**, pero el bundle si se evalua.
- La tarea **no comparte memoria** con la pantalla: lee la sesion de comparticion
  (token, expiracion, frecuencia, URL de la API) y la **cola de lecturas** de un
  almacen persistente (`src/lib/tracking-store.ts`, sobre `AsyncStorage`).
- Los envios se **serializan** (cadena de promesas) para que la tarea y el primer
  envio de la pantalla no se pisen.
- El ultimo estado (contadores, ultima posicion, error) tambien se persiste, de
  modo que la pantalla se pone al dia al volver a primer plano.

## 3. Android: servicio en primer plano

Android exige un **servicio en primer plano** para seguir obteniendo ubicacion
con la app en segundo plano. Al iniciar el seguimiento se pasa la opcion
`foregroundService` a `startLocationUpdatesAsync`, y la app muestra una
**notificacion permanente** mientras comparte:

> "Geolocalizador: compartiendo ubicacion — Tu ubicacion se comparte de forma
> autorizada. Toca para abrir la app."

Detalles tecnicos relevantes:

- El servicio se declara con `android:foregroundServiceType="location"` (lo
  aporta el propio `expo-location`), obligatorio en **Android 14+**.
- Android **solo permite arrancar** el servicio desde la app en primer plano. Por
  eso el arranque siempre ocurre tras una accion del usuario (_Iniciar
  comparticion_), nunca en segundo plano de forma automatica.
- La app pide el permiso de **notificaciones** (Android 13+) para que el aviso sea
  visible. Si el usuario lo deniega, el servicio **sigue funcionando**; la
  pantalla simplemente lo indica como "no visible".
- En Android 11+, el permiso de ubicacion "todo el tiempo" **no** se concede con
  un dialogo: `requestBackgroundPermissionsAsync` abre los ajustes y el usuario
  debe elegir **"Permitir todo el tiempo"**.

Permisos declarados (los añade el plugin de `expo-location`, ver
`app.json`):

```
ACCESS_COARSE_LOCATION, ACCESS_FINE_LOCATION,
ACCESS_BACKGROUND_LOCATION, FOREGROUND_SERVICE,
FOREGROUND_SERVICE_LOCATION, POST_NOTIFICATIONS,
RECEIVE_BOOT_COMPLETED
```

## 4. iOS: modo de ubicacion en segundo plano

iOS usa **Core Location** con el modo de ubicacion en segundo plano:

- `UIBackgroundModes: ["location"]` en el `Info.plist` (lo añade el plugin con
  `isIosBackgroundLocationEnabled`).
- Descripciones de uso `NSLocationWhenInUseUsageDescription` y
  `NSLocationAlwaysAndWhenInUseUsageDescription`.
- Se habilita la opcion **"Siempre"**; si el usuario elige "Al usar la app" o
  "Permitir una vez", el seguimiento en segundo plano no se activa y la app lo
  explica, ofreciendo abrir los ajustes.
- Con `showsBackgroundLocationIndicator: true`, iOS muestra el **indicador azul**
  del sistema mientras hay ubicacion en segundo plano (transparencia para el
  usuario).

## 5. Flujo de permisos: no se pregunta en cada arranque

Objetivo: pedir los permisos **una vez**, en un contexto explicado, y respetar la
decision. La logica vive en `src/lib/permissions.ts`.

| Situacion                                   | Comportamiento                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| Primera vez                                 | Se explica y se piden: ubicacion precisa en primer plano y luego segundo plano. |
| Arranques posteriores, permiso concedido    | Se consulta el estado (`get*PermissionsAsync`); **no** se muestra el dialogo.   |
| Permiso en segundo plano pendiente          | Se avisa y se ofrece **Abrir ajustes**; no se repite el dialogo cada vez.       |
| Permiso revocado                            | Se detecta y se ofrece **Abrir ajustes**; no se insiste en bucle.               |
| Volver a la app tras cambiar en Ajustes     | El estado se refresca al recuperar el foco (`AppState`).                        |

La app **respeta** el permiso concedido y **reanuda** el seguimiento cuando las
condiciones del dispositivo lo permiten. Nunca activa el GPS de forma silenciosa
ni impide que se revoquen los permisos.

## 6. Sin conexion o señal debil

Si el envio falla por red, la lectura **no se pierde**:

1. Cada coordenada se guarda en una **cola persistente** en el telefono (hasta 50
   lecturas); la mas antigua se descarta si se supera el limite.
2. Al recuperar la conexion, la tarea las reenvia **en orden cronologico**.
3. Como el dato conserva su `recordedAt` (momento de captura), el panel lo
   muestra **antiguo**, nunca como recien llegado. Ver la politica de frescura en
   [`tiempo-real.md`](tiempo-real.md).

La cola sobrevive al cierre de la pantalla y al paso de la app a segundo plano,
porque vive en almacenamiento persistente, no en memoria.

## 7. Que ocurre segun el estado del telefono

| Estado del dispositivo                              | Comportamiento esperado                                        |
| --------------------------------------------------- | -------------------------------------------------------------- |
| Aplicacion abierta                                  | Ubicacion en vivo                                              |
| Cambia a otra aplicacion                            | Continua compartiendo (con permisos adecuados)                 |
| Pantalla bloqueada                                  | Puede continuar el seguimiento en segundo plano                |
| Aplicacion quitada de recientes                     | Depende del sistema y del fabricante                           |
| Aplicacion **forzada a detenerse**                  | **No se puede garantizar** que continue enviando               |
| Celular sin conexion                                | Se guarda y se reenvia cuando sea posible                      |
| Celular apagado                                     | No envia nuevas ubicaciones                                    |
| Permiso revocado                                    | Deja de enviar; la app avisa y ofrece abrir los ajustes        |

## 8. Limites honestos (lo que NO se promete)

Conceder el permiso de segundo plano **no** convierte la app en un rastreador
incondicional. Android e iOS pueden suspender o terminar la app por razones de
**bateria, privacidad o configuracion**, y la documentacion de Expo lo confirma:
el seguimiento se detiene cuando el usuario **termina** la aplicacion. En
consecuencia:

- no se garantiza el envio **tras un cierre forzado**;
- no se garantiza el envio con el **telefono apagado**;
- no se garantiza nada si el usuario **revoca los permisos**;
- la **frecuencia real** la decide el sistema: `intervalMs` es una peticion, no
  una promesa (Android la respeta; iOS la aproxima segun el movimiento).

Esto no es un defecto del proyecto: es el limite del sistema operativo, y el
panel lo refleja mostrando la **hora de la ultima ubicacion recibida** para no
confundir un dato viejo con uno actual.

## 9. Por que hace falta una compilacion nativa

Las funciones de ubicacion en segundo plano **no estan disponibles en Expo Go**.
Por eso el proyecto usa `expo-location` + `expo-task-manager` y se compila un
**build nativo** (el APK release descrito en
[`compilacion-android.md`](compilacion-android.md)). `expo-task-manager` y
`@react-native-async-storage/async-storage` son modulos nativos y requieren
volver a compilar el APK.

## 10. Archivos implicados

| Archivo                                       | Responsabilidad                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/mobile/index.js`                        | Registra la tarea en el ambito global del bundle.                            |
| `apps/mobile/src/lib/background-location.ts`  | Define la tarea, arranca/para el servicio y hace los envios (`flushPositions`). |
| `apps/mobile/src/lib/tracking-store.ts`       | Persistencia de sesion, cola de pendientes y estadisticas (AsyncStorage).    |
| `apps/mobile/src/lib/permissions.ts`          | Flujo de permisos (primer plano -> segundo plano) y aviso de ajustes.        |
| `apps/mobile/src/hooks/useTracking.ts`        | Orquesta inicio/parada y mantiene el estado visible de la pantalla.          |
| `apps/mobile/src/screens/TrackingScreen.tsx`  | Indicadores de estado, permisos y la tabla honesta de comportamiento.        |
| `apps/mobile/app.json`                        | Flags del plugin `expo-location` (segundo plano + servicio en primer plano). |

## 11. Como verificarlo

En el telefono, con el APK release instalado y la API en marcha en el PC:

1. Inicia sesion y elige el dispositivo: los permisos se piden solos.
2. Concede la ubicacion precisa y, cuando se pida, **"Permitir todo el tiempo"**.
3. Al concederlos, la comparticion arranca sola: en Android veras la
   **notificacion permanente**; en iOS, el **indicador azul**.
4. Bloquea la pantalla o cambia de aplicacion durante un minuto.
5. Comprueba que siguen llegando lecturas:
   - en la app: "Lecturas aceptadas" y "Ultimo intento de envio" avanzan;
   - en la API: `node scripts/watch-live.mjs` registra `location:update`.
6. Desactiva el Wi-Fi/red, mueve el telefono y reactiva la red: las lecturas
   guardadas se reenvian y aparecen con su hora de **captura** original.
7. Forzar la detencion de la app: las lecturas se detienen (comportamiento
   esperado del sistema, no un fallo).

La verificacion automatica del cableado de configuracion (permisos en el
manifest, `UIBackgroundModes`, tarea registrada en el bundle) se ejecuta con:

```bash
pnpm test:background
```
