"use client";

import { useState } from "react";
import type { PublicLocation } from "@geo/shared";
import { ApiError, api, type NearbyLocation } from "@/lib/api";
import { formatCoordinates, formatMeters, formatTime } from "@/lib/format";
import type { MapPosition } from "./live-map";

interface HistoryPanelProps {
  history: PublicLocation[];
  loading: boolean;
  error: boolean;
  currentPosition: MapPosition | null;
}

const RADIUS_OPTIONS = [500, 1000, 2000, 5000];

/**
 * Historial de recorridos del dispositivo.
 *
 * Incluye una consulta geografica por radio para demostrar el uso de PostGIS
 * (`ST_DWithin` sobre la columna `geography`). Sin PostGIS habria que filtrar
 * con rangos de latitud/longitud, que no reflejan distancias reales.
 */
export function HistoryPanel({
  history,
  loading,
  error,
  currentPosition,
}: HistoryPanelProps) {
  const [radiusMeters, setRadiusMeters] = useState(1000);
  const [nearby, setNearby] = useState<NearbyLocation[] | null>(null);
  const [nearbyError, setNearbyError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  async function searchNearby() {
    if (!currentPosition) return;
    setSearching(true);
    setNearbyError(null);
    try {
      const results = await api.nearby({
        latitude: currentPosition.latitude,
        longitude: currentPosition.longitude,
        radiusMeters,
        limit: 200,
      });
      setNearby(results);
    } catch (caught) {
      setNearbyError(
        caught instanceof ApiError
          ? caught.message
          : "No se pudo ejecutar la consulta.",
      );
    } finally {
      setSearching(false);
    }
  }

  const showingNearby = nearby !== null;
  const rows: Array<PublicLocation | NearbyLocation> = nearby ?? history;

  return (
    <div className="card">
      <div className="card-title">
        <h2>
          {showingNearby
            ? "Puntos dentro del radio"
            : "Historial de recorridos"}
        </h2>
        <span className="tag">{rows.length} puntos</span>
      </div>

      <div className="row small" style={{ marginBottom: "0.75rem" }}>
        <select
          value={radiusMeters}
          onChange={(event) => setRadiusMeters(Number(event.target.value))}
          style={{ width: "auto" }}
          aria-label="Radio de busqueda"
        >
          {RADIUS_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {formatMeters(option)} a la redonda
            </option>
          ))}
        </select>
        <button
          className="small"
          onClick={() => void searchNearby()}
          disabled={!currentPosition || searching}
          title={
            currentPosition
              ? "Consulta PostGIS ST_DWithin"
              : "Se necesita una ubicacion conocida"
          }
        >
          {searching ? "Buscando..." : "Buscar en el radio (PostGIS)"}
        </button>
        {showingNearby && (
          <button className="small ghost" onClick={() => setNearby(null)}>
            Ver historial completo
          </button>
        )}
      </div>

      {nearbyError && (
        <div className="alert alert-error" style={{ marginBottom: "0.75rem" }}>
          {nearbyError}
        </div>
      )}
      {error && !showingNearby && (
        <div className="alert alert-error" style={{ marginBottom: "0.75rem" }}>
          No se pudo cargar el historial.
        </div>
      )}

      {loading && !showingNearby ? (
        <p className="muted small">Cargando historial...</p>
      ) : rows.length === 0 ? (
        <p className="muted small">
          {showingNearby
            ? "No hay coordenadas dentro del radio seleccionado."
            : "Todavia no hay recorridos registrados para este dispositivo."}
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Capturada</th>
                <th>Recibida</th>
                <th>Coordenadas</th>
                <th>Precision</th>
                {showingNearby && <th>Distancia</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{formatTime(row.recordedAt)}</td>
                  <td className="muted">{formatTime(row.receivedAt)}</td>
                  <td className="mono">
                    {formatCoordinates(row.latitude, row.longitude)}
                  </td>
                  <td>{formatMeters(row.accuracyMeters)}</td>
                  {showingNearby && "distanceMeters" in row && (
                    <td>
                      {formatMeters((row as NearbyLocation).distanceMeters)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="small muted" style={{ marginTop: "0.6rem" }}>
        La busqueda por radio usa el indice GIST de PostGIS, no un filtro por
        rangos de latitud/longitud.
      </p>
    </div>
  );
}
