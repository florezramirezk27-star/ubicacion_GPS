-- CreateEnum
CREATE TYPE "RemoteSensor" AS ENUM ('CAMERA', 'MICROPHONE', 'CAMERA_AND_MICROPHONE');

-- CreateEnum
CREATE TYPE "RemoteRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MediaSessionStatus" AS ENUM ('ACTIVE', 'ENDED');

-- NOTA: Prisma no conoce el indice GIST `locations_geog_gist_idx` (se crea con
-- SQL personalizado en la migracion inicial porque la columna `geog` es de tipo
-- Unsupported). Por eso esta migracion generada automaticamente intentaba
-- eliminarlo; esa sentencia se ha retirado para conservar el indice espacial.

-- CreateTable
CREATE TABLE "remote_access_requests" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "sensor" "RemoteSensor" NOT NULL,
    "reason" VARCHAR(280),
    "status" "RemoteRequestStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "responded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "remote_access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_sessions" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "sensor" "RemoteSensor" NOT NULL,
    "status" "MediaSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "ended_by" TEXT,
    "ended_reason" VARCHAR(160),

    CONSTRAINT "media_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "remote_access_requests_device_id_status_idx" ON "remote_access_requests"("device_id", "status");

-- CreateIndex
CREATE INDEX "remote_access_requests_status_expires_at_idx" ON "remote_access_requests"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_sessions_request_id_key" ON "media_sessions"("request_id");

-- CreateIndex
CREATE INDEX "media_sessions_device_id_status_idx" ON "media_sessions"("device_id", "status");

-- AddForeignKey
ALTER TABLE "remote_access_requests" ADD CONSTRAINT "remote_access_requests_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "remote_access_requests" ADD CONSTRAINT "remote_access_requests_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_sessions" ADD CONSTRAINT "media_sessions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "remote_access_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_sessions" ADD CONSTRAINT "media_sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
