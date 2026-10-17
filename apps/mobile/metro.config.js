// Configuracion de Metro para un monorepositorio con pnpm.
//
// Metro necesita saber que existe un espacio de trabajo por encima de la app
// para poder resolver el paquete compartido `@geo/shared` y observar cambios en
// `packages/`. Ver docs/arquitectura.md.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// 1. Observar todo el monorepositorio para que los cambios en packages/ se reflejen.
config.watchFolders = [workspaceRoot];

// 2. Resolver modulos tanto en la app como en la raiz del espacio de trabajo.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// 3. IMPORTANTE: no desactivar la busqueda jerarquica.
//
// pnpm no eleva las dependencias transitivas a la raiz: cada paquete tiene las
// suyas en `node_modules/.pnpm/<paquete>@<version>/node_modules/`. Por ejemplo
// `react-native` importa `invariant`, que vive en ese directorio hermano. Con
// `disableHierarchicalLookup = true` Metro solo mira los `nodeModulesPaths` y no
// encontraria esas dependencias (fallaba con "Unable to resolve invariant").
// Dejar la busqueda jerarquica activa es lo que hace que la resolucion funcione
// con el almacen de pnpm.

module.exports = config;
