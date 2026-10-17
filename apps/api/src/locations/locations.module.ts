import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { DevicesModule } from "../devices/devices.module";
import { LiveModule } from "../live/live.module";
import { LocationSharesModule } from "../location-shares/location-shares.module";
import { LocationsController } from "./locations.controller";
import { LocationsService } from "./locations.service";

/**
 * Se importa `AdminModule` para poder difundir cada coordenada al panel global
 * de administracion (el `GeocodingModule` es global y no hace falta importarlo).
 */
@Module({
  imports: [DevicesModule, LocationSharesModule, LiveModule, AdminModule],
  controllers: [LocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
