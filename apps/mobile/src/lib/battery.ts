import * as Battery from "expo-battery";
import {
  classifyBattery,
  effectiveIntervalMs,
  effectivePrecision,
  toBatteryPercent,
  type BatteryPolicy,
} from "@geo/shared";

/**
 * Lectura y politica de bateria.
 *
 * Requisito explicito: **el seguimiento nunca se detiene por un porcentaje de
 * bateria**. Los tramos de `@geo/shared/battery` solo sirven para adaptar el
 * consumo (frecuencia y precision). Si el telefono se apaga antes de enviar la
 * siguiente ubicacion, no hay nada que la app pueda hacer para evitarlo, y el
 * panel lo vera como datos "desactualizados", no como un fallo oculto.
 *
 * `expo-battery` devuelve -1 cuando el sistema no conoce el nivel: eso NO es
 * "0 %", asi que se normaliza a `null` (sin dato) y no se adapta nada.
 */

/** Nivel centinela que devuelven los nativos cuando el dato no esta disponible. */
const UNKNOWN_LEVEL = -1;

export interface BatterySnapshot {
  /** 0..100, o null si el sistema no lo sabe. */
  percent: number | null;
  charging: boolean;
  policy: BatteryPolicy;
  /** Intervalo efectivo resultante para el intervalo base elegido por el usuario. */
  effectiveIntervalMs: number;
  /** Precision sugerida para este tramo. */
  precision: "high" | "balanced";
  /** Momento de la lectura. */
  readAt: string;
}

function normalizeLevel(level: number): number | null {
  if (!Number.isFinite(level) || level === UNKNOWN_LEVEL) return null;
  return toBatteryPercent(level);
}

/** Construye la instantanea a partir de un nivel ya normalizado (0..100). */
export function snapshotFor(
  percent: number | null,
  charging: boolean,
  baseIntervalMs: number,
): BatterySnapshot {
  return {
    percent,
    charging,
    policy: classifyBattery(percent),
    effectiveIntervalMs: effectiveIntervalMs(baseIntervalMs, percent),
    precision: effectivePrecision(percent),
    readAt: new Date().toISOString(),
  };
}

/** Lee el nivel y el estado de carga actuales. Nunca lanza. */
export async function readBattery(
  baseIntervalMs: number,
): Promise<BatterySnapshot> {
  try {
    const [level, state] = await Promise.all([
      Battery.getBatteryLevelAsync(),
      Battery.getBatteryStateAsync(),
    ]);
    const charging =
      state === Battery.BatteryState.CHARGING ||
      state === Battery.BatteryState.FULL;
    return snapshotFor(normalizeLevel(level), charging, baseIntervalMs);
  } catch {
    return snapshotFor(null, false, baseIntervalMs);
  }
}

/**
 * Avisa cuando cambia el nivel o el estado de carga de la bateria.
 *
 * Deliberadamente NO entrega valores: el nativo emite ambos avisos por
 * separado y mezclarlos daria lecturas incoherentes (un evento de estado con el
 * nivel a `null`). Quien escucha vuelve a leer con `readBattery`, que siempre
 * devuelve una instantanea completa y coherente.
 *
 * Se usa para dos cosas: mostrar el nivel en la pantalla y, **solo en primer
 * plano**, reaplicar la frecuencia efectiva al servicio de ubicacion. En
 * segundo plano no se reaplica a proposito: reiniciar el servicio desde una
 * tarea del sistema haria que Android no pueda arrancar el servicio en primer
 * plano y se perderia el seguimiento. Alli la adaptacion es de envio (ver
 * `coalescePositions` en `background-location.ts`).
 */
export function subscribeBatteryChanges(listener: () => void): () => void {
  try {
    const levelSubscription = Battery.addBatteryLevelListener(() => {
      listener();
    });
    const stateSubscription = Battery.addBatteryStateListener(() => {
      listener();
    });

    return () => {
      try {
        levelSubscription.remove();
      } catch {
        /* ignorado */
      }
      try {
        stateSubscription.remove();
      } catch {
        /* ignorado */
      }
    };
  } catch {
    return () => undefined;
  }
}

/**
 * Texto para la notificacion permanente del servicio (Android).
 * La transparencia importa: si la bateria obliga a espaciar los envios, el
 * usuario debe poder leerlo sin abrir la app.
 */
export function foregroundNotificationBody(snapshot: BatterySnapshot): string {
  if (snapshot.policy.tier === "critical" || snapshot.policy.tier === "low") {
    return "Bateria baja: se reduce la frecuencia de envio, pero la ubicacion se sigue compartiendo. Toca para abrir la app.";
  }
  return "Tu ubicacion se comparte de forma autorizada. Toca para abrir la app.";
}
