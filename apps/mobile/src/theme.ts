/**
 * Tema visual de la app. Se mantiene en un unico sitio para que las pantallas
 * no repitan valores y el modo oscuro sea coherente con el panel web.
 */
export const colors = {
  background: "#0b1120",
  surface: "#111827",
  surfaceSoft: "#1a2334",
  border: "#243044",
  text: "#e2e8f0",
  muted: "#94a3b8",
  accent: "#38bdf8",
  accentSoft: "rgba(56, 189, 248, 0.14)",
  ok: "#34d399",
  warn: "#fbbf24",
  danger: "#f87171",
  onAccent: "#06202e",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
};

/** Color asociado a cada estado de frescura del dato. */
export const freshnessColor: Record<string, string> = {
  CURRENT: colors.ok,
  STALE: colors.warn,
  OFFLINE: colors.danger,
  UNKNOWN: colors.muted,
};
