import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import {
  historyQuerySchema,
  ingestLocationSchema,
  type DeviceLocationSummary,
  type HistoryQueryInput,
  type IngestLocationInput,
  type PublicLocation,
} from "@geo/shared";
import { CurrentShare } from "../common/decorators/current-share.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { Public } from "../common/decorators/public.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { AuthenticatedShare, AuthenticatedUser } from "../common/types";
import { ShareTokenGuard } from "../location-shares/share-token.guard";
import { LocationsService, type NearbyLocation } from "./locations.service";

const deviceIdQuerySchema = z.object({
  deviceId: z.string().min(1, "deviceId es obligatorio"),
});

const nearbyQuerySchema = z.object({
  latitude: z.coerce.number().gte(-90).lte(90),
  longitude: z.coerce.number().gte(-180).lte(180),
  radiusMeters: z.coerce.number().positive().max(500_000).default(5_000),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

@Controller("locations")
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  /**
   * Ingesta de coordenadas. NO usa JWT de usuario: se autentica con el token
   * de la sesion de comparticion (cabecera `X-Share-Token`).
   */
  @Public()
  @UseGuards(ShareTokenGuard)
  @Post()
  ingest(
    @CurrentShare() share: AuthenticatedShare,
    @Body(new ZodValidationPipe(ingestLocationSchema))
    input: IngestLocationInput,
  ): Promise<PublicLocation> {
    return this.locations.ingest(share, input);
  }

  /** Resumen de todos los dispositivos del usuario (ultima ubicacion + frescura). */
  @Get("summaries")
  summaries(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceLocationSummary[]> {
    return this.locations.summaries(user.id);
  }

  @Get("latest")
  latest(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(deviceIdQuerySchema))
    query: { deviceId: string },
  ): Promise<DeviceLocationSummary> {
    return this.locations.latest(user.id, query.deviceId);
  }

  @Get("history")
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(historyQuerySchema)) query: HistoryQueryInput,
  ): Promise<PublicLocation[]> {
    return this.locations.history(user.id, query);
  }

  /** Consulta geografica PostGIS: coordenadas dentro de un radio (en metros). */
  @Get("nearby")
  nearby(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(nearbyQuerySchema))
    query: {
      latitude: number;
      longitude: number;
      radiusMeters: number;
      limit: number;
    },
  ): Promise<NearbyLocation[]> {
    return this.locations.nearby(user.id, query);
  }
}
