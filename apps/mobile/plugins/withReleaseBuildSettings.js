const { withGradleProperties } = require("expo/config-plugins");

/**
 * Desactiva el minificado (R8) del APK release.
 *
 * Por que existe este plugin:
 *   - Con `android.enableMinifyInReleaseBuilds=true`, R8 en *full mode* aplica
 *     ofuscado agresivo. Parte del codigo nativo (react-native-webrtc, modulos
 *     de Expo y de React Native) localiza clases Java por reflexion/JNI; si R8
 *     las renombra o elimina, la app compila pero **aborta al arrancar**:
 *
 *       JNI DETECTED ERROR IN APPLICATION: java_class == null
 *         at art::JNI::GetStaticMethodID(...)
 *
 *     (Ese crash solo aparece en release, nunca en debug.)
 *   - Desactivar el minificado es el comportamiento por defecto de la plantilla
 *     de React Native y evita tener que mantener a mano las reglas `-keep` de
 *     cada libreria nativa.
 *
 * Coste: el APK es algo mas grande y no se ofusca. Para un proyecto academico
 * el intercambio es razonable; si mas adelante hace falta minimizar, lo correcto
 * es volver a activarlo y anadir las reglas `-keep` que cada libreria necesita.
 *
 * Al ser un config plugin, el cambio sobrevive a `expo prebuild --clean`
 * (`android/gradle.properties` es un archivo generado).
 */
const PROPIEDAD = "android.enableMinifyInReleaseBuilds";

module.exports = function withReleaseBuildSettings(config) {
  return withGradleProperties(config, (config) => {
    const propiedades = config.modResults;

    const existente = propiedades.find(
      (p) => p.type === "property" && p.key === PROPIEDAD,
    );

    if (existente) {
      existente.value = "false";
    } else {
      propiedades.push({ type: "property", key: PROPIEDAD, value: "false" });
    }

    return config;
  });
};
