import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";

// El panel comparte el .env de la raiz del monorepositorio.
loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const tileUrl =
  process.env.NEXT_PUBLIC_MAP_TILE_URL ??
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // El paquete compartido se distribuye como CommonJS; Next lo transpila igualmente.
  transpilePackages: ["@geo/shared"],
  env: {
    NEXT_PUBLIC_API_URL: apiUrl,
    NEXT_PUBLIC_MAP_TILE_URL: tileUrl,
  },
};

export default nextConfig;
