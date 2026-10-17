// Configuracion del CLI de Prisma (v7 la nombra `prisma7.config.ts`).
// Prisma 7 ya no carga .env automaticamente, por eso lo cargamos aqui
// apuntando al .env de la raiz del monorepositorio.
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

loadEnv({ path: ["../../.env", ".env"], quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
