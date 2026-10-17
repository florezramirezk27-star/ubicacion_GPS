/**
 * Configuracion de Jest para el backend.
 *
 * Nota sobre @nestjs 12: se publica como **ESM puro** (`"type": "module"`), y
 * Jest solo puede cargar ESM de node_modules con `require()` nativo si Node se
 * inicia con `--experimental-vm-modules` (sin ese flag, `vm.SourceTextModule`
 * no existe y Jest rechaza el modulo). Por eso el script `test` no invoca jest
 * directamente, sino:
 *
 *   node --experimental-vm-modules ./node_modules/jest/bin/jest.js
 *
 * Asi no hace falta transformar todavia mas dependencias ni mantener reglas
 * fragiles de `transformIgnorePatterns`.
 *
 * El cliente de Prisma generado se ignora para no ralentizar las pruebas.
 */
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.(t|j)s$": [
      "ts-jest",
      { tsconfig: "<rootDir>/tsconfig.json", isolatedModules: true },
    ],
  },
  collectCoverageFrom: ["src/**/*.(t|j)s"],
  coverageDirectory: "coverage",
  testEnvironment: "node",
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "/src/generated/"],
};
