import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { colors, radius, spacing } from "../theme";

export function Card({
  title,
  right,
  children,
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View style={styles.card}>
      {(title || right) && (
        <View style={styles.cardHeader}>
          {title ? <Text style={styles.cardTitle}>{title}</Text> : <View />}
          {right}
        </View>
      )}
      {children}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = "default",
  disabled = false,
  loading = false,
}: {
  label: string;
  onPress: () => void;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
  loading?: boolean;
}) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        variant === "primary" && styles.buttonPrimary,
        variant === "danger" && styles.buttonDanger,
        pressed && !isDisabled && styles.buttonPressed,
        isDisabled && styles.buttonDisabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          color={variant === "primary" ? colors.onAccent : colors.text}
        />
      ) : (
        <Text
          style={[
            styles.buttonLabel,
            variant === "primary" && styles.buttonLabelPrimary,
            variant === "danger" && styles.buttonLabelDanger,
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  ...inputProps
}: { label: string; hint?: string } & TextInputProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.muted}
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        {...inputProps}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Badge({
  label,
  color,
  textColor,
}: {
  label: string;
  color: string;
  textColor?: string;
}) {
  return (
    <View
      style={[
        styles.badge,
        { borderColor: color, backgroundColor: `${color}22` },
      ]}
    >
      <View style={[styles.badgeDot, { backgroundColor: color }]} />
      <Text style={[styles.badgeLabel, { color: textColor ?? color }]}>
        {label}
      </Text>
    </View>
  );
}

export function Alert({
  message,
  tone,
}: {
  message: string;
  tone: "error" | "info" | "ok";
}) {
  const palette = {
    error: {
      border: colors.danger,
      text: "#fecaca",
      bg: "rgba(248,113,113,0.12)",
    },
    info: {
      border: colors.accent,
      text: "#bae6fd",
      bg: "rgba(56,189,248,0.12)",
    },
    ok: { border: colors.ok, text: "#bbf7d0", bg: "rgba(52,211,153,0.12)" },
  }[tone];

  return (
    <View
      style={[
        styles.alert,
        { borderColor: palette.border, backgroundColor: palette.bg },
      ]}
    >
      <Text style={{ color: palette.text, fontSize: 14 }}>{message}</Text>
    </View>
  );
}

export function InfoRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, mono && styles.mono]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  cardTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  button: {
    minHeight: 46,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  buttonPrimary: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  buttonDanger: {
    borderColor: "rgba(248,113,113,0.6)",
  },
  buttonPressed: { opacity: 0.8 },
  buttonDisabled: { opacity: 0.45 },
  buttonLabel: { color: colors.text, fontSize: 15, fontWeight: "600" },
  buttonLabelPrimary: { color: colors.onAccent },
  buttonLabelDanger: { color: colors.danger },
  field: { marginBottom: spacing.md },
  label: { color: colors.muted, fontSize: 13, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.surfaceSoft,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 15,
  },
  hint: { color: colors.muted, fontSize: 12, marginTop: spacing.xs },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    alignSelf: "flex-start",
  },
  badgeDot: {
    width: 7,
    height: 7,
    borderRadius: radius.pill,
    marginRight: spacing.sm,
  },
  badgeLabel: { fontSize: 12, fontWeight: "700" },
  alert: {
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  infoRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  infoLabel: { color: colors.muted, fontSize: 13, flexShrink: 0 },
  infoValue: {
    color: colors.text,
    fontSize: 14,
    flexShrink: 1,
    textAlign: "right",
  },
  mono: { fontFamily: "monospace", fontSize: 12 },
});
