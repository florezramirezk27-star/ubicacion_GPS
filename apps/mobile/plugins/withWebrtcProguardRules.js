const { withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Anade reglas ProGuard/R8 necesarias para compilar el APK release.
 *
 * Por que existe este plugin:
 *   - `react-native-webrtc` enlaza clases nativas opcionales (decodificadores
 *     de video como `org.webrtc.Dav1dDecoder$Natives`) que no existen en todas
 *     las arquitecturas. Con R8 en *full mode* (por defecto en AGP 8+), la tarea
 *     `minifyReleaseWithR8` trata la clase ausente como error y el build falla:
 *
 *       ERROR: R8: Missing class org.webrtc.Dav1dDecoder$Natives
 *
 *   - `-dontwarn` silencia ese aviso concreto sin desactivar el minificado ni
 *     el ofuscado del resto de la aplicacion.
 *
 * Al ser un config plugin, las reglas se reaplican en cada `expo prebuild`,
 * incluso con `--clean` (el archivo proguard-rules.pro es generado).
 */
const RULES = `
# ------------------------- react-native-webrtc (R8) -------------------------
# R8 en full mode falla si encuentra clases nativas opcionales ausentes
# (por ejemplo org.webrtc.Dav1dDecoder$Natives). Ver docs/compilacion-android.md.
-dontwarn org.webrtc.**
`;

const MARKER = "-dontwarn org.webrtc.**";

module.exports = function withWebrtcProguardRules(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const archivo = path.join(
        config.modRequest.platformProjectRoot,
        "app",
        "proguard-rules.pro",
      );

      const actual = fs.existsSync(archivo)
        ? fs.readFileSync(archivo, "utf8")
        : "";

      if (!actual.includes(MARKER)) {
        fs.appendFileSync(archivo, RULES);
      }

      return config;
    },
  ]);
};
