"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatAction, formatDateTime } from "@/lib/format";

/**
 * Feed de eventos de seguridad del panel de administracion.
 *
 * Muestra, en orden cronologico inverso, quien hizo que y cuando: consultas de
 * fichas e historiales, revocaciones y desvinculaciones. Es la contrapartida
 * visible de la auditoria que exige el diseno: el administrador no puede
 * espiar en silencio.
 */
export function AdminAuditFeed() {
  const query = useQuery({
    queryKey: ["admin", "audit"],
    queryFn: () => api.adminAudit({ limit: 40 }),
    refetchInterval: 15_000,
  });

  return (
    <div className="card">
      <div className="card-title">
        <h2>Eventos de seguridad (auditoria)</h2>
        <span className="tag">{query.data?.length ?? 0}</span>
      </div>

      {query.isLoading && <p className="muted small">Cargando...</p>}
      {query.isError && (
        <div className="alert alert-error">No se pudo cargar la auditoria.</div>
      )}
      {query.data?.length === 0 && (
        <p className="muted small">Todavia no hay eventos registrados.</p>
      )}

      {query.data && query.data.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Cuando</th>
                <th>Quien</th>
                <th>Accion</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDateTime(entry.createdAt)}</td>
                  <td>{entry.actorEmail ?? "sistema"}</td>
                  <td title={entry.action}>{formatAction(entry.action)}</td>
                  <td className="mono">{entry.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
