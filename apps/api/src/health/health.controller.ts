import { Controller, Get } from "@nestjs/common";
import { Public } from "../common/decorators/public.decorator";
import { PrismaService } from "../prisma/prisma.service";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Comprobacion de vida con verificacion real de la base de datos. */
  @Public()
  @Get()
  async check(): Promise<{
    status: string;
    database: string;
    timestamp: string;
  }> {
    let database = "down";
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      database = "up";
    } catch {
      database = "down";
    }

    return {
      status: database === "up" ? "ok" : "degraded",
      database,
      timestamp: new Date().toISOString(),
    };
  }
}
