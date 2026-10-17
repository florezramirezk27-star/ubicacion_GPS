/**
 * Politica de bateria adaptativa para el seguimiento de ubicacion.
 *
 * Principio rector (requisito explicito del proyecto): **un porcentaje de
 * bateria nunca detiene el seguimiento**. Los umbrales son senales para
 * *adaptar* el consumo, no limites de corte. Si el telefono se apaga, se
 * apaga: el sistema no nos deja "seguir transmitiendo hasta el ultimo
 * instante", y prometerlo seria mentir.
 *
 * Estos valores son una configuracion inicial de prueba y son ajustables
 * sin tocar la logica: viven aqui para que la app movil y el panel de
 * administracion compartan exactamente la misma interpretacion del nivel
 * de bateria.
 */

import type { LocationFreshness } from "./enums";

/**
 * Umbrales de la politica, en porcentaje de bateria restante.
 *
 *   nivel >= 30   -> optimo    (alta precision, frecuencia elegida por el usuario)
 *   nivel >= 15   -> reducida  (menos consultas redundantes)
 *   nivel >= 5    -> baja      (prioridad a la eficiencia energetica)
 *   nivel < 5     -> critica   (actualizaciones poco frecuentes + aviso visible)
 */
export const BATTERY_THRESHOLDS = {
  /** Bateria considerada sana. */
  optimal: 30,
  /** Por debajo de esto se empieza a reducir el ritmo. */
  reduced: 15,
  /** Por debajo de esto la prioridad pasa a ser la eficiencia. */
  low: 5,
} as const;

/** Nivel maximo (en tanto por uno) que devuelve expo-battery / nativos. */
const LEVEL_SCALE = 1;

export type BatteryTier =
  /** Sin dato de bateria: no se adapta nada (no se inventa un nivel). */
  | "unknown"
  /** Bateria sana. */
  | "optimal"
  /** Batería reducida: menos consultas redundantes. */
  | "reduced"
  /** Batería baja: eficiencia energetica primero. */
  | "low"
  /** Batería critica: actualizaciones poco frecuentes y aviso visible. */
  | "critical";

/** Nivel de precision de ubicacion asociado a cada tramo. */
export type LocationPrecision = "high" | "balanced";

export interface BatteryPolicy {
  tier: BatteryTier;
  /** Nombre corto para la interfaz. */
  label: string;
  /** Explicacion de que implica este tramo (para la tarjeta de estado). */
  description: string;
  /**
   * Multiplicador sobre el intervalo elegido por el usuario.
   * 1 = sin cambios, 2 = la mitad de frecuente, etc.
   */
  intervalMultiplier: number;
  precision: LocationPrecision;
  /** true cuando hay que mostrar un aviso visible en la app. */
  warning: boolean;
}

/**
 * Tope superior del intervalo efectivo.
 *
 * Un multiplicador sobre un intervalo de 5 minutos podria llevar a valores
 * absurdos (30 minutos). Preferimos frenar en 10 minutos: el seguimiento
 * sigue vivo y la antiguedad de los datos ya se comunica en el panel.
 */
export const BATTERY_MAX_EFFECTIVE_INTERVAL_MS = 600_000;

/** Nivel (en %) por debajo del cual el panel marca el dispositivo como "bateria baja". */
export const BATTERY_LOW_BADGE_PERCENT = 15;

const POLICIES: Record<BatteryTier, BatteryPolicy> = {
  unknown: {
    tier: "unknown",
    label: "Sin dato",
    description:
      "No se ha podido leer el nivel de bateria; el seguimiento sigue con la configuracion elegida.",
    intervalMultiplier: 1,
    precision: "high",
    warning: false,
  },
  optimal: {
    tier: "optimal",
    label: "Optima",
    description:
      "Alta precision y actualizaciones frecuentes mientras el dispositivo se mueve.",
    intervalMultiplier: 1,
    precision: "high",
    warning: false,
  },
  reduced: {
    tier: "reduced",
    label: "Reducida",
    description:
      "Se reducen consultas redundantes y se ajusta la frecuencia de actualizacion.",
    intervalMultiplier: 2,
    precision: "high",
    warning: false,
  },
  low: {
    tier: "low",
    label: "Baja",
    description:
      "Prioridad a la eficiencia energetica, con actualizaciones periodicas.",
    intervalMultiplier: 4,
    precision: "balanced",
    warning: true,
  },
  critical: {
    tier: "critical",
    label: "Critica",
    description:
      "Modo critico de bajo consumo: actualizaciones poco frecuentes y aviso visible. Puede apagarse antes de enviar la siguiente ubicacion.",
    intervalMultiplier: 6,
    precision: "balanced",
    warning: true,
  },
};

/**
 * Clasifica un nivel de bateria (0..1) en su tramo de politica.
 *
 * Devuelve el tramo `unknown` cuando no hay dato: no se inventa un nivel.
 */
export function classifyBattery(
  level: number | null | undefined,
): BatteryPolicy {
  if (level === null || level === undefined || !Number.isFinite(level)) {
    return POLICIES.unknown;
  }

  // Acepta tanto 0..1 (expo-battery) como 0..100 (panel) sin ambiguedad:
  // por encima de 1 ya solo puede tratarse de un porcentaje.
  const percent = level <= LEVEL_SCALE ? level * 100 : level;
  if (percent < 0) return POLICIES.unknown;

  if (percent >= BATTERY_THRESHOLDS.optimal) return POLICIES.optimal;
  if (percent >= BATTERY_THRESHOLDS.reduced) return POLICIES.reduced;
  if (percent >= BATTERY_THRESHOLDS.low) return POLICIES.low;
  return POLICIES.critical;
}

/** Normaliza cualquier entrada a porcentaje entero 0..100, o `null` si no hay dato. */
export function toBatteryPercent(
  level: number | null | undefined,
): number | null {
  if (level === null || level === undefined || !Number.isFinite(level))
    return null;
  const percent = level <= LEVEL_SCALE ? level * 100 : level;
  // Un nivel negativo no es un porcentaje: es el centinela que usan los
  // nativos cuando el dato no esta disponible.
  if (percent < 0) return null;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/**
 * Intervalo efectivo (ms) para un nivel de bateria dado.
 *
 * **Nunca detiene el seguimiento**: solo lo alarga, con un tope.
 */
export function effectiveIntervalMs(
  baseIntervalMs: number,
  level: number | null | undefined,
): number {
  const policy = classifyBattery(level);
  const scaled = baseIntervalMs * policy.intervalMultiplier;
  return Math.min(
    Math.max(baseIntervalMs, scaled),
    BATTERY_MAX_EFFECTIVE_INTERVAL_MS,
  );
}

/** Precision de ubicacion sugerida para el nivel de bateria dado. */
export function effectivePrecision(
  level: number | null | undefined,
): LocationPrecision {
  return classifyBattery(level).precision;
}

/** Indica si el nivel esta por debajo del umbral de "bateria baja" del panel. */
export function isBatteryLow(level: number | null | undefined): boolean {
  const percent = toBatteryPercent(level);
  return percent !== null && percent < BATTERY_LOW_BADGE_PERCENT;
}

/** Tono visual para el panel y la app. */
export type BatteryTone = "none" | "ok" | "warn" | "critical";

export interface BatteryBadge {
  tone: BatteryTone;
  label: string;
  /** true si conviene resaltar el elemento (bateria baja). */
  highlight: boolean;
}

/**
 * Etiqueta y color para representar un nivel de bateria.
 * Permite al administrador distinguir "transmitiendo" de "con poca bateria".
 */
export function batteryBadge(level: number | null | undefined): BatteryBadge {
  const percent = toBatteryPercent(level);
  if (percent === null)
    return { tone: "none", label: "Sin dato", highlight: false };
  if (percent < BATTERY_THRESHOLDS.low)
    return { tone: "critical", label: `${percent} %`, highlight: true };
  if (percent < BATTERY_LOW_BADGE_PERCENT)
    return { tone: "warn", label: `${percent} %`, highlight: true };
  return { tone: "ok", label: `${percent} %`, highlight: false };
}

// --------------------- Por que el dato puede venir tarde ---------------------

/**
 * Motivo por el que una coordenada llega con mas o menos retraso.
 *
 * Es la pieza que evita la confusion mas peligrosa del panel: con bateria baja
 * la app **espacia los envios a proposito** (es su forma de ahorrar), asi que
 * "datos antiguos" no significa "el dispositivo ha fallado". Distinguirlo
 * evita que el administrador interprete una decision de diseno como una averia.
 */
export type DataDelayReason =
  /** La ultima coordenada es reciente: el dispositivo esta transmitiendo. */
  | "live"
  /** Datos con retraso y bateria por debajo del umbral: retraso deliberado. */
  | "battery-saving"
  /** Datos antiguos sin explicacion de bateria. */
  | "stale"
  /** Se supero el umbral de desconexion. */
  | "offline"
  /** El dispositivo nunca ha reportado. */
  | "unknown";

export interface DataDelayExplanation {
  reason: DataDelayReason;
  /** Nombre corto para la insignia del panel. */
  label: string;
  /** Explicacion de por que el punto puede estar retrasado. */
  detail: string;
}

/**
 * Explica por que un dato puede venir con retraso.
 *
 * Es la pieza que evita la confusion mas peligrosa del panel: con bateria baja
 * el dispositivo espacia los envios **a proposito**, asi que "datos antiguos"
 * no significa "el dispositivo ha fallado". Cuando hay bateria baja y a la vez
 * el dato esta retrasado, se dice "ahorro de bateria" en lugar de "sin datos".
 */
export function explainDataDelay(
  freshness: LocationFreshness,
  level: number | null | undefined,
): DataDelayExplanation {
  if (freshness === "CURRENT") {
    return {
      reason: "live",
      label: "Transmitiendo",
      detail: "El dispositivo reporto hace muy poco.",
    };
  }

  if (freshness === "STALE" || freshness === "OFFLINE") {
    if (isBatteryLow(level)) {
      return {
        reason: "battery-saving",
        label: "Ahorro de bateria",
        detail:
          "Con la bateria baja el dispositivo espacia los envios a proposito. No es un fallo: la posicion sigue llegando, mas despacio.",
      };
    }
    return freshness === "STALE"
      ? {
          reason: "stale",
          label: "Datos obsoletos",
          detail:
            "El dispositivo lleva un rato sin enviar coordenadas y no reporta bateria baja.",
        }
      : {
          reason: "offline",
          label: "Desconectado",
          detail:
            "Se supero el umbral sin recibir datos: la ubicacion puede ser obsoleta.",
        };
  }

  return {
    reason: "unknown",
    label: "Sin datos",
    detail: "El dispositivo nunca ha enviado una ubicacion.",
  };
}
