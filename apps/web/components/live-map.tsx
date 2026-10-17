"use client";

import { useEffect, useRef, useState } from "react";
import type { Circle, Map as LeafletMap, Marker, Polyline } from "leaflet";

/** @types/leaflet usa `export =`, por lo que el tipo del modulo es el namespace. */
type LeafletRuntime = typeof import("leaflet");

export interface MapPosition {
  latitude: number;
  longitude: number;
}

interface LiveMapProps {
  position: MapPosition | null;
  accuracyMeters?: number | null;
  trail?: MapPosition[];
  follow?: boolean;
}

const DEFAULT_CENTER: [number, number] = [4.6533, -74.0836];

/**
 * Mapa Leaflet + OpenStreetMap.
 *
 * Se usa Leaflet de forma imperativa (sin react-leaflet) por dos motivos:
 *   1. Evita problemas de SSR: Leaflet necesita `window`, y aqui solo se carga
 *      de forma diferida dentro de un efecto, ya en el navegador.
 *   2. Control total sobre como se mueve el marcador al llegar coordenadas
 *      nuevas, sin re-renderizar el mapa completo.
 *
 * No se usan imagenes para el marcador: se dibuja un punto con pulso por CSS,
 * lo que evita los tipicos problemas de rutas de iconos con empaquetadores.
 */
export function LiveMap({
  position,
  accuracyMeters,
  trail,
  follow = true,
}: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const circleRef = useRef<Circle | null>(null);
  const trailRef = useRef<Polyline | null>(null);
  const [leaflet, setLeaflet] = useState<LeafletRuntime | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const tileUrl =
    process.env.NEXT_PUBLIC_MAP_TILE_URL ??
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

  // Carga diferida de Leaflet (solo navegador).
  useEffect(() => {
    let active = true;
    import("leaflet")
      .then((module) => {
        if (!active) return;
        // El build ESM de Leaflet expone `default`; el `export =` de los tipos no.
        // Se cubren ambos casos en tiempo de ejecucion.
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
      zoom: 15,
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

    // Leaflet necesita recalcular el tamano cuando el contenedor ya es visible.
    const timer = window.setTimeout(() => map.invalidateSize(), 200);

    return () => {
      window.clearTimeout(timer);
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
      trailRef.current = null;
    };
  }, [leaflet, tileUrl]);

  // Mueve el marcador y el circulo de precision.
  useEffect(() => {
    if (!leaflet || !mapRef.current) return;
    const map = mapRef.current;

    if (!position) {
      markerRef.current?.remove();
      markerRef.current = null;
      circleRef.current?.remove();
      circleRef.current = null;
      return;
    }

    const latlng: [number, number] = [position.latitude, position.longitude];

    if (!markerRef.current) {
      markerRef.current = leaflet
        .marker(latlng, {
          icon: leaflet.divIcon({
            className: "geo-live-marker",
            html: '<span class="geo-live-dot"></span>',
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          }),
          zIndexOffset: 1000,
          keyboard: false,
        })
        .addTo(map);
    } else {
      markerRef.current.setLatLng(latlng);
    }

    if (typeof accuracyMeters === "number" && accuracyMeters > 0) {
      if (!circleRef.current) {
        circleRef.current = leaflet
          .circle(latlng, {
            radius: accuracyMeters,
            color: "#38bdf8",
            weight: 1,
            fillColor: "#38bdf8",
            fillOpacity: 0.12,
          })
          .addTo(map);
      } else {
        circleRef.current.setLatLng(latlng);
        circleRef.current.setRadius(accuracyMeters);
      }
    } else if (circleRef.current) {
      circleRef.current.remove();
      circleRef.current = null;
    }

    if (follow) {
      map.panTo(latlng, { animate: true, duration: 0.6 });
    }
  }, [leaflet, position, accuracyMeters, follow]);

  // Dibuja el recorrido del historial reciente.
  useEffect(() => {
    if (!leaflet || !mapRef.current) return;
    const map = mapRef.current;
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
        .polyline(points, { color: "#38bdf8", weight: 3, opacity: 0.65 })
        .addTo(map);
    } else {
      trailRef.current.setLatLngs(points);
    }
  }, [leaflet, trail]);

  return (
    <div className="map-wrap">
      <div className="map-canvas" ref={containerRef} />
      {loadError && (
        <div className="map-empty">
          <div>
            <p>{loadError}</p>
            <p className="small muted">
              Las coordenadas siguen disponibles en la tarjeta de detalle.
            </p>
          </div>
        </div>
      )}
      {!loadError && !position && (
        <div className="map-empty">
          <div>
            <p>Sin ubicacion para mostrar.</p>
            <p className="small muted">
              Inicia una sesion de comparticion e inicia el envio desde el
              dispositivo.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
