import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  roundForGeocode,
  type GeocodedAddress,
  type GeocodingProvider,
} from "@geo/shared";
import { PrismaService } from "../prisma/prisma.service";
import { parseGoogle, parseNominatim } from "./geocoding.parsers";

/** URL base oficial de cada proveedor. */
const DEFAULT_BASE_URLS: Record<"nominatim" | "google", string> = {
  nominatim: "https://nominatim.openstreetmap.org",
  google: "https://maps.googleapis.com/maps/api",
};

interface CacheRow {
  cacheKey: string;
  provider: string;
  found: boolean;
  formattedAddress: string | null;
  label: string | null;
  street: string | null;
  number: string | null;
  neighborhood: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  postalCode: string | null;
  updatedAt: Date;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * Geocodificacion inversa con cache y limite de peticiones.
 *
 * Recordatorio conceptual (ver docs/investigacion.md): la direccion es una
 * **estimacion** de un proveedor externo; no es una lectura del GPS. Por eso
 * este servicio nunca "inventa" una direccion: si no hay datos, devuelve null.
 *
 * Estrategia para no gastar consultas ni dinero:
 *   1. Las coordenadas se redondean (`GEOCODE_CACHE_DECIMALS`) y se usa una
 *      clave estable `${provider}:${lat}:${lon}`.
 *   2. Toda respuesta (incluido "sin resultado") se guarda en `geocode_cache`
 *      con una vigencia (`GEOCODING_CACHE_TTL_DAYS`).
 *   3. Las llamadas al proveedor se serializan y respetan un intervalo minimo
 *      (`GEOCODING_MIN_INTERVAL_MS`); con Nominatim, 1 peticion/segundo.
 *
 * En las rutas de lectura se usa `lookup`/`lookupMany` (solo cache, nunca
 * red) para no bloquear la respuesta. La red solo se toca en `resolve`, que
 * se invoca de forma asincrona al ingerir coordenadas o bajo demanda.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly provider: GeocodingProvider;
  private readonly apiKey: string;
  private readonly baseUrl: string | null;
  private readonly timeoutMs: number;
  private readonly minIntervalMs: number;
  private readonly cacheTtlMs: number;
  private readonly language: string;
  private readonly userAgent: string;
  private readonly available: boolean;

  private lastRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const requested =
      config.get<GeocodingProvider>("GEOCODING_PROVIDER") ?? "nominatim";
    this.apiKey = config.get<string>("GEOCODING_API_KEY") ?? "";
    this.timeoutMs = config.get<number>("GEOCODING_TIMEOUT_MS") ?? 4000;
    this.minIntervalMs =
      config.get<number>("GEOCODING_MIN_INTERVAL_MS") ?? 1100;
    const ttlDays = config.get<number>("GEOCODING_CACHE_TTL_DAYS") ?? 30;
    this.cacheTtlMs = ttlDays * 24 * 60 * 60 * 1000;
    this.language = config.get<string>("GEOCODING_LANGUAGE") ?? "es";
    this.userAgent =
      config.get<string>("GEOCODING_USER_AGENT") ??
      "geolocalizador-movil/0.1 (proyecto academico)";

    const configuredBase = (
      config.get<string>("GEOCODING_BASE_URL") ?? ""
    ).trim();

    if (requested === "disabled") {
      this.provider = "disabled";
      this.baseUrl = null;
      this.available = false;
    } else if (requested === "google" && this.apiKey.length === 0) {
      this.logger.warn(
        "GEOCODING_PROVIDER=google sin GEOCODING_API_KEY: la geocodificacion queda desactivada.",
      );
      this.provider = "disabled";
      this.baseUrl = null;
      this.available = false;
    } else {
      this.provider = requested;
      this.baseUrl = configuredBase || DEFAULT_BASE_URLS[requested];
      this.available = true;
    }

    this.logger.log(
      this.available
        ? `Geocodificacion inversa activa (proveedor: ${this.provider})`
        : "Geocodificacion inversa desactivada (las direcciones seran nulas)",
    );
  }

  get enabled(): boolean {
    return this.available;
  }

  get providerName(): GeocodingProvider {
    return this.provider;
  }

  /** Clave de cache estable para un par de coordenadas. */
  keyFor(latitude: number, longitude: number): string {
    return `${this.provider}:${roundForGeocode(latitude)}:${roundForGeocode(
      longitude,
    )}`;
  }

  /**
   * Consulta **solo la cache** (nunca la red). Pensado para rutas de lectura:
   * devuelve un mapa `cacheKey -> direccion` para varios puntos a la vez.
   */
  async lookupMany(points: GeoPoint[]): Promise<Map<string, GeocodedAddress>> {
    const result = new Map<string, GeocodedAddress>();
    if (!this.available || points.length === 0) return result;

    const keys = new Set(
      points.map((p) => this.keyFor(p.latitude, p.longitude)),
    );
    if (keys.size === 0) return result;

    const rows = await this.prisma.geocodeCache.findMany({
      where: { cacheKey: { in: [...keys] } },
    });

    const now = Date.now();
    for (const row of rows) {
      if (now - row.updatedAt.getTime() > this.cacheTtlMs) continue;
      const address = this.rowToAddress(row as CacheRow);
      if (address) result.set(row.cacheKey, address);
    }
    return result;
  }

  async lookup(
    latitude: number,
    longitude: number,
  ): Promise<GeocodedAddress | null> {
    const map = await this.lookupMany([{ latitude, longitude }]);
    return map.get(this.keyFor(latitude, longitude)) ?? null;
  }

  /**
   * Cache o proveedor. Usa la red solo si hace falta y respetando el limite
   * de peticiones. Devuelve null si no hay direccion o si el proveedor falla.
   */
  async resolve(
    latitude: number,
    longitude: number,
  ): Promise<GeocodedAddress | null> {
    if (!this.available) return null;

    const cacheKey = this.keyFor(latitude, longitude);
    const existing = await this.prisma.geocodeCache.findUnique({
      where: { cacheKey },
    });
    if (
      existing &&
      Date.now() - existing.updatedAt.getTime() <= this.cacheTtlMs
    ) {
      return this.rowToAddress(existing as CacheRow);
    }

    const lat = roundForGeocode(latitude);
    const lon = roundForGeocode(longitude);
    const address = await this.throttled(() => this.fetchAddress(lat, lon));
    await this.upsertCache(cacheKey, lat, lon, address);
    return address;
  }

  private rowToAddress(row: CacheRow): GeocodedAddress | null {
    if (!row.found || !row.formattedAddress) return null;
    return {
      formattedAddress: row.formattedAddress,
      label: row.label,
      street: row.street,
      number: row.number,
      neighborhood: row.neighborhood,
      city: row.city,
      region: row.region,
      country: row.country,
      postalCode: row.postalCode,
      provider: row.provider,
      fetchedAt: row.updatedAt.toISOString(),
    };
  }

  private buildUrl(latitude: number, longitude: number): string | null {
    if (!this.baseUrl) return null;
    const base = this.baseUrl.replace(/\/+$/, "");

    if (this.provider === "google") {
      const params = new URLSearchParams({
        latlng: `${latitude},${longitude}`,
        key: this.apiKey,
        language: this.language,
      });
      return `${base}/geocode/json?${params.toString()}`;
    }

    const params = new URLSearchParams({
      format: "jsonv2",
      lat: String(latitude),
      lon: String(longitude),
      addressdetails: "1",
      "accept-language": this.language,
    });
    return `${base}/reverse?${params.toString()}`;
  }

  private headers(): Record<string, string> {
    return {
      Accept: "application/json",
      "User-Agent": this.userAgent,
      "Accept-Language": this.language,
    };
  }

  private async fetchAddress(
    latitude: number,
    longitude: number,
  ): Promise<GeocodedAddress | null> {
    const url = this.buildUrl(latitude, longitude);
    if (!url) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        headers: this.headers(),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.logger.warn(`Geocodificacion fallo (HTTP ${response.status})`);
        return null;
      }
      const payload: unknown = await response.json();
      const fetchedAt = new Date().toISOString();
      return this.provider === "google"
        ? parseGoogle(payload, fetchedAt)
        : parseNominatim(payload, fetchedAt);
    } catch (error) {
      this.logger.warn(
        `Geocodificacion no disponible: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Serializa las llamadas y respeta el intervalo minimo entre ellas. */
  private throttled<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastRequestAt);
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.lastRequestAt = Date.now();
      return task();
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async upsertCache(
    cacheKey: string,
    latitude: number,
    longitude: number,
    address: GeocodedAddress | null,
  ): Promise<void> {
    const data = address
      ? {
          found: true,
          formattedAddress: address.formattedAddress,
          label: address.label,
          street: address.street,
          number: address.number,
          neighborhood: address.neighborhood,
          city: address.city,
          region: address.region,
          country: address.country,
          postalCode: address.postalCode,
        }
      : {
          found: false,
          formattedAddress: null,
          label: null,
          street: null,
          number: null,
          neighborhood: null,
          city: null,
          region: null,
          country: null,
          postalCode: null,
        };

    try {
      await this.prisma.geocodeCache.upsert({
        where: { cacheKey },
        create: {
          cacheKey,
          provider: this.provider,
          latitude,
          longitude,
          ...data,
        },
        update: { provider: this.provider, ...data },
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo guardar la direccion en cache: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
