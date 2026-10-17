import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

/**
 * Cliente de Prisma para Prisma ORM v7.
 *
 * En v7 el motor de consultas ya no es Rust: se usa un *driver adapter*
 * (`@prisma/adapter-pg`) que trabaja directamente sobre `pg`.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const connectionString = config.getOrThrow<string>("DATABASE_URL");
    super({
      adapter: new PrismaPg({ connectionString }),
      log: [
        { emit: "event", level: "error" },
        { emit: "event", level: "warn" },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log("Conexion a PostgreSQL establecida");
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log("Conexion a PostgreSQL cerrada");
  }
}
