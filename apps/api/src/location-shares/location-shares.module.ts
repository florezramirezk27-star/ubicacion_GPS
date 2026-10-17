import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { DevicesModule } from "../devices/devices.module";
import { LocationSharesController } from "./location-shares.controller";
import { LocationSharesService } from "./location-shares.service";
import { ShareTokenGuard } from "./share-token.guard";

/**
 * `AdminModule` se importa para notificar al panel de administracion cuando
 * cambia el estado de una sesion de comparticion (inicio, parada o revocacion).
 */
@Module({
  imports: [DevicesModule, AdminModule],
  controllers: [LocationSharesController],
  providers: [LocationSharesService, ShareTokenGuard],
  exports: [LocationSharesService, ShareTokenGuard],
})
export class LocationSharesModule {}
