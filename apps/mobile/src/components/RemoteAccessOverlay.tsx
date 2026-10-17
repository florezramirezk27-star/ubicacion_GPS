import { useEffect, useMemo, useState } from "react";
import { Linking, Modal, StyleSheet, Text, View } from "react-native";
import {
  REMOTE_SENSOR_LABELS,
  type RemoteSensor,
} from "@geo/shared";
import type { RemoteAccessController } from "../hooks/useRemoteAccess";
import { describeRemoteRequest } from "../lib/remote-notify";
import { colors, radius, spacing } from "../theme";
import { Alert, Badge, Button } from "./ui";

/**
 * Consentimiento visible para el acceso remoto a camara y microfono.
 *
 * Piezas de la pantalla, y por que existen:
 *
 *  - **Dialogo bloqueante** para cada solicitud nueva: no se puede "no ver" la
 *    peticion. Se puede posponer ("Decidir mas tarde"), y entonces queda un
 *    aviso fijo en pantalla hasta que caduque o se responda.
 *  - **Aviso permanente de emision** mientras la camara o el microfono estan
 *    activos, con el boton para cortar al instante desde el propio telefono.
 *  - **Estado de permisos** cuando el sistema los tiene bloqueados: se explica
 *    como habilitarlos; la app no insiste con el dialogo del sistema.
 *
 * Nada de esto se puede desactivar desde el panel: el administrador solo puede
 * *solicitar*.
 */

/** Etiqueta legible del estado de la conexion WebRTC. */
const CONNECTION_LABELS: Record<string, string> = {
  new: "Preparando camara",
  connecting: "Conectando",
  connected: "En directo",
  disconnected: "Conexion inestable",
  failed: "Conexion perdida",
  closed: "Sesion cerrada",
};

/** Segundos que le quedan a una solicitud antes de caducar. */
function remaining(iso: string | null): number {
  if (!iso) return 0;
  const diff = new Date(iso).getTime() - Date.now();
  return diff > 0 ? Math.ceil(diff / 1_000) : 0;
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "caducada";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} min ${rest.toString().padStart(2, "0")} s`;
}

/** Frase exacta de lo que se activa si la persona acepta. */
function acceptanceSentence(sensor: RemoteSensor): string {
  switch (sensor) {
    case "CAMERA":
      return "Si aceptas, la camara se activara mientras dure la sesion.";
    case "MICROPHONE":
      return "Si aceptas, el microfono se activara mientras dure la sesion.";
    default:
      return "Si aceptas, la camara y el microfono se activaran mientras dure la sesion.";
  }
}

export function RemoteAccessOverlay({
  controller,
}: {
  controller: RemoteAccessController;
}) {
  const { pending, active, broadcasting, connectionStates, permissions } =
    controller;

  const [postponedId, setPostponedId] = useState<string | null>(null);

  // Solicitudes del servidor que aun no emiten desde este telefono: si el
  // usuario acepto justo antes de reiniciar la app, aparecen aqui.
  const resumable = useMemo(
    () =>
      active.filter(
        (request) =>
          request.session && !broadcasting.includes(request.session.id),
      ),
    [active, broadcasting],
  );

  const nextRequest = pending[0] ?? null;
  const visible = nextRequest && nextRequest.id !== postponedId;

  // Que sensor esta emitiendo ahora mismo: el aviso debe decir exactamente lo
  // que esta activo (camara, microfono o ambos), ni mas ni menos.
  const broadcastingRequest =
    active.find(
      (request) =>
        request.session && broadcasting.includes(request.session.id),
    ) ?? null;
  const broadcastingTitle =
    broadcastingRequest?.sensor === "CAMERA"
      ? "Camara activa"
      : broadcastingRequest?.sensor === "MICROPHONE"
        ? "Microfono activo"
        : broadcastingRequest?.sensor === "CAMERA_AND_MICROPHONE"
          ? "Camara y microfono activos"
          : "Transmision activa";

  const countdown = useCountdownState(nextRequest?.expiresAt ?? null);

  return (
    <>
      {/* Modal bloqueante: la solicitud no se puede ignorar por accidente. */}
      <Modal
        visible={Boolean(visible)}
        transparent
        animationType="fade"
        onRequestClose={() => setPostponedId(nextRequest?.id ?? null)}
      >
        <View style={styles.backdrop}>
          <View style={styles.dialog}>
            <View style={styles.dialogHeader}>
              <Text style={styles.dialogTitle}>Solicitud de acceso remoto</Text>
              <Badge
                label={`CADUCA EN ${formatCountdown(countdown)}`}
                color={colors.warn}
              />
            </View>

            {nextRequest ? (
              <>
                <Text style={styles.dialogBody}>
                  {describeRemoteRequest(nextRequest)}
                </Text>

                {nextRequest.reason ? (
                  <Text style={styles.dialogReason}>
                    Motivo indicado: {nextRequest.reason}
                  </Text>
                ) : null}

                <Text style={styles.dialogNote}>
                  {acceptanceSentence(nextRequest.sensor)} Veras un aviso fijo en
                  la pantalla mientras dure, con un boton para cortar al
                  instante. Puedes rechazar sin dar explicaciones.
                </Text>

                {permissions?.needsSettings ? (
                  <Alert
                    tone="error"
                    message="El sistema tiene bloqueados los permisos de camara o microfono. Al aceptar no se abrira nada hasta que los actives en los ajustes."
                  />
                ) : null}

                <View style={styles.dialogActions}>
                  <Button
                    label="Rechazar"
                    variant="danger"
                    disabled={controller.busyRequestId === nextRequest.id}
                    onPress={() => {
                      setPostponedId(null);
                      void controller.respond(nextRequest, false);
                    }}
                  />
                  <Button
                    label="Permitir"
                    variant="primary"
                    loading={controller.busyRequestId === nextRequest.id}
                    onPress={() => {
                      setPostponedId(null);
                      void controller.respond(nextRequest, true);
                    }}
                  />
                </View>

                <View style={styles.dialogFooter}>
                  <Button
                    label="Decidir mas tarde"
                    onPress={() => setPostponedId(nextRequest.id)}
                  />
                  {permissions?.needsSettings ? (
                    <Button
                      label="Abrir ajustes"
                      onPress={() => {
                        void Linking.openSettings();
                      }}
                    />
                  ) : null}
                </View>

                {pending.length > 1 ? (
                  <Text style={styles.dialogNote}>
                    Hay {pending.length - 1} solicitud(es) mas en espera.
                  </Text>
                ) : null}
              </>
            ) : null}
          </View>
        </View>
      </Modal>

      {/* Errores y avisos, siempre fuera del modal para no bloquear la app. */}
      {controller.error ? (
        <View style={styles.alertHolder}>
          <Alert tone="error" message={controller.error} />
          <Button label="Entendido" onPress={controller.clearError} />
        </View>
      ) : null}

      {/* Solicitud pospuesta: sigue visible, no se puede "perder". */}
      {nextRequest && !visible ? (
        <View style={styles.bannerHolder}>
          <View style={styles.banner}>
            <View style={styles.bannerBody}>
              <Badge label="SOLICITUD PENDIENTE" color={colors.warn} />
              <Text style={styles.bannerTitle}>
                {REMOTE_SENSOR_LABELS[nextRequest.sensor]}
              </Text>
              <Text style={styles.bannerText}>
                Caduca en {formatCountdown(countdown)}. Nadie ve nada hasta que
                respondas.
              </Text>
            </View>
            <Button
              label="Responder"
              variant="primary"
              onPress={() => setPostponedId(null)}
            />
          </View>
        </View>
      ) : null}

      {/* Sesion aceptada que aun no emite (por ejemplo tras reiniciar la app). */}
      {resumable.length > 0 && nextRequest === null ? (
        <View style={styles.bannerHolder}>
          <View style={[styles.banner, styles.bannerWarn]}>
            <View style={styles.bannerBody}>
              <Badge label="SESION ACEPTADA" color={colors.warn} />
              <Text style={styles.bannerTitle}>
                Transmision detenida
              </Text>
              <Text style={styles.bannerText}>
                Aceptaste esta sesion, pero la app se reinicio. Reanuda para
                volver a abrir la camara y el microfono.
              </Text>
            </View>
            <Button
              label="Reanudar"
              variant="primary"
              onPress={() => {
                void controller.resume(resumable[0]!);
              }}
            />
          </View>
        </View>
      ) : null}

      {/* Indicador de emision: el requisito mas importante de visibilidad. */}
      {broadcasting.length > 0 ? (
        <View style={styles.bannerHolder}>
          <View style={[styles.banner, styles.bannerLive]}>
            <View style={styles.liveDot} />
            <View style={styles.bannerBody}>
              <Text style={styles.bannerTitle}>{broadcastingTitle}</Text>
              <Text style={styles.bannerText}>
                {Object.values(connectionStates)[0]
                  ? CONNECTION_LABELS[connectionStates[broadcasting[0]]] ??
                    connectionStates[broadcasting[0]]
                  : "Conectando"}
                {" "}· Puedes cortar en cualquier momento.
              </Text>
            </View>
            <Button
              label="Cortar ahora"
              variant="danger"
              onPress={() => {
                void controller.stop(
                  broadcasting[0],
                  "Detenida por el usuario en el dispositivo",
                );
              }}
            />
          </View>
        </View>
      ) : null}
    </>
  );
}

/**
 * Cuenta atras de una solicitud. Se aisla en un hook para que el resto del
 * componente no se vuelva a renderizar cada segundo sin necesidad.
 */
function useCountdownState(expiresAt: string | null): number {
  const [seconds, setSeconds] = useState(() => remaining(expiresAt));

  useEffect(() => {
    setSeconds(remaining(expiresAt));
    if (!expiresAt) return;
    const timer = setInterval(() => {
      setSeconds(remaining(expiresAt));
    }, 1_000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return seconds;
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(2,6,23,0.85)",
    justifyContent: "center",
    padding: spacing.lg,
  },
  dialog: {
    backgroundColor: colors.surface,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  dialogHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  dialogTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "700",
    flexShrink: 1,
  },
  dialogBody: { color: colors.text, fontSize: 15, marginBottom: spacing.sm },
  dialogReason: {
    color: colors.muted,
    fontSize: 13,
    marginBottom: spacing.sm,
  },
  dialogNote: { color: colors.muted, fontSize: 12.5, marginBottom: spacing.md },
  dialogActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  dialogFooter: { flexDirection: "row", gap: spacing.sm },
  alertHolder: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
    top: spacing.md,
    backgroundColor: colors.surface,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  bannerHolder: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
  },
  banner: {
    backgroundColor: colors.surface,
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  bannerWarn: { borderColor: colors.warn },
  bannerLive: { borderColor: colors.danger },
  bannerBody: { flex: 1, gap: spacing.xs },
  bannerTitle: { color: colors.text, fontSize: 15, fontWeight: "700" },
  bannerText: { color: colors.muted, fontSize: 12.5 },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.danger,
  },
});
