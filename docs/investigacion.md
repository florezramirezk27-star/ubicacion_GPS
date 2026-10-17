# Investigacion: comparacion de metodos de localizacion

> **Componente academico del proyecto.** Este documento compara las tres vias por
> las que se ha planteado, historicamente, "averiguar donde esta un telefono":
> el numero por si solo, la red del operador movil y el GPS del propio aparato.

## Advertencia de alcance y etica

Este trabajo es un **analisis comparativo**. El sistema que lo acompana
**localiza unicamente dispositivos que ejecutan la aplicacion y han autorizado la
comparticion**.

- El modulo de investigacion usa **exclusivamente numeros ficticios**. No hay
  ningun dato real de personas.
- **No se intenta, ni se intentara, extraer coordenadas de un numero de
  telefono.** El resultado central del estudio es, precisamente, que eso no es
  posible (ni legal) para un particular o una aplicacion.
- Las referencias a la red del operador se incluyen para explicar por que una
  aplicacion de terceros **no** puede usarla, no como una via a implementar.

## Pregunta de investigacion

> Con que precision, con que requisitos legales y con que viabilidad puede
> determinarse la ubicacion de un telefono mediante (A) su numero, (B) la red del
> operador movil, o (C) el GPS del propio dispositivo con autorizacion?

## Los tres metodos

### Metodo A - Solo el numero de telefono

Un numero E.164 identifica una **linea contratada** (una suscripcion a un
servicio), no un objeto fisico ni una posicion. Es un identificador, no una
coordenada.

No existe para un particular ninguna relacion matematica, base de datos publica
ni interfaz de red que traduzca un numero a una latitud y una longitud. Lo unico
que un numero permite, de forma indirecta y aproximada, es:

- identificacion de llamadas (reputacion, si es spam, a nombre de quien figura);
- directorios y busquedas inversas, que pueden asociar el numero a un titular;
- y nada mas que tenga que ver con la posicion del aparato.

**Nota sobre el fraude.** Existen sitios que prometen "escribe un numero y mira
su ubicacion en un mapa". Son enganos: devuelven una ubicacion generica (el centro
geografico de la ciudad o del pais del prefijo), o piden instalar software
malicioso. **Ninguno** accede a la posicion real. Es la version moderna de una
estafa antigua, y su existencia es, en si misma, evidencia de que el dato no esta
disponible.

### Metodo B - Red del operador movil (autorizado)

Es el unico metodo que **no** depende del telefono ni de una aplicacion instalada:
lo sabe el operador, porque el terminal se registra continuamente en la red.

| Tecnica                           | Como funciona                                                  | Precision tipica (literatura)                                 |
| --------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| **Cell ID**                       | La red sabe en que celda esta registrado el terminal.          | 100 m - 3 km en urbano; hasta 35 km en rural (celdas grandes) |
| **Cell ID + Timing Advance (TA)** | El avance temporal de la senal acota la distancia a la antena. | ~550 m de resolucion por paso de TA                           |
| **Trilateracion / OTDOA**         | Varias antenas miden diferencias de tiempo de llegada.         | 50 - 150 m en exteriores                                      |
| **A-GNSS**                        | La red asiste al receptor GNSS con datos orbitales.            | 5 - 10 m (pero ya usa el GPS del aparato)                     |

**Requisitos y limites:**

- cooperacion **del operador**: hay que consultar su infraestructura (HLR/HSS, y
  el nodo de posicionamiento, GMLC);
- **autorizacion legal**: en Colombia la interceptacion y el acceso a datos de
  trafico requieren **orden de autoridad judicial competente** (reserva legal).
  No es accesible a un particular ni a una aplicacion;
- SIM activa y con cobertura: sin red, el operador no sabe nada;
- funciona incluso con telefonos sin GPS y sin apps, y es el unico metodo que
  sirve, por ejemplo, para emergencias a traves del 123/911.

**Para este proyecto: no disponible.** No por un limite tecnico del prototipo,
sino porque el acceso esta reservado a la autoridad.

En algunos paises existen servicios comerciales de localizacion de familiares
para el titular de la linea; incluso esos operan con consentimiento verificado
del titular y siendo el operador el que consulta su propia red.

### Metodo C - GPS del dispositivo con autorizacion (el implementado)

Es el unico metodo viable para una aplicacion de terceros.

El chip GNSS del telefono calcula su posicion triangulando las senales de
satelites (GPS, GLONASS, Galileo, BeiDou). El sistema operativo expone la lectura
y el permiso a las aplicaciones.

| Aspecto                    | Comportamiento                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Precision tipica**       | 3 - 10 m en cielo abierto; 5 - 20 m en calle urbana; se degrada a 30 - 100 m en interiores o canones urbanos                     |
| **Latencia de la lectura** | Practicamente inmediata (unos segundos); la primera lectura en frio puede tardar 30 s o mas                                      |
| **Cobertura**              | Mundial, siempre que haya vista al cielo                                                                                         |
| **Requisitos**             | Permiso del usuario; aplicacion en ejecucion (primer plano o segundo plano); bateria; el aparato debe poder calcular su posicion |
| **Base legal**             | **Autorizacion del titular** (Ley 1581 de 2012)                                                                                  |
| **Dependencia externa**    | Ninguna: ni operador, ni orden judicial                                                                                          |

**Matiz honesto.** Los sistemas operativos modernos combinan fuentes: cuando el
GNSS no basta (interiores), usan Wi-Fi y senales de celda para dar una posicion
suficientemente buena. Por eso la precision que reporta el propio sistema
(el campo `accuracyMeters` que guarda este proyecto) es una **estimacion de
incertidumbre**, no una garantia.

### El chip GPS no genera direcciones: geocodificacion inversa

Distincion que suele pasarse por alto y que conviene dejar explicita:

|                       | **Obtener la posicion**                      | **Nombrar el lugar**                                         |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| Que hace              | El receptor GNSS calcula latitud y longitud  | Un servicio externo busca ese punto en una base de toponimos |
| Quien lo hace         | El propio telefono                           | Un tercero (Nominatim/OpenStreetMap, Google, ...)            |
| Precision             | 3 - 20 m (y una estimacion `accuracyMeters`) | Depende del proveedor y de la resolucion del callejero       |
| Funciona sin internet | **Si**                                       | **No** (salvo bases locales)                                 |
| Coste                 | Cero                                         | Sujeto a limite de uso                                       |

Ningun receptor GPS de consumo devuelve "Calle 108 # 13-20"; devuelve
`7.12230, -73.13691`. Que el panel muestre una calle no significa que el GPS
conozca la puerta: esa traduccion es una **estimacion del proveedor** aplicada
sobre un punto que ademas tiene su propia incertidumbre (el circulo de
`accuracyMeters`).

En este proyecto esa capa es opcional (`GEOCODING_PROVIDER=disabled|nominatim|google`),
esta **cacheada** y con **intervalo minimo** entre llamadas; si el proveedor no
responde o no hay datos suficientes, la direccion queda en `null` y el panel lo
dice. **Nunca se rellena una direccion por parecer mas completo.** La
implementacion y sus limites estan en [`admin.md`](admin.md).

## Comparacion directa

| Criterio                               | A. Numero solo | B. Red del operador           | C. GPS autorizado                      |
| -------------------------------------- | -------------- | ----------------------------- | -------------------------------------- |
| Identifica una posicion                | **No**         | Si                            | Si                                     |
| Precision                              | No aplica      | 50 m - 35 km                  | 3 - 20 m                               |
| Necesita app en el telefono            | No             | No                            | **Si**                                 |
| Necesita permiso del titular           | No aplica      | No (requiere orden judicial)  | **Si**                                 |
| Necesita cooperacion del operador      | No aplica      | **Si**                        | No                                     |
| Funciona sin cobertura celular         | No             | No                            | Si (solo necesita cielo)               |
| Funciona sin acceso a la red           | No             | Si                            | Si (la lectura; el envio necesita red) |
| Accesible a una aplicacion de terceros | **No**         | **No**                        | **Si**                                 |
| Coste marginal                         | No aplica      | Muy alto (acceso restringido) | Cero (ya en el telefono)               |
| Base legal para usarlo                 | Inexistente    | Orden judicial                | Autorizacion del titular               |
| **Viable en este proyecto**            | **No**         | **No**                        | **Si**                                 |

## Por que el Metodo A es imposible

Esta es la conclusion que el trabajo debe dejar clara, y tiene dos caras
independientes. Basta con que falle una para descartar el metodo.

### Razon tecnica

El numero de telefono y la posicion son datos de **naturaleza distinta y
ubicacion distinta**:

- el numero vive en el **plano logico** del servicio (una suscripcion en la base
  de datos de un operador);
- la posicion vive en el **plano fisico** (el aparato, que se mueve).

No hay un canal, una consulta ni un protocolo publico que los conecte. El numero
no contiene la posicion, del mismo modo que el numero de pasaporte no contiene la
direccion de tu casa: identifica, no ubica. La unica entidad que relaciona ambos
es el operador, y solo de forma **interna y dinamica** (sabe la celda actual, que
cambia cada vez que te mueves).

Ademas, aun con el mejor de los casos:

- **no hay red de retorno**: aunque alguien descubriera la celda, nadie se la
  daria a un tercero;
- **el dueno del dato es el titular, no quien teclea el numero**: tener el numero
  de otra persona no otorga ningun derecho sobre su ubicacion;
- **el numero es portatil y reutilizable**: puede cambiar de operador (portabilidad
  numerica) o de titular con el tiempo, de modo que ni siquiera identifica de
  forma estable.

### Razon legal (Colombia)

- La **Ley 1581 de 2012** exige una base licita para tratar datos personales
  (autorizacion del titular o mandato legal). Rastrear a alguien sin su
  autorizacion, "porque tengo su numero", seria tratamiento ilicito, con
  sanciones de la SIC y eventual responsabilidad penal.
- El acceso a los datos de ubicacion de la red del operador esta reservado a la
  **autoridad judicial** (reserva legal). Una aplicacion no puede solicitarlo ni
  obtenerlo; intentarlo seria, cuando menos, un delito.

Ver el desarrollo completo en [`privacidad.md`](privacidad.md).

### Conclusion sobre el Metodo A

**El numero de telefono, por si solo, no permite recuperar el GPS de ningun
dispositivo: ni el de un tercero, ni el de uno mismo.** No es una limitacion de
este prototipo ni de la tecnologia actual; es una propiedad del diseno de las
redes y del ordenamiento juridico. Por eso este proyecto **no** ofrece esa
funcion y **no** la simula: implementa el unico camino licito y tecnicamente
solido, el Metodo C.

## Metodologia del prototipo

Para respaldar la comparacion con datos propios (y no solo con la literatura) se
midio la **latencia del canal** del Metodo C, que es donde el proyecto aporta algo
observable: el tiempo que tarda una coordenada en ir del dispositivo al
observador.

Ruta medida:

```
  dispositivo --[HTTP POST /locations]--> API --[WebSocket location:update]--> panel
```

El script `scripts/measure-latency.mjs` envia N puntos por HTTP, mantiene un
observador suscrito por WebSocket y **empareja cada evento con su peticion por el
identificador** que devuelve la API, de modo que la medida es exacta y no
aproximada. Reporta minimo, media, mediana, p90 y maximo.

### Un hallazgo inesperado

En la primera ejecucion **no se recibio ningun evento**. Al instrumentar el
codigo se descubrio la causa: la API **difunde por WebSocket antes de responder
al POST**. Un observador que empiece a escuchar _despues_ de recibir la respuesta
se pierde el evento.

Esto es relevante para la ingenieria del sistema (el cliente debe tener la
suscripcion **activa de antemano**, que es como funciona el panel: se suscribe al
entrar y no espera a que llegue una respuesta) y se refleja en la medicion: la
latencia de difusion sale, legitimamente, **negativa**.

## Resultados medidos

Entorno: API en `localhost:3001`, PostgreSQL/PostGIS en Docker, Node.js, todo en
el mismo equipo (Windows). 20 puntos enviados cada 600 ms. Milisegundos.

| Metrica                                   | min      | media    | mediana  | p90      | max      |
| ----------------------------------------- | -------- | -------- | -------- | -------- | -------- |
| HTTP: peticion -> respuesta 201           | 18.3     | 26.0     | 27.1     | 29.5     | 40.8     |
| Difusion: respuesta -> evento WS          | -3.4     | -1.7     | -1.6     | -0.8     | -0.7     |
| **Extremo a extremo: peticion -> evento** | **17.5** | **24.3** | **25.2** | **27.9** | **38.5** |

Lectura de los datos:

- El **coste esta casi todo en el HTTP** (26 ms de media): validacion Zod, guarda
  del token, escritura en PostgreSQL (con el disparador de PostGIS), registro de
  auditoria y serializacion de la respuesta.
- La **difusion por WebSocket es practicamente instantanea** una vez la API tiene
  el dato: los valores negativos indican que el evento sale _antes_ de que la
  respuesta HTTP se complete. Es decir, el observador suele enterarse **a la vez o
  antes** que quien hizo la peticion.
- Extremo a extremo, un punto tarda del orden de **una decena y media de
  milisegundos a unas pocas decenas**, con baja dispersion (p90 = 27.9 ms).

### Que NO mide esta tabla

Es importante no sobreinterpretar:

- **No incluye la red movil.** Todo corre en la misma maquina. En un movil real
  hay que sumar la latencia de subida 4G/5G (tipicamente 20 - 100 ms) y la del
  observador.
- **No incluye el tiempo del GPS.** Mide el transporte del dato ya calculado, no
  el tiempo que el chip tarda en obtener la lectura (segundos, y mas en frio).
- **No es una medida de precision de posicion.** La precision del Metodo C la
  determina el receptor GNSS, no este canal. El simulador usa valores de precision
  realistas (7 - 14 m, dentro del rango publicado para telefonos en exterior);
  **la medicion en un dispositivo fisico esta pendiente** (ver trabajo futuro).

## Conclusiones

1. **El numero de telefono no localiza nada.** Ni tecnica ni legalmente, para un
   particular o una aplicacion, permite obtener el GPS de un dispositivo. Es la
   respuesta central del componente academico.
2. **La red del operador si puede localizar, pero no es accesible.** Su precision
   (50 m a varios km) esta reservada a la autoridad judicial; queda fuera del
   alcance de cualquier aplicacion.
3. **El GPS autorizado es el unico metodo viable**, y ademas es el mas preciso
   (3 - 20 m), con el coste de exigir permiso del titular y una aplicacion en
   ejecucion.
4. **La precision y la latencia son cosas distintas.** Este proyecto no puede
   mejorar la precision del satelite, pero si ha demostrado medir y controlar bien
   la **latencia y la frescura** del dato: el canal extremo a extremo responde en
   decenas de milisegundos en condiciones locales, y el sistema **muestra
   honestamente** cuando un dato es antiguo en lugar de fingirlo.
5. **La conclusion tecnica coincide con la legal.** El unico metodo licito es
   tambien el unico que funciona sin dependencias externas. Esta convergencia es
   el hallazgo mas solido del estudio.

## Limitaciones y trabajo futuro

- **Medir en dispositivos reales.** Falta la distribucion de `accuracyMeters` en
  Android e iOS, en exterior, interior y movilidad.
- **Medir a traves de la red movil**, no en localhost, para caracterizar la
  latencia realista de un usuario.
- **Comparar fabricantes.** La precision varia entre modelos y calidades de chip
  GNSS, y entre telefonos de gama alta y baja.
- **Medir el consumo de bateria** por frecuencia de envio (5 s frente a 60 s),
  que es la disyuntiva practica del seguimiento continuo.
- **Cuantificar la degradacion** al pasar a segundo plano, cuando el sistema
  operativo limita la captura.

## Referencias

- Ley 1581 de 2012 y Decreto 1377 de 2013 (Colombia); guias de la SIC sobre
  tratamiento de datos personales (ver [`privacidad.md`](privacidad.md)).
- Documentacion de `expo-location` (precision, permisos y segundo plano).
- Especificaciones de posicionamiento en redes moviles (Cell ID, Timing Advance,
  OTDOA) y literatura de sistemas de posicionamiento global (GNSS).
- Resultados propios reproducibles con `pnpm test:live` y
  `pnpm measure:latency`.

> Para reproducir la medicion: `pnpm measure:latency`, o con parametros propios
> `COUNT=50 INTERVAL_MS=250 pnpm measure:latency`.
