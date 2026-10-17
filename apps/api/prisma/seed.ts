/**
 * Datos de demostracion para desarrollo y para la sustentacion.
 *
 * Crea:
 *   - Un usuario demo con contrasena conocida.
 *   - Un dispositivo Android y uno iPhone.
 *   - Un recorrido de ejemplo en Bogota (12 puntos).
 *   - Una sesion de comparticion ACTIVA cuyo token se imprime en consola
 *     para poder probar la ingesta con `curl`.
 *
 * Uso:  pnpm --filter @geo/api seed
 */
import { randomUUID } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { CryptoService } from "../src/crypto/crypto.service";
import { PasswordService } from "../src/auth/password.service";

loadEnv({ path: ["../../.env", ".env"], quiet: true });

const DEMO_EMAIL = "demo@geo.test";
const DEMO_PASSWORD = "Demo1234";

/**
 * Cuenta de Superadministrador para la sustentacion.
 * El panel web la usa para entrar a /admin. En produccion, el rol se otorga
 * mediante `SUPERADMIN_EMAILS` (lista de confianza del operador).
 */
const ADMIN_EMAIL = "admin@geo.test";
const ADMIN_PASSWORD = "Admin1234";

/** Puntos aproximados sobre la carrera Septima de Bogota. */
const RUTA_BOGOTA: Array<[number, number]> = [
  [4.6533, -74.0836],
  [4.6567, -74.0801],
  [4.6601, -74.0766],
  [4.6638, -74.0731],
  [4.6672, -74.0698],
  [4.6709, -74.0664],
  [4.6745, -74.0631],
  [4.6781, -74.0597],
  [4.6817, -74.0562],
  [4.6853, -74.0528],
  [4.6889, -74.0495],
  [4.6925, -74.0461],
];

async function main(): Promise<void> {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL no esta definida. Copia .env.example a .env");
  }

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  // Los servicios no tienen dependencias de Nest salvo ConfigService para la
  // clave de cifrado, por lo que se instancian con un doble minimo.
  const passwords = new PasswordService();
  const fakeConfig = {
    getOrThrow: (key: string) => {
      const value = process.env[key];
      if (!value) throw new Error(`Falta la variable ${key}`);
      return value;
    },
  } as unknown as ConstructorParameters<typeof CryptoService>[0];
  const crypto = new CryptoService(fakeConfig);

  try {
    // Limpieza: al borrar el usuario se eliminan en cascada sus datos.
    await prisma.user.deleteMany({
      where: { email: { in: [DEMO_EMAIL, ADMIN_EMAIL] } },
    });

    const passwordHash = await passwords.hash(DEMO_PASSWORD);
    const user = await prisma.user.create({
      data: { email: DEMO_EMAIL, passwordHash },
    });

    const adminPasswordHash = await passwords.hash(ADMIN_PASSWORD);
    const admin = await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        passwordHash: adminPasswordHash,
        role: "SUPERADMIN",
      },
    });

    const androidDevice = await prisma.device.create({
      data: {
        userId: user.id,
        platform: "ANDROID",
        deviceName: "Pixel de prueba",
        appVersion: "0.1.0",
        osVersion: "Android 14",
        batteryLevel: 82,
        permissionStatus: "granted_foreground",
        metadataUpdatedAt: new Date(),
      },
    });

    const iosDevice = await prisma.device.create({
      data: {
        userId: user.id,
        platform: "IOS",
        deviceName: "iPhone de prueba",
        appVersion: "0.1.0",
        osVersion: "iOS 17",
        batteryLevel: 64,
        permissionStatus: "granted_foreground",
        metadataUpdatedAt: new Date(),
      },
    });

    const base = Date.now() - RUTA_BOGOTA.length * 60_000;

    await prisma.location.createMany({
      data: RUTA_BOGOTA.map(([latitude, longitude], index) => ({
        deviceId: androidDevice.id,
        latitude,
        longitude,
        accuracyMeters: 8 + (index % 3) * 2,
        speedMps: 4.5,
        headingDegrees: 45,
        recordedAt: new Date(base + index * 60_000),
      })),
    });

    // Sesion de comparticion activa con un token conocido para pruebas.
    const shareToken = `demo_${randomUUID()}`;
    const share = await prisma.locationShare.create({
      data: {
        deviceId: androidDevice.id,
        tokenHash: crypto.sha256(shareToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    console.log("\n=== Datos de demostracion creados ===");
    console.log(`Usuario:        ${DEMO_EMAIL}`);
    console.log(`Contrasena:     ${DEMO_PASSWORD}`);
    console.log(
      `Dispositivo:    ${androidDevice.id} (${androidDevice.deviceName})`,
    );
    console.log(`Dispositivo:    ${iosDevice.id} (${iosDevice.deviceName})`);
    console.log(`Sesion activa:  ${share.id}`);
    console.log(`Token de envio: ${shareToken}`);
    console.log("\n--- Panel de administracion (SUPERADMIN) ---");
    console.log(`Superadmin:     ${ADMIN_EMAIL}`);
    console.log(`Contrasena:     ${ADMIN_PASSWORD}`);
    console.log(`Rol:            ${admin.role}`);
    console.log(`Panel web:      http://localhost:3000/admin`);
    console.log("\nEjemplo de ingesta de coordenadas:");
    console.log(
      `curl -X POST http://localhost:3001/locations -H "Content-Type: application/json" -H "X-Share-Token: ${shareToken}" -d '{"latitude":4.65,"longitude":-74.08,"accuracyMeters":10}'`,
    );
    console.log("");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Error al ejecutar el seed:", error);
  process.exit(1);
});
