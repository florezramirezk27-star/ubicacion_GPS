import { registerRootComponent } from "expo";

// Registro de la tarea de ubicacion en segundo plano.
//
// `expo-task-manager` exige que `defineTask` se ejecute en el ambito global del
// bundle, no dentro de un componente: cuando el sistema despierta la app en
// segundo plano (o con la pantalla bloqueada) no se monta ninguna pantalla, pero
// este archivo de entrada SI se evalua. Importarlo aqui —antes de App— asegura
// que la tarea exista en cuanto el bundle carga.
import "./src/lib/background-location";

import App from "./App";

// registerRootComponent llama a AppRegistry.registerComponent y asegura que el
// entorno de Expo (build nativo) cargue el componente raiz.
registerRootComponent(App);
