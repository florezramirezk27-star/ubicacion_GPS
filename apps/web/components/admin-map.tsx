"use client";

import { useEffect, useRef, useState } from "react";
import type { Circle, Map as LeafletMap, Marker, Polyline } from "leaflet";
import type { AdminDevice, LocationFreshness } from "@geo/shared";

/** @types/leaflet usa `export =`, por lo que el tipo del modulo es el namespace. */
type LeafletRuntime = typeof import("leaflet");

export interface AdminTrailPoint {
  latitude: number;
  longitude: number;
}

interface AdminMapProps {
  devices: AdminDevice[];
  selectedId: string | null;
  onSelect: (deviceId: string) => void;
  /** Recorrido reciente del dispositivo seleccionado (mas antiguo primero). */
  trail?: AdminTrailPoint[];
  /**
   * Cambia de valor para pedir que el mapa encuadre todos los dispositivos
   * visibles. Se usa un contador en lugar de un booleano para poder repetir la
   * accion ("Centrar") sin que el mapa pelee con el usuario.
   */
  fitSignal?: number;
}

const DEFAULT_CENTER: [number, number] = [4.6533, -74.0836];

/** Colores por frescura: nunca se pinta como "en vivo" un dato antiguo. */
const COLOR_BY_FRESHNESS: Record<LocationFreshness, string> = {
  CURRENT: "#34d399",
  STALE: "#fbbf24",
  OFFLINE: "#f87171",
  UNKNOWN: "#94a3b8",
};

/** Escapa el texto antes de inyectarlo en el HTML del marcador emergente. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Mapa global del panel de administracion.
 *
 * A diferencia de `LiveMap` (un solo dispositivo), aqui se dibujan TODOS los
 * dispositivos con su **circulo de incertidumbre** (el radio de precision que
 * reporta el GPS). El color del punto refleja la frescura del dato y el
 * marcador seleccionado se resalta con un anillo.
 *
 * Se gestionan los marcadores de forma imperativa, reutilizandolos por id, para
 * no recrear el mapa en cada actualizacion de estado.
 */
export function AdminMap({
  devices,
  selectedId,
  onSelect,
  trail,
  fitSignal = 0,
}: AdminMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  const circlesRef = useRef<Map<string, Circle>>(new Map());
  const trailRef = useRef<Polyline | null>(null);
  const [leaflet, setLeaflet] = useState<LeafletRuntime | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const didFitRef = useRef(false);

  // Se mantiene el callback de seleccion en una referencia: asi el manejador
  // de clic del marcador no queda "congelado" con la version inicial.
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const tileUrl =
    process.env.NEXT_PUBLIC_MAP_TILE_URL ??
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

  // Carga diferida de Leaflet (solo navegador).
  useEffect(() => {
    let active = true;
    import("leaflet")
      .then((module) => {
        if (!active) return;
        const loaded = module as unknown as {
          default?: LeafletRuntime;
        } & LeafletRuntime;
        setLeaflet(loaded.default ?? loaded);
      })
      .catch(() => {
        if (active) setLoadError("No se pudo cargar la libreria del mapa.");
      });
    return () => {
      active = false;
    };
  }, []);

  // Crea el mapa una sola vez.
  useEffect(() => {
    if (!leaflet || !containerRef.current || mapRef.current) return;

    const map = leaflet.map(containerRef.current, {
      center: DEFAULT_CENTER,
      zoom: 13,
      zoomControl: true,
    });

    leaflet
      .tileLayer(tileUrl, {
        maxZoom: 19,
        attribution:
          '&copy; colaboradores de <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      })
      .addTo(map);

    mapRef.current = map;
    const timer = window.setTimeout(() => map.invalidateSize(), 200);

    return () => {
      window.clearTimeout(timer);
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
      circlesRef.current.clear();
      trailRef.current = null;
    };
  }, [leaflet, tileUrl]);

  // Sincroniza marcadores y circulos con la lista de dispositivos.
  useEffect(() => {
    const map = mapRef.current;
    if (!leaflet || !map) return;

    const withPosition = devices.filter(
      (device) => device.lastLocation !== null,
    );
    const visibleIds = new Set(withPosition.map((device) => device.id));

    // Elimina marcadores de dispositivos que ya no tienen posicion.
    for (const [id, marker] of markersRef.current) {
      if (!visibleIds.has(id)) {
        marker.remove();
        markersRef.current.delete(id);
      }
    }
    for (const [id, circle] of circlesRef.current) {
      if (!visibleIds.has(id)) {
        circle.remove();
        circlesRef.current.delete(id);
      }
    }

    for (const device of withPosition) {
      const location = device.lastLocation;
      if (!location) continue;
      const latlng: [number, number] = [location.latitude, location.longitude];
      const color = COLOR_BY_FRESHNESS[device.freshness];
      const selected = device.id === selectedId;

      let marker = markersRef.current.get(device.id);
      if (!marker) {
        marker = leaflet
          .marker(latlng, {
            icon: leaflet.divIcon({
              className: "geo-admin-marker",
              html: `<span class="geo-admin-dot${selected ? " is-selected" : ""}" style="--dot-color:${color}"></span>`,
              iconSize: [20, 20],
              iconAnchor: [10, 10],
            }),
            zIndexOffset: selected ? 1000 : 0,
            keyboard: false,
          })
          .addTo(map);
        marker.on("click", () => onSelectRef.current(device.id));
        markersRef.current.set(device.id, marker);
      } else {
        marker.setLatLng(latlng);
        marker.setZIndexOffset(selected ? 1000 : 0);
        marker.setIcon(
          leaflet.divIcon({
            className: "geo-admin-marker",
            html: `<span class="geo-admin-dot${selected ? " is-selected" : ""}" style="--dot-color:${color}"></span>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          }),
        );
      }

      const address = device.address?.label ?? device.address?.formattedAddress;
      marker.bindTooltip(
        `<strong>${escapeHtml(device.deviceName)}</strong><br/>${escapeHtml(
          device.userEmail,
        )}${address ? `<br/>${escapeHtml(address)}` : ""}`,
        { direction: "top", offset: [0, -10] },
      );

      // Circulo de incertidumbre: refleja la precision reportada por el GPS.
      const accuracy = location.accuracyMeters;
      if (typeof accuracy === "number" && accuracy > 0) {
        let circle = circlesRef.current.get(device.id);
        if (!circle) {
          circle = leaflet
            .circle(latlng, {
              radius: accuracy,
              color,
              weight: 1,
              fillColor: color,
              fillOpacity: selected ? 0.18 : 0.08,
            })
            .addTo(map);
          circlesRef.current.set(device.id, circle);
        } else {
          circle.setLatLng(latlng);
          circle.setRadius(accuracy);
          circle.setStyle({
            color,
            fillColor: color,
            fillOpacity: selected ? 0.18 : 0.08,
          });
        }
      } else {
        circlesRef.current.get(device.id)?.remove();
        circlesRef.current.delete(device.id);
      }
    }

    // Encuadra todos los dispositivos la primera vez que hay alguno.
    if (!didFitRef.current && withPosition.length > 0) {
      const points = withPosition.map(
        (device) =>
          [device.lastLocation!.latitude, device.lastLocation!.longitude] as [
            number,
            number,
          ],
      );
      map.fitBounds(leaflet.latLngBounds(points), {
        padding: [40, 40],
        maxZoom: 15,
      });
      didFitRef.current = true;
    }
  }, [leaflet, devices, selectedId]);

  // Recorrido reciente del dispositivo seleccionado.
  useEffect(() => {
    const map = mapRef.current;
    if (!leaflet || !map) return;
    const points = (trail ?? []).map(
      (point) => [point.latitude, point.longitude] as [number, number],
    );

    if (points.length < 2) {
      trailRef.current?.remove();
      trailRef.current = null;
      return;
    }

    if (!trailRef.current) {
      trailRef.current = leaflet
        .polyline(points, { color: "#38bdf8", weight: 3, opacity: 0.7 })
        .addTo(map);
    } else {
      trailRef.current.setLatLngs(points);
    }
  }, [leaflet, trail]);

  // Boton "Centrar": encuadra todos los dispositivos visible
  useEffect(() => {
    const map = mapRef.current;
    if (!leaflet || !map || fitSignal === 0) return;
    const points = devices
      .filter((device) => device.lastLocation !== null)
      .map(
        (device) =>
          [device.lastLocation!.latitude, device.lastLocation!.longitude] as [
            number,
            number,
          ],
      );
    if (points.length === 0) return;
    map.fitBounds(leaflet.latLngBounds(points), {
      padding: [40, 40],
      maxZoom: 15,
    });
    // `devices` se omite a proposito: solo se reacciona a la senal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitSignal]);

  const positionedCount = devices.filter(
    (device) => device.lastLocation !== null,
  ).length;

  return (
    <div className="map-wrap">
      <div className="map-canvas admin-map-canvas" ref={containerRef} />
      {loadError && (
        <div className="map-empty">
          <div>
            <p>{loadError}</p>
            <p className="small muted">
              Las coordenadas siguen disponibles en la tabla de dispositivos.
            </p>
          </div>
        </div>
      )}
      {!loadError && positionedCount === 0 && (
        <div className="map-empty">
          <div>
            <p>Ningun dispositivo ha reportado coordenadas.</p>
            <p className="small muted">
              Cuando un dispositivo comparta su ubicacion aparecera aqui.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
