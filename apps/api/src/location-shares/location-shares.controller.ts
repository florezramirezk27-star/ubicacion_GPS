import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { z } from "zod";
import {
  startShareSchema,
  stopShareSchema,
  type CreatedLocationShare,
  type PublicLocationShare,
  type StartShareInput,
  type StopShareInput,
} from "@geo/shared";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { clientIp } from "../common/http.util";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { AuthenticatedRequest, AuthenticatedUser } from "../common/types";
import { LocationSharesService } from "./location-shares.service";

const listSharesQuerySchema = z.object({
  deviceId: z.string().min(1, "deviceId es obligatorio"),
});

@Controller("shares")
export class LocationSharesController {
  constructor(private readonly shares: LocationSharesService) {}

  /** Inicia una sesion de comparticion. Devuelve el token una unica vez. */
  @Post()
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(startShareSchema)) input: StartShareInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<CreatedLocationShare> {
    return this.shares.start(user.id, input, clientIp(request));
  }

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listSharesQuerySchema))
    query: { deviceId: string },
  ): Promise<PublicLocationShare[]> {
    return this.shares.listForDevice(user.id, query.deviceId);
  }

  @Get(":id")
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<PublicLocationShare> {
    const share = await this.shares.getOwnedOrThrow(user.id, id);
    return this.shares.toPublic(share);
  }

  /** Detiene la comparticion de forma voluntaria. Devuelve 200 (transicion de estado). */
  @HttpCode(HttpStatus.OK)
  @Post(":id/stop")
  stop(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(stopShareSchema)) input: StopShareInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<PublicLocationShare> {
    return this.shares.stop(user.id, id, input, clientIp(request));
  }

  /** Revoca la sesion (corte inmediato, por ejemplo ante sospecha de abuso). Devuelve 200. */
  @HttpCode(HttpStatus.OK)
  @Post(":id/revoke")
  revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(stopShareSchema)) input: StopShareInput,
    @Req() request: AuthenticatedRequest,
  ): Promise<PublicLocationShare> {
    return this.shares.revoke(user.id, id, input, clientIp(request));
  }
}
