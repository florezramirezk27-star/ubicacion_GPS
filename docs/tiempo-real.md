# Tiempo real: alcance, limites y politica de frescura

Este documento responde a la pregunta central del proyecto y deja por escrito
que **"tiempo real" no significa GPS continuo e instantaneo**.

## 1. Que se puede y que no se puede hacer

| Escenario                                                                    | Resultado                                 | Motivo                                                                                                                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Conocer la ubicacion de un dispositivo a partir de su **numero de telefono** | **Imposible**                             | El numero identifica una linea, no emite coordenadas. No existe API publica ni legal que traduzca MSISDN -> GPS.                            |
| Conocer la ubicacion por la **red del operador** (celdas)                    | Solo aproximada y con acceso privilegiado | El operador conoce la celda, no el punto exacto. Requiere convenio y orden legal; la precision tipica es de cientos de metros a kilometros. |
| Conocer la ubicacion por **GPS del dispositivo con autorizacion**            | Exacta (metros)                           | El receptor GPS calcula la posicion y la app la envia. Requiere consentimiento explicito del usuario en el equipo.                          |

La plataforma implementa **unicamente el tercer caso**. El numero de telefono
nunca se usa como entrada de geolocalizacion; ver `docs/investigacion.md` y
`docs/privacidad.md`.

## 2. Tabla de caracteristicas en tiempo real

| Caracteristica                 | Estado       | Como funciona                                                                                                                                                      |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ubicacion en vivo en el mapa   | Implementado | El movil envia por HTTP; la API difunde `location:update` por WebSocket y el marcador se mueve sin recargar.                                                       |
| Frecuencia configurable        | Implementado | El intervalo de captura se elige en la app (`expo-location`). El sistema operativo decide la entrega real; el backend acepta lo que llegue dentro de la sesion activa.     |
| Estado del dispositivo         | Implementado | `CURRENT` / `STALE` / `OFFLINE` / `UNKNOWN`, calculado por el servidor y replicado en el panel.                                                                    |
| Precision GPS en metros        | Implementado | Campo `accuracyMeters` obligatorio en cada lectura; se rechaza mas de 5000 m por ser una lectura no fiable.                                                        |
| Historial con retencion        | Implementado | `GET /locations/history` con rango `from`/`to` y limite. Retencion configurable (ver `docs/privacidad.md`).                                                        |
| Pausar la comparticion         | Implementado | `POST /shares/:id/stop`. Desde ese instante la ingesta se rechaza con 403.                                                                                         |
| Panel global de administracion | Implementado | `AdminGateway` (namespace `/admin`) difunde `admin:location` y `admin:device-status` a la sala de superadministradores. Solo entra quien revalida el rol en la BD. |
| Direccion aproximada           | Implementado | Geocodificacion inversa con cache y limite de ritmo; la direccion es una estimacion del proveedor, nunca una certeza (`docs/admin.md`).                            |
| Seguimiento en segundo plano   | Implementado | `expo-location` + `expo-task-manager`: servicio en primer plano en Android (notificacion visible) y modo de ubicacion en iOS. Sigue con la app minimizada o la pantalla bloqueada; el sistema puede suspenderlo (`docs/segundo-plano.md`). |
| Cola sin conexion persistente  | Implementado | Si no hay red, las lecturas se guardan en el telefono y se reenvian al recuperar la conexion; sobreviven al cierre de la pantalla (`docs/segundo-plano.md`).       |

## 3. Politica de frescura (antiguedad del dato)

Los umbrales viven en `packages/shared/src/enums.ts` para que el backend y el
panel web coincidan exactamente y el mapa **nunca muestre como actual algo que
el servidor considera viejo**.

| Estado    | Condicion                                                        | Que muestra el panel     |
| --------- | ---------------------------------------------------------------- | ------------------------ |
| `CURRENT` | antiguedad <= 120 s                                              | "En vivo" (verde)        |
| `STALE`   | 120 s < antiguedad <= `STALE_AFTER_MINUTES` (por defecto 15 min) | "Datos antiguos" (ambar) |
| `OFFLINE` | antiguedad > `STALE_AFTER_MINUTES`                               | "Desconectado" (rojo)    |
| `UNKNOWN` | el dispositivo nunca reporto                                     | "Sin datos" (gris)       |

Se calcula sobre `recordedAt` (momento en que el GPS obtuvo la coordenada), no
sobre la hora de recepcion, para no "rejuvenecer" un dato que estuvo mucho
tiempo en la cola del telefono.

### 3.1. Por que no se finge frescura

- Si el telefono se apaga o pierde red, **deja de llegar `location:update`**.
  El marcador se queda donde estaba y su antiguedad crece.
- A los 120 s el panel cambia a "Datos antiguos"; a los 15 min, a
  "Desconectado". En ningun momento se muestra una posicion inventada ni se
  proyecta un movimiento.
- El reloj del panel se actualiza cada 5 s para recalcular la antiguedad aunque
  no lleguen datos nuevos.

### 3.2. Marcas de tiempo

- El backend tolera como maximo 60 s de adelanto (`MAX_FUTURE_SKEW_MS`) para
  absorber desajustes de reloj entre dispositivos.
- Si `recordedAt` se omite, se usa la hora de recepcion.

## 4. Camino de un dato

```
expo-location (GPS)
   -> tarea del sistema (expo-task-manager; servicio en primer plano en Android)
      -> POST /locations  (cabecera X-Share-Token)
         -> ShareTokenGuard valida el token contra su hash en la sesion ACTIVE
            -> LocationsService.ingest()  (INSERT en locations, trigger PostGIS)
               -> LiveGateway.emitLocation()      -> sala device:<id> -> panel web
               -> LiveGateway.emitDeviceStatus()  -> sala device:<id> -> panel web
               -> AdminGateway.emitLocation()     -> sala admin      -> panel de administracion
               -> GeocodingService.resolve()   (segundo plano: cache + proveedor)
```

El **movil no mantiene un socket**: envia por HTTP porque es mas fiable cuando
la app se suspende. El WebSocket existe para difundir a los observadores.

## 4.1. Seguimiento en segundo plano (resumen)

El envio ya no depende de tener el movil en la pantalla de captura. Una **tarea
del sistema** (`geo-background-location`, registrada con `expo-task-manager`)
recibe las coordenadas del servicio de ubicacion y las envia. En Android ese
servicio es un **servicio en primer plano** con una notificacion permanente; en
iOS usa el modo de ubicacion en segundo plano. Si no hay red, la lectura se
guarda en una cola persistente y se reenvia al recuperar la conexion.

Lo que sigue siendo cierto (y no se promete de mas): el sistema operativo puede
suspender o terminar la app por bateria, privacidad o configuracion; si el
usuario **fuerza la detencion** o revoca el permiso, el envio no esta garantizado.
El detalle esta en [`segundo-plano.md`](segundo-plano.md).

## 5. Confirmacion de alcance

Un observador solo recibe `location:update` si:

1. esta autenticado con un JWT valido en el handshake, y
2. se suscribio a un dispositivo **del que es propietario** (el servidor lo
   verifica contra la base de datos antes de unirlo a la sala).

Por tanto, no es posible observar un dispositivo ajeno ni introduciendo un
numero de telefono ni adivinando un identificador.

La unica excepcion es el **Superadministrador**, que se conecta a un namespace
distinto (`/admin`) y recibe el flujo global `admin:location`. No es una puerta
trasera silenciosa:

- el rol se revalida contra la base de datos en cada conexion;
- un usuario normal no puede ni conectarse a ese namespace;
- cada consulta de ficha o historial queda auditada (`admin.device.view`,
  `admin.history.view`).

Ver [`admin.md`](admin.md) y [`seguridad.md`](seguridad.md).
