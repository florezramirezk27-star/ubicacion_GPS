import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { parseCorsOrigins } from "./config/env";
import { ConfiguredIoAdapter } from "./live/io-adapter";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const allowedOrigins = parseCorsOrigins(
    config.get<string>("CORS_ORIGINS") ?? "",
  );

  // WebSocket con la misma politica de CORS que la API REST.
  app.useWebSocketAdapter(new ConfiguredIoAdapter(app, allowedOrigins));

  app.enableCors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: true,
  });

  // Permite a Prisma cerrar la conexion al apagar el proceso.
  app.enableShutdownHooks();

  const port = config.get<number>("API_PORT") ?? 3001;
  const host = config.get<string>("API_HOST") ?? "0.0.0.0";

  await app.listen(port, host);
  Logger.log(`API disponible en http://${host}:${port}`, "Bootstrap");
  Logger.log(
    allowedOrigins.length > 0
      ? `CORS habilitado para: ${allowedOrigins.join(", ")}`
      : "CORS abierto (solo recomendable en desarrollo)",
    "Bootstrap",
  );
}

void bootstrap();
