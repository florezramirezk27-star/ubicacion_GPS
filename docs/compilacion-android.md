# Compilar e instalar el APK Android

Guia para generar un **APK release instalable** de `apps/mobile` sin depender de
Expo Go ni de servicios en la nube (EAS). Incluye dos problemas reales que
aparecen en Windows y su solucion, ya aplicada en el repositorio.

## Requisitos

| Herramienta | Version usada en la prueba                               | Notas                               |
| ----------- | -------------------------------------------------------- | ----------------------------------- |
| Node.js     | 24.x                                                     | el mismo del monorepositorio        |
| JDK         | 21                                                       | `JAVA_HOME` debe apuntar al JDK     |
| Android SDK | build-tools 36, platform 35/36/37, NDK 27+, CMake 3.22.1 | `ANDROID_HOME` y `ANDROID_SDK_ROOT` |
| pnpm        | 11                                                       | dependencias del monorepositorio    |

Dispositivo de la prueba: Huawei STK-LX3, **Android 9 (API 28)**, arm64-v8a.
`minSdkVersion` del proyecto es 24, asi que Android 9 es compatible.

## Ajustes del proyecto

### 1. Trafico HTTP en claro (solo para desarrollo/demostracion)

Android 9+ bloquea el HTTP sin TLS cuando `targetSdk >= 28`. Como la API de
desarrollo se sirve por HTTP (`http://<ip-del-pc>:3001`), el APK release necesita
`android:usesCleartextTraffic="true"` en el `<application>` del manifest.

La clave `expo.android.usesCleartextTraffic` de `app.json` **no llega** al
manifest generado por `expo prebuild` (Expo solo la aplica a las variantes
debug). Por eso el repositorio incluye el config plugin
[`apps/mobile/plugins/withCleartextTraffic.js`](../apps/mobile/plugins/withCleartextTraffic.js),
registrado en `app.json`:

```json
"plugins": ["./plugins/withCleartextTraffic", ["expo-location", { ... }]]
```

Al ser un config plugin, el atributo se reaplica en cada `prebuild`, incluso con
`--clean`. **En produccion se debe servir la API por HTTPS y quitar este plugin.**

### 2. Direccion de la API

Un APK release no tiene servidor de desarrollo, por lo que `hostUri` no existe.
La app resuelve la URL de la API con esta prioridad
([`apps/mobile/src/config.ts`](../apps/mobile/src/config.ts)):

1. `EXPO_PUBLIC_API_URL` (variable de entorno en tiempo de compilacion)
2. host del servidor de Expo (solo en desarrollo)
3. `extra.apiUrl` de `app.json`
4. `http://localhost:3001`

Para una demostracion en red local, `app.json` trae
`extra.apiUrl = "http://192.168.1.12:3001"` (la IP del PC que sirve la API).
Cambiala por la de tu equipo, o deja que el usuario la edite en la pantalla de
inicio de sesion (**Cambiar direccion del servidor**), que la guarda en
`expo-secure-store`.

> `localhost` **no** sirve mirando desde el telefono: apunta al propio telefono.

## Compilar

```powershell
cd apps/mobile

# 1. Genera el proyecto nativo (aplica los plugins). --clean lo recrea entero.
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
npx expo prebuild --platform android --clean

# 2. Compila el APK release solo para arm64-v8a (la arquitectura del telefono).
cd android
.\gradlew.bat assembleRelease -PreactNativeArchitectures=arm64-v8a
```

El APK queda en:

```
apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

Para acelerar la compilacion se limita a una sola ABI
(`-PreactNativeArchitectures=arm64-v8a`); en un telefono x86 no arrancaria.

La firma release del template de Expo usa el **keystore de depuracion**, asi que
el APK se instala directamente sin configurar claves. Para publicar en Google
Play hay que generar un keystore propio y configurarlo.

## Instalar y abrir en el telefono

Con el telefono conectado por USB y la **depuracion USB** activada:

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb install -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
& $adb shell am start -n co.edu.geolocalizador.movil/.MainActivity
```

## Problema conocido en Windows: rutas de mas de 260 caracteres

Sintoma (al compilar en Windows):

```
ninja: error: Stat(...react-native-safe-area-context/.../RNCSafeAreaViewShadowNode.cpp.o):
Filename longer than 260 characters
```

Causa: pnpm crea rutas muy profundas
(`node_modules/.pnpm/<paquete>_<hash>/node_modules/...`). El codigo nativo de la
Nueva Arquitectura genera rutas aun mas largas, y el `ninja.exe` que incluye el
CMake 3.22.1 del SDK de Android (v1.10.2) **no soporta rutas largas**. Es un bug
conocido, corregido en **ninja 1.12.0**.

Solucion aplicada en el equipo de la prueba:

1. Habilitar rutas largas de Windows (una sola vez, como administrador):

   ```powershell
   New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
     -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
   ```

2. Descargar ninja 1.12.1 de
   <https://github.com/ninja-build/ninja/releases> y **reemplazar** el del SDK,
   guardando copia del original:

   ```powershell
   $ninja = "$env:LOCALAPPDATA\Android\Sdk\cmake\3.22.1\bin\ninja.exe"
   Copy-Item $ninja "$ninja.backup"      # respaldo
   Copy-Item .\ninja.exe $ninja -Force   # reemplazo por 1.12.1
   & $ninja --version                    # debe imprimir 1.12.x
   ```

3. Borrar las carpetas CMake `.cxx` que quedaran a medias y recompilar. El error
   antiguo tambien dejaba el mensaje secundario
   `manifest 'build.ninja' still dirty after 100 tries`, que desaparece al
   limpiar `.cxx`.

Alternativa (sin tocar el SDK): instalar un CMake mas nuevo desde el SDK Manager
(3.31.6 o superior, que ya incluye ninja 1.12+) y fijarlo con
`expo-build-properties` (`android.cmakeVersion`).

## Verificar que quedo funcionando

```powershell
& $adb shell pm list packages | Select-String geolocalizador      # instalada
& $adb shell dumpsys window windows | Select-String mCurrentFocus # en primer plano
& $adb shell uiautomator dump /sdcard/ui.xml                      # texto en pantalla
```

La prueba real de la cadena completa (GPS del telefono -> HTTP -> API ->
WebSocket -> panel) se documento en
[`docs/investigacion.md`](investigacion.md) y
[`docs/pruebas.md`](pruebas.md). Para observarla en vivo mientras el telefono
esta compartiendo:

```bash
node scripts/watch-live.mjs        # se suscribe y registra location:update
```

## Notas para produccion

- Servir la API por **HTTPS** y **quitar** el plugin `withCleartextTraffic`.
- Apuntar la app a un dominio estable, no a una IP de la red local.
- Firmar con un **keystore propio** en lugar del de depuracion.

El **seguimiento en segundo plano** ya forma parte de esta version: la app
declara el servicio en primer plano (Android) y el modo de ubicacion (iOS), y
registra la tarea `geo-background-location`. Al recompilar con `expo prebuild` se
regenera el proyecto nativo con esos permisos; ver
[`segundo-plano.md`](segundo-plano.md).
