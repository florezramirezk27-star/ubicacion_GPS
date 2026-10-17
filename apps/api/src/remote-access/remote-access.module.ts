import { Module } from "@nestjs/common";
import { AdminModule } from "../admin/admin.module";
import { RemoteAccessController } from "./remote-access.controller";
import { RemoteAccessGateway } from "./remote-access.gateway";
import { RemoteAccessService } from "./remote-access.service";

/**
 * Acceso remoto a camara y microfono.
 *
 * Importa `AdminModule` solo para difundir los cambios a los administradores
 * conectados; no crea ninguna dependencia inversa, de modo que no hay riesgo
 * de ciclo con el modulo de administracion.
 *
 * Los servicios de auditoria y Prisma son globales, igual que en el resto de
 * la aplicacion.
 */
@Module({
  imports: [AdminModule],
  controllers: [RemoteAccessController],
  providers: [RemoteAccessService, RemoteAccessGateway],
  exports: [RemoteAccessService],
})
export class RemoteAccessModule {}
