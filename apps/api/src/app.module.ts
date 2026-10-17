import { join } from "node:path";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { AdminModule } from "./admin/admin.module";
import { AuditModule } from "./audit/audit.module";
import { AuthModule } from "./auth/auth.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { JwtAuthGuard } from "./common/guards/jwt-auth.guard";
import { validateEnv } from "./config/env";
import { CryptoModule } from "./crypto/crypto.module";
import { DevicesModule } from "./devices/devices.module";
import { GeocodingModule } from "./geo/geocoding.module";
import { HealthModule } from "./health/health.module";
import { LiveModule } from "./live/live.module";
import { LocationSharesModule } from "./location-shares/location-shares.module";
import { LocationsModule } from "./locations/locations.module";
import { PrismaModule } from "./prisma/prisma.module";
import { RemoteAccessModule } from "./remote-access/remote-access.module";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Se admiten tanto el .env local de la app como el de la raiz del monorepo.
      envFilePath: [
        join(process.cwd(), ".env"),
        join(process.cwd(), "..", "..", ".env"),
      ],
      validate: validateEnv,
    }),
    // El modulo JWT se registra globalmente; los secretos se pasan en cada firma.
    JwtModule.register({ global: true }),
    PrismaModule,
    CryptoModule,
    AuditModule,
    GeocodingModule,
    UsersModule,
    AuthModule,
    DevicesModule,
    LocationSharesModule,
    LocationsModule,
    AdminModule,
    LiveModule,
    RemoteAccessModule,
    HealthModule,
  ],
  providers: [
    // Autenticacion obligatoria por defecto en toda la API.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
