import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import {
  createDeviceSchema,
  updateDeviceSchema,
  type CreateDeviceInput,
  type PublicDevice,
  type UpdateDeviceInput,
} from "@geo/shared";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe";
import type { AuthenticatedUser } from "../common/types";
import { DevicesService } from "./devices.service";

@Controller("devices")
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post()
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createDeviceSchema)) input: CreateDeviceInput,
  ): Promise<PublicDevice> {
    const device = await this.devices.create(user.id, input);
    return this.devices.toPublic(device);
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<PublicDevice[]> {
    const devices = await this.devices.listForUser(user.id);
    return devices.map((device) => this.devices.toPublic(device));
  }

  @Get(":id")
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<PublicDevice> {
    const device = await this.devices.findOwnedOrThrow(id, user.id);
    return this.devices.toPublic(device);
  }

  @Patch(":id")
  async rename(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateDeviceSchema)) input: UpdateDeviceInput,
  ): Promise<PublicDevice> {
    const device = await this.devices.update(id, user.id, input);
    return this.devices.toPublic(device);
  }

  @Delete(":id")
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<{ success: true }> {
    return this.devices.remove(id, user.id);
  }
}
