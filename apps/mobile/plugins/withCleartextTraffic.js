const { withAndroidManifest } = require("expo/config-plugins");

/**
 * Anade android:usesCleartextTraffic="true" al <application> del AndroidManifest.
 *
 * Por que existe este plugin:
 *   - La clave `expo.android.usesCleartextTraffic` de app.json NO llega al
 *     manifest generado por `expo prebuild` (solo Expo la pone en los manifests
 *     de las variantes debug). Un APK release queda sin el atributo.
 *   - Sin ese atributo, Android 9+ (targetSdk >= 28) bloquea el trafico HTTP en
 *     claro, de modo que la app no puede hablar con una API servida por HTTP
 *     (por ejemplo http://192.168.x.x:3001 en la red local de desarrollo).
 *   - Al ser un config plugin, el cambio sobrevive a `expo prebuild --clean`.
 *
 * En produccion la API debe servirse por HTTPS y este plugin debe quitarse:
 * el HTTP en claro solo se justifica para la demostracion en red local.
 */
module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (config) => {
    const application = config.modResults.manifest.application?.[0];

    if (!application) {
      throw new Error(
        "withCleartextTraffic: el AndroidManifest no tiene <application>.",
      );
    }

    application.$ = application.$ ?? {};
    application.$["android:usesCleartextTraffic"] = "true";

    return config;
  });
};
