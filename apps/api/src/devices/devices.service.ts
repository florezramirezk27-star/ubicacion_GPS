import { Injectable, NotFoundException } from "@nestjs/common";
import type {
  CreateDeviceInput,
  PublicDevice,
  UpdateDeviceInput,
} from "@geo/shared";
import type { DevicePlatform } from "@geo/shared";
import { PrismaService } from "../prisma/prisma.service";

export interface DeviceRecord {
  id: string;
  userId: string;
  platform: DevicePlatform;
  deviceName: string;
  lastSeenAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    input: CreateDeviceInput,
  ): Promise<DeviceRecord> {
    return this.prisma.device.create({
      data: {
        userId,
        platform: input.platform,
        deviceName: input.deviceName,
      },
    });
  }

  async listForUser(userId: string): Promise<DeviceRecord[]> {
    return this.prisma.device.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Recupera un dispositivo comprobando la propiedad.
   * Si no existe o no pertenece al usuario, se responde 404 (no 403)
   * para no revelar la existencia de dispositivos ajenos.
   */
  async findOwnedOrThrow(
    deviceId: string,
    userId: string,
  ): Promise<DeviceRecord> {
    const device = await this.prisma.device.findFirst({
      where: { id: deviceId, userId },
    });
    if (!device) {
      throw new NotFoundException("Dispositivo no encontrado");
    }
    return device;
  }

  async update(
    deviceId: string,
    userId: string,
    input: UpdateDeviceInput,
  ): Promise<DeviceRecord> {
    await this.findOwnedOrThrow(deviceId, userId);
    return this.prisma.device.update({
      where: { id: deviceId },
      data: { deviceName: input.deviceName },
    });
  }

  async remove(deviceId: string, userId: string): Promise<{ success: true }> {
    await this.findOwnedOrThrow(deviceId, userId);
    await this.prisma.device.delete({ where: { id: deviceId } });
    return { success: true };
  }

  /** Actualiza la marca de ultima vez visto (se llama al ingerir una ubicacion). */
  async touchLastSeen(deviceId: string, at: Date): Promise<void> {
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: at },
    });
  }

  /**
   * Actualiza los metadatos opcionales que la app reporta junto con una
   * coordenada (version de la app, sistema operativo, bateria y estado del
   * permiso de ubicacion). Si no llega ninguno, no se toca la fila: el panel
   * mostrara "no reportado" en lugar de un valor inventado.
   */
  async updateMetadata(
    deviceId: string,
    metadata: {
      appVersion?: string;
      osVersion?: string;
      batteryLevel?: number | null;
      permissionStatus?: string;
    },
  ): Promise<void> {
    const data: {
      appVersion?: string;
      osVersion?: string;
      batteryLevel?: number;
      permissionStatus?: string;
      metadataUpdatedAt: Date;
    } = { metadataUpdatedAt: new Date() };

    let hasAny = false;
    if (metadata.appVersion) {
      data.appVersion = metadata.appVersion;
      hasAny = true;
    }
    if (metadata.osVersion) {
      data.osVersion = metadata.osVersion;
      hasAny = true;
    }
    if (metadata.batteryLevel !== undefined && metadata.batteryLevel !== null) {
      data.batteryLevel = metadata.batteryLevel;
      hasAny = true;
    }
    if (metadata.permissionStatus) {
      data.permissionStatus = metadata.permissionStatus;
      hasAny = true;
    }

    if (!hasAny) return;

    await this.prisma.device.update({ where: { id: deviceId }, data });
  }

  toPublic(device: DeviceRecord): PublicDevice {
    return {
      id: device.id,
      userId: device.userId,
      platform: device.platform,
      deviceName: device.deviceName,
      lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
      createdAt: device.createdAt.toISOString(),
    };
  }
}
