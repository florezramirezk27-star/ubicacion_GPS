import { Global, Module } from "@nestjs/common";
import { GeocodingService } from "./geocoding.service";

/**
 * Modulo global de geocodificacion inversa. Se marca `@Global` porque lo usan
 * tanto el modulo de ubicaciones como el de administracion, y no tiene
 * dependencias propias mas alla de los modulos globales (Prisma, Config).
 */
@Global()
@Module({
  providers: [GeocodingService],
  exports: [GeocodingService],
})
export class GeocodingModule {}
