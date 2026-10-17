import { Module } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { AdminGuard } from "./admin.guard";
import { AdminGateway } from "./admin.gateway";
import { AdminService } from "./admin.service";

/**
 * Modulo de administracion (rol SUPERADMIN).
 *
 * No importa otros modulos funcionales: usa el cliente de Prisma global y los
 * servicios globales (auditoria, geocodificacion, configuracion). Asi se evita
 * cualquier dependencia circular con `LocationsModule`, que si importa este
 * modulo para difundir las coordenadas a los administradores.
 */
@Module({
  controllers: [AdminController],
  providers: [AdminService, AdminGateway, AdminGuard],
  exports: [AdminGateway],
})
export class AdminModule {}
