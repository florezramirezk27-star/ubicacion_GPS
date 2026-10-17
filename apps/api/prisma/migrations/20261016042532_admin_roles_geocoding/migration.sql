-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'SUPERADMIN');

-- NOTA: Prisma no conoce el indice GIST `locations_geog_gist_idx` (se crea con
-- SQL personalizado en la migracion inicial porque la columna `geog` es de tipo
-- Unsupported). Por eso esta migracion generada automaticamente intentaba
-- eliminarlo; esa sentencia se ha retirado para conservar el indice espacial.

-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "app_version" TEXT,
ADD COLUMN     "battery_level" INTEGER,
ADD COLUMN     "metadata_updated_at" TIMESTAMPTZ(6),
ADD COLUMN     "os_version" TEXT,
ADD COLUMN     "permission_status" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'USER';

-- CreateTable
CREATE TABLE "geocode_cache" (
    "id" TEXT NOT NULL,
    "cache_key" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "found" BOOLEAN NOT NULL DEFAULT true,
    "formatted_address" TEXT,
    "label" TEXT,
    "street" TEXT,
    "number" TEXT,
    "neighborhood" TEXT,
    "city" TEXT,
    "region" TEXT,
    "country" TEXT,
    "postal_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "geocode_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "geocode_cache_cache_key_key" ON "geocode_cache"("cache_key");

-- CreateIndex
CREATE INDEX "geocode_cache_provider_idx" ON "geocode_cache"("provider");
