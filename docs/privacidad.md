# Privacidad y marco legal (Colombia)

> **Aviso.** Este documento es un analisis academico de como el sistema se alinea
> con la normativa colombiana de proteccion de datos. **No es asesoria
> juridica.** Antes de un uso real, una organizacion debe revisar su politica de
> tratamiento con un abogado y registrarla ante la autoridad competente.

## Marco normativo aplicable

| Norma                                                          | Aporte                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Constitucion Politica**, art. 15                             | Derecho a la intimidad personal y familiar, y a conocer, actualizar y rectificar la informacion recogida sobre uno en bases de datos.                                                                        |
| **Ley 1581 de 2012**                                           | Regimen general de proteccion de datos personales: principios, derechos del titular, deberes de quien trata datos y categorias especiales.                                                                   |
| **Decreto 1377 de 2013**                                       | Reglamenta la Ley 1581: contenido de la autorizacion, aviso de privacidad, politicas de tratamiento y transferencia internacional.                                                                           |
| **Decreto 1074 de 2015** (compilatorio), arts. 2.2.2.25 y ss.  | Define datos sensibles (incluye datos biometricos) y las reglas del Registro Nacional de Bases de Datos (RNBD).                                                                                              |
| **Guias de la SIC** (Superintendencia de Industria y Comercio) | Autoridad de control. Sus guias interpretan el tratamiento de datos emergentes, entre ellos los de **geolocalizacion**, y exigen medidas reforzadas por su capacidad de revelar aspectos de la vida privada. |
| **Ley 527 de 1999**                                            | Validez del consentimiento electronico, base para autorizar desde una app.                                                                                                                                   |

## Que trata este sistema

| Dato                                       | Naturaleza                       | Rol                                                                |
| ------------------------------------------ | -------------------------------- | ------------------------------------------------------------------ |
| Correo electronico                         | Dato personal                    | Identifica la cuenta.                                              |
| Hash de contrasena                         | Dato personal, credencial        | Deriva de un dato personal; nunca se guarda la contrasena.         |
| Coordenadas (latitud, longitud, precision) | Dato personal de **ubicacion**   | El nucleo del sistema.                                             |
| Marca temporal                             | Dato personal                    | Sin ella, una coordenada pierde casi todo su valor identificativo. |
| Identificador y nombre de dispositivo      | Dato personal                    | Vincula la ubicacion a un equipo.                                  |
| Estado del permiso de ubicacion            | Dato personal, contextual        | `granted_background`, `granted_foreground`, etc.; ayuda al panel.  |
| Version de la app y del sistema            | Dato tecnico, poco identificativo | Contexto de soporte del dispositivo.                              |
| Direccion IP                               | Dato personal                    | Se registra en la auditoria.                                       |
| Metadatos de auditoria                     | Personal, variable               | Cifrados en reposo.                                                |
| Direccion aproximada (geocodificacion)     | Derivado, obtenido de un tercero | Estimacion del proveedor; solo si esta activo (ver nota abajo).    |
| Video y audio en directo (acceso remoto)   | Dato de cuidado; **no se almacena** | Solo con consentimiento explicito; viaja por WebRTC y no se graba. |

### ¿Son datos sensibles?

La Ley 1581 (art. 6) no enumera la ubicacion entre los datos sensibles. Sin
embargo, la lectura de la SIC y la practica internacional (por ejemplo el RGPD
europeo, que la clasifica como dato de categoria especial cuando se trata a gran
escala) es clara: **una traza de ubicacion revela habitos, domicilio, lugar de
trabajo, creencias y estado de salud** por inferencia, aunque cada punto aislado
no lo haga.

Por eso el proyecto **trata la ubicacion como dato de cuidado reforzado**, no como
un dato comun:

- no se mide ni se perfila: no hay analitica de movimiento, ni puntuaciones, ni
  busqueda de patrones;
- solo el titular y quien el autorice pueden consultarla;
- se retiene el menor tiempo util;
- la autorizacion es explicita, no inferida.

Criterio de diseno: **el sistema nunca deduce ubicacion de datos personales; solo
almacena coordenadas que el propio dispositivo aporta con autorizacion.**

### La direccion aproximada y los proveedores externos

La **geocodificacion inversa** (traducir coordenadas a una direccion legible) no la
hace el sistema: es un servicio de terceros (`GEOCODING_PROVIDER`). Tener una
direccion no significa que el GPS conozca la puerta exacta; el proveedor devuelve
una estimacion.

Este es un punto relevante para la Ley 1581, porque implica **transferir
coordenadas a un tercero**. Por eso:

| Medida                                           | Efecto                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Es opcional (`GEOCODING_PROVIDER=disabled`)      | Se puede operar sin enviar ni un byte al proveedor.                                   |
| Proveedor por defecto: Nominatim (OpenStreetMap) | Sin clave y con politica de uso limitado; Google solo si se configura en el servidor. |
| Redondeo a 4 decimales (~11 m) y cache           | No se envia cada lectura: se consulta una unica vez por tramo y se reutiliza.         |
| Intervalo minimo entre llamadas                  | Respeta el limite de ritmo del proveedor y reduce el volumen transferido.             |
| La clave de Google se queda en el backend        | No se expone al navegador ni al telefono.                                             |
| Direccion solo en `null` si no hay datos         | El sistema **nunca** rellena ni inventa una direccion para parecer mas preciso.       |

El aviso de privacidad y el registro de autorizacion deben mencionar este envio
como parte de la finalidad. Si el proyecto se desplegara en produccion, convendria
elegir proveedor segun el lugar de residencia de los titulares para evitar
transferencias internacionales innecesarias (ver `Cumplimiento pendiente`).

## Principios de la Ley 1581 aplicados en concreto

La Ley 1581 (art. 4) fija principios. Aqui estan aterrizados en el sistema:

| Principio                            | Como se cumple                                                                                                       | Donde                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Legalidad**                        | Solo se trata ubicacion de quien la autoriza desde su propio equipo.                                                 | Todo el diseno                             |
| **Finalidad**                        | La ubicacion sirve para mostrarla en el panel del titular. No hay otro uso.                                          | Sin analitica ni reventa                   |
| **Libertad**                         | Compartir es un acto positivo: hay que pulsar _Iniciar comparticion_. No hay valor por defecto ni captura implícita. | `TrackingScreen`, `POST /shares`           |
| **Veracidad**                        | Se guarda `recorded_at` (captura) y no se inventa frescura; un dato viejo se muestra viejo.                          | `classifyFreshness`, `LOCATION_FRESHNESS`  |
| **Transparencia**                    | La app explica que se envia y con que frecuencia; el historial es consultable.                                       | `TrackingScreen`, `GET /locations/history` |
| **Acceso y circulacion restringida** | Autorizacion por propietario en cada recurso; el WebSocket verifica propiedad antes de suscribir.                    | `findOwnedOrThrow`, `LiveGateway`          |
| **Seguridad**                        | scrypt, tokens hasheados, AES-256-GCM, TLS en despliegue.                                                            | Ver [`seguridad.md`](seguridad.md)         |
| **Confidencialidad**                 | Nadie mas que el titular puede leer sus datos; metadatos de auditoria cifrados.                                      | `AuditService`                             |

## La autorizacion

La Ley 1581 y el Decreto 1377 exigen autorizacion **previa, expresa e
informada**. En este sistema no es un texto legal enterrado en unos terminos: es
un acto tecnico verificable.

1. **Previa.** El dispositivo no envia nada hasta que el usuario pulsa _Iniciar
   comparticion_. La app no captura ubicacion al abrirse.
2. **Expresa.** El sistema operativo pide el permiso de ubicacion con un dialogo
   propio del sistema (`requestForegroundPermissionsAsync`). Para seguir con la
   pantalla bloqueada se solicita ademas el permiso de **segundo plano**
   (`requestBackgroundPermissionsAsync`): en Android 11+ eso abre los ajustes y
   el usuario debe elegir "Permitir todo el tiempo"; en iOS se elige "Siempre".
   Sin concesion explicita, no hay captura, y la app informa del motivo.
3. **Informada.** La pantalla dice que se envia, cada cuanto y a donde; el panel
   separa "en vivo", "datos antiguos" y "desconectado". Mientras se comparte en
   segundo plano, Android muestra una notificacion permanente y iOS el indicador
   azul del sistema.
4. **Delimitada.** La autorizacion dura lo que dura la sesion
   (`expires_in_minutes`); al vencer, deja de aceptarse la ingesta.
5. **Revocable en cualquier momento.** Un toque en _Detener comparticion_. Si el
   permiso se revoca desde los ajustes, la app no vuelve a pedirlo en cada
   arranque: lo detecta y ofrece abrir los ajustes.

#### Limites que no se pueden saltar

Conceder el permiso de segundo plano **no** convierte la app en un rastreador
incondicional. El sistema operativo conserva el control:

- si el usuario **fuerza la detencion** de la app, Android e iOS pueden no
  volver a lanzar la tarea;
- por **bateria o privacidad**, el sistema puede suspender la captura;
- con el **telefono apagado** o **sin conexion**, no hay envio en vivo (las
  lecturas sin red se guardan y se reenvian despues);
- el servicio en primer plano de Android solo puede iniciarse **desde la app en
  primer plano**, es decir, tras una accion del usuario.

Estos limites son de diseno, no un fallo: se documentan en
[`segundo-plano.md`](segundo-plano.md).

Base de registro: cada inicio y cierre de autorizacion queda en `audit_logs`
(`share.start`, `share.stop`, `share.revoke`) con marca temporal e IP. La ingesta
de cada coordenada no se audita individualmente: la autorizacion que la ampara si
queda registrada al abrir la sesion.

El **acceso remoto a camara y microfono** sigue la misma logica: solicitar,
aceptar, rechazar y cerrar dejan registro (`remote.request.*`, `remote.session.*`),
y el video o el audio **no se almacenan** en ningun momento: viajan de extremo a
extremo por WebRTC. Ver [`acceso-remoto.md`](acceso-remoto.md).

## Derechos del titular y como se ejercen

Los derechos de la Ley 1581 (art. 8) no se quedan en el papel: cada uno tiene una
via en el sistema.

| Derecho (Ley 1581, art. 8)       | Como se ejerce                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Conocer** sus datos            | `GET /auth/me`, `GET /locations/latest`, `GET /locations/history`, `GET /auth/audit`                                       |
| **Actualizar y rectificar**      | `PATCH /devices/:id` (renombrar); las coordenadas son mediciones y no se reescriben, se corrigen aportando lecturas nuevas |
| **Suprimir**                     | `DELETE /devices/:id`: borra el dispositivo y, en cascada, sus sesiones y **todas** sus ubicaciones                        |
| **Revocar la autorizacion**      | `POST /shares/:id/stop` (voluntario) o `/revoke` (corte inmediato); desde ese instante la ingesta responde `403`           |
| **Presentar quejas ante la SIC** | Procedimiento de la entidad; este sistema no lo sustituye                                                                  |
| **Acceso gratuito**              | Todas las consultas de datos propios son gratuitas e inmediatas                                                            |

**Borrado real, no marcado.** Eliminar un dispositivo usa `onDelete: Cascade`:
las coordenadas desaparecen de la tabla `locations`. No se conserva una copia
"por si acaso".

**Nota sobre la revocacion.** Detener la comparticion **no** borra el historial ya
recibido; solo corta la captura futura. Son dos derechos distintos (revocar vs.
suprimir) y el sistema los mantiene separados, como corresponde.

## Retencion

La Ley 1581 no fija plazos concretos: obliga a que la retencion sea **necesaria y
proporcionada** a la finalidad.

Politica del proyecto:

| Dato                   | Retencion propuesta                                    | Fundamento                                                                             |
| ---------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Ubicaciones            | 30 dias, o menos si el titular las borra antes         | Suficiente para revisar un recorrido reciente; mas tiempo eleva el riesgo sin utilidad |
| Sesiones (refresh)     | 30 dias o hasta el cierre de sesion                    | Vida del refresh token                                                                 |
| Registros de auditoria | 12 meses, con `actor_id` anulado si se borra la cuenta | Trazabilidad de accesos sin conservar el vinculo personal                              |
| Cuenta                 | Hasta que el titular la elimine                        | —                                                                                      |

**Pendiente de implementar**: una tarea programada de purga. Hoy el borrado es
bajo demanda (`DELETE /devices/:id`); falta el vencimiento automatico por
antiguedad. Esta reconocido como deuda tecnica en
[`seguridad.md`](seguridad.md).

## Por que no se puede obtener la ubicacion de un numero de telefono

Es la pregunta que el trabajo academico debe responder, y la respuesta tiene una
cara legal ademas de la tecnica ([`investigacion.md`](investigacion.md)):

1. **El numero no es la ubicacion.** El numero identifica una linea contratada,
   no un punto en el mapa. No hay, para un particular, ninguna via tecnica ni
   legal que lo traduzca a coordenadas.
2. **La red del operador no es de acceso publico.** El operador puede estimar la
   posicion por celda, pero es un dato de infraestructura critica. Acceder a el
   exige cooperacion del operador y, en Colombia, una **orden de autoridad
   judicial competente** para interceptar comunicaciones (reserva legal). Una
   aplicacion no puede pedirlo ni obtenerlo.
3. **Sin base legal, no se trata.** La Ley 1581 exige una base para tratar datos
   personales (autorizacion del titular o mandato legal). Rastrear a alguien sin
   su autorizacion, ni con la excusa de "tener su numero", seria tratamiento
   ilicito, con sanciones de la SIC (multas y, en ciertos casos, responsabilidad
   penal).
4. **El consentimiento ajeno no existe.** El titular de la ubicacion es la persona
   que lleva el telefono. Autorizar la comparticion de un tercero no esta en manos
   de quien teclea el numero.

Conclusion del sistema: **la unica geolocalizacion licita y tecnicamente solida es
la del dispositivo que ejecuta una aplicacion y autoriza la comparticion.** Este
proyecto implementa ese camino y **no** ofrece, ni simula, el atajo del numero de
telefono. En el modulo de investigacion solo se usan numeros ficticios y jamas se
intenta extraer coordenadas de ellos.

## Cumplimiento pendiente (fuera del alcance academico)

Lo que un despliegue real necesitaria y este prototipo **no** incluye:

1. **Politica de tratamiento de datos personales** publicada y accesible.
2. **Aviso de privacidad** en el momento de la recoleccion (hoy la app informa,
   pero no hay documento normativo formal).
3. **Registro Nacional de Bases de Datos (RNBD)** ante la SIC, cuando aplique por
   volumen o naturaleza.
4. **Procedimiento formal de consultas y reclamos** (Ley 1581, arts. 14 y 15) con
   plazos y responsables definidos.
5. **Reglas de transferencia internacional** si la base de datos o la nube se
   alojan fuera de Colombia.
6. **Purga automatica** por antiguedad (descrita arriba).
7. **Designacion de un responsable** del tratamiento y de un canal de contacto
   para el ejercicio de derechos.

## Sintesis

El sistema se construyo con tres convicciones:

- **La ubicacion de una persona no se obtiene, se autoriza.** Sin un acto
  explicito del titular, no hay dato.
- **La autorizacion debe poder retirarse de verdad.** Detener la comparticion
  funciona de inmediato, no dentro de 24 horas.
- **Los datos del titular son suyos.** Se consultan facilmente, se borran de
  verdad y no se conservan mas de lo necesario.

Ese enfoque es, a la vez, una buena practica de ingenieria y la forma mas directa
de cumplir la Ley 1581 de 2012.
