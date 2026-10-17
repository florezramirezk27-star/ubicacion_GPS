import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  FRESHNESS_DEFAULT_OFFLINE_MINUTES,
  classifyFreshness,
  type DeviceLocationSummary,
  type GeocodedAddress,
  type IngestLocationInput,
  type LocationFreshness,
  type PublicLocation,
} from "@geo/shared";
import { AdminGateway } from "../admin/admin.gateway";
import { DevicesService } from "../devices/devices.service";
import { GeocodeGate, GEOCODE_GATE_DEFAULTS } from "../geo/geocode-gate";
import { GeocodingService } from "../geo/geocoding.service";
import { LiveGateway } from "../live/live.gateway";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedShare } from "../common/types";
import { toPublicLocation, type LocationRecord } from "./location.mapper";

/** Diferencia maxima tolerada para marcas de tiempo en el futuro. */
const MAX_FUTURE_SKEW_MS = 60_000;

export interface NearbyLocation extends PublicLocation {
  distanceMeters: number;
}

interface NearbyRow {
  id: string;
  device_id: string;
  share_id: string | null;
  latitude: number;
  longitude: number;
  accuracy_meters: number;
  altitude_meters: number | null;
  speed_mps: number | null;
  heading_degrees: number | null;
  recorded_at: Date;
  received_at: Date;
  distance_meters: number;
}

@Injectable()
export class LocationsService {
  /**
   * Filtro de "cambio significativo" para la geocodificacion inversa.
   * El estado vive por proceso: tras un reinicio se resuelve una vez por
   * dispositivo (una consulta extra, sin coste real por la cache).
   */
  private readonly geocodeGate: GeocodeGate;

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
    private readonly live: LiveGateway,
    private readonly config: ConfigService,
    private readonly geocoding: GeocodingService,
    private readonly admin: AdminGateway,
  ) {
    this.geocodeGate = new GeocodeGate({
      minMoveMeters:
        config.get<number>("GEOCODING_MIN_MOVE_METERS") ??
        GEOCODE_GATE_DEFAULTS.minMoveMeters,
      refreshMs:
        (config.get<number>("GEOCODING_REFRESH_MINUTES") ??
          GEOCODE_GATE_DEFAULTS.refreshMinutes) * 60_000,
    });
  }

  /**
   * Almacena una coordenada enviada por un dispositivo con una sesion activa.
   *
   * Ademas de guardarla:
   *   - actualiza `lastSeenAt` y los metadatos opcionales del dispositivo;
   *   - la difunde por WebSocket a los observadores del dispositivo y a los
   *     administradores (panel global);
   *   - lanza en segundo plano la geocodificacion inversa, **solo cuando el
   *     punto aporta informacion nueva** respecto al ultimo resuelto (no
   *     bloquea la respuesta HTTP: la direccion aparecera en la siguiente
   *     consulta).
   */
  async ingest(
    share: AuthenticatedShare,
    input: IngestLocationInput,
  ): Promise<PublicLocation> {
    const receivedAt = new Date();
    const recordedAt = input.recordedAt
      ? new Date(input.recordedAt)
      : receivedAt;

    if (recordedAt.getTime() > receivedAt.getTime() + MAX_FUTURE_SKEW_MS) {
      throw new BadRequestException("recordedAt no puede estar en el futuro");
    }

    const location = await this.prisma.location.create({
      data: {
        deviceId: share.deviceId,
        shareId: share.id,
        latitude: input.latitude,
        longitude: input.longitude,
        accuracyMeters: input.accuracyMeters,
        altitudeMeters: input.altitudeMeters ?? null,
        speedMps: input.speedMps ?? null,
        headingDegrees: input.headingDegrees ?? null,
        recordedAt,
      },
    });

    await this.devices.touchLastSeen(share.deviceId, receivedAt);
    await this.devices.updateMetadata(share.deviceId, {
      appVersion: input.appVersion,
      osVersion: input.osVersion,
      batteryLevel: input.batteryLevel,
      permissionStatus: input.permissionStatus,
    });

    const publicLocation = toPublicLocation(location as LocationRecord);
    this.live.emitLocation(publicLocation);
    this.live.emitDeviceStatus(share.deviceId, "CONNECTED");
    this.admin.emitLocation(publicLocation);
    this.admin.emitDeviceStatus(share.deviceId, "CONNECTED");

    // Geocodificacion inversa en segundo plano, y solo cuando el punto aporta
    // informacion nueva: las coordenadas se guardan siempre con su precision,
    // pero al proveedor solo se pregunta cuando el dispositivo se ha movido de
    // forma significativa (o ha pasado el tiempo de refresco). Asi no se repite
    // la misma consulta de calle una y otra vez.
    const decision = this.geocodeGate.shouldResolve(
      share.deviceId,
      input.latitude,
      input.longitude,
    );
    if (decision.shouldResolve) {
      void this.geocoding
        .resolve(input.latitude, input.longitude)
        .catch(() => undefined);
    }

    return publicLocation;
  }

  /** Ultima ubicacion conocida de un dispositivo + clasificacion de frescura. */
  async latest(
    userId: string,
    deviceId: string,
  ): Promise<DeviceLocationSummary> {
    await this.devices.findOwnedOrThrow(deviceId, userId);

    const last = await this.prisma.location.findFirst({
      where: { deviceId },
      orderBy: { recordedAt: "desc" },
    });

    if (!last) {
      return {
        deviceId,
        lastLocation: null,
        freshness: "UNKNOWN",
        ageSeconds: null,
        address: null,
      };
    }

    const publicLocation = toPublicLocation(last as LocationRecord);
    const ageSeconds = Math.max(
      0,
      Math.floor((Date.now() - last.recordedAt.getTime()) / 1000),
    );

    // Solo cache: la lectura no debe bloquearse esperando al proveedor.
    const address = await this.geocoding.lookup(last.latitude, last.longitude);

    return {
      deviceId,
      lastLocation: publicLocation,
      freshness: this.classifyFreshness(ageSeconds),
      ageSeconds,
      address,
    };
  }

  /** Resumen de todos los dispositivos del usuario (para la lista del panel). */
  async summaries(userId: string): Promise<DeviceLocationSummary[]> {
    const devices = await this.devices.listForUser(userId);
    if (devices.length === 0) return [];

    const latestRows = await this.prisma.location.findMany({
      where: { deviceId: { in: devices.map((device) => device.id) } },
      orderBy: { recordedAt: "desc" },
      distinct: ["deviceId"],
    });

    const byDevice = new Map(latestRows.map((row) => [row.deviceId, row]));

    const addressMap = await this.geocoding.lookupMany(
      latestRows.map((row) => ({
        latitude: row.latitude,
        longitude: row.longitude,
      })),
    );

    return devices.map((device) => {
      const last = byDevice.get(device.id);
      if (!last) {
        return {
          deviceId: device.id,
          lastLocation: null,
          freshness: "UNKNOWN" as const,
          ageSeconds: null,
          address: null,
        };
      }
      const ageSeconds = Math.max(
        0,
        Math.floor((Date.now() - last.recordedAt.getTime()) / 1000),
      );
      const address: GeocodedAddress | null =
        addressMap.get(this.geocoding.keyFor(last.latitude, last.longitude)) ??
        null;
      return {
        deviceId: device.id,
        lastLocation: toPublicLocation(last as LocationRecord),
        freshness: this.classifyFreshness(ageSeconds),
        ageSeconds,
        address,
      };
    });
  }

  /** Historial paginado de un dispositivo, filtrable por rango de fechas. */
  async history(
    userId: string,
    query: { deviceId: string; from?: string; to?: string; limit: number },
  ): Promise<PublicLocation[]> {
    await this.devices.findOwnedOrThrow(query.deviceId, userId);

    const rows = await this.prisma.location.findMany({
      where: {
        deviceId: query.deviceId,
        recordedAt: {
          ...(query.from ? { gte: new Date(query.from) } : {}),
          ...(query.to ? { lte: new Date(query.to) } : {}),
        },
      },
      orderBy: { recordedAt: "desc" },
      take: query.limit,
    });

    return rows.map((row) => toPublicLocation(row as LocationRecord));
  }

  /**
   * Consulta geografica con PostGIS: ubicaciones dentro de un radio.
   * Demuestra el uso de la columna `geography` y de indices GIST,
   * algo que un filtro por latitud/longitud con BETWEEN no resolveria bien.
   */
  async nearby(
    userId: string,
    params: {
      latitude: number;
      longitude: number;
      radiusMeters: number;
      limit: number;
    },
  ): Promise<NearbyLocation[]> {
    const rows = await this.prisma.$queryRaw<NearbyRow[]>`
      SELECT
        l.id,
        l.device_id,
        l.share_id,
        l.latitude,
        l.longitude,
        l.accuracy_meters,
        l.altitude_meters,
        l.speed_mps,
        l.heading_degrees,
        l.recorded_at,
        l.received_at,
        ST_Distance(
          l.geog,
          ST_SetSRID(ST_MakePoint(${params.longitude}, ${params.latitude}), 4326)::geography
        ) AS distance_meters
      FROM locations l
      WHERE l.geog IS NOT NULL
        AND l.device_id IN (SELECT d.id FROM devices d WHERE d.user_id = ${userId})
        AND ST_DWithin(
          l.geog,
          ST_SetSRID(ST_MakePoint(${params.longitude}, ${params.latitude}), 4326)::geography,
          ${params.radiusMeters}
        )
      ORDER BY l.geog <-> ST_SetSRID(ST_MakePoint(${params.longitude}, ${params.latitude}), 4326)::geography
      LIMIT ${params.limit}
    `;

    return rows.map((row) => ({
      id: row.id,
      deviceId: row.device_id,
      shareId: row.share_id,
      latitude: row.latitude,
      longitude: row.longitude,
      accuracyMeters: row.accuracy_meters,
      altitudeMeters: row.altitude_meters,
      speedMps: row.speed_mps,
      headingDegrees: row.heading_degrees,
      recordedAt: row.recorded_at.toISOString(),
      receivedAt: row.received_at.toISOString(),
      distanceMeters: row.distance_meters,
    }));
  }

  /**
   * Politica de frescura. Los umbrales viven en `@geo/shared` para que el
   * backend y el panel web coincidan exactamente (ver docs/pruebas.md):
   *   CURRENT  -> dato reciente, se puede mostrar como "en vivo"
   *   STALE    -> el dispositivo lleva un rato sin reportar
   *   OFFLINE  -> supera el umbral configurado (STALE_AFTER_MINUTES)
   *   UNKNOWN  -> nunca ha reportado
   */
  classifyFreshness(ageSeconds: number): LocationFreshness {
    const offlineAfterMinutes =
      this.config.get<number>("STALE_AFTER_MINUTES") ??
      FRESHNESS_DEFAULT_OFFLINE_MINUTES;
    return classifyFreshness(ageSeconds, offlineAfterMinutes);
  }
}
