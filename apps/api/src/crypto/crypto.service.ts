import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended for GCM
const AUTH_TAG_LENGTH = 16;

/**
 * Utilidades criptograficas centralizadas.
 *
 * - `encrypt` / `decrypt`: AES-256-GCM (confidencialidad + integridad) para
 *   datos sensibles que se guardan cifrados en reposo (por ejemplo los
 *   metadatos de auditoria).
 * - `sha256`: hash determinista para almacenar tokens opacos (token de
 *   comparticion, token de refresco) sin guardar el valor en claro.
 * - `randomToken`: generador de tokens de alta entropia.
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const hex = config.getOrThrow<string>("DATA_ENCRYPTION_KEY");
    this.key = Buffer.from(hex, "hex");
    if (this.key.length !== 32) {
      throw new Error(
        "DATA_ENCRYPTION_KEY debe representar exactamente 32 bytes (64 caracteres hex)",
      );
    }
  }

  /** Cifra un texto y devuelve `base64(iv | authTag | ciphertext)`. */
  encrypt(plainText: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plainText, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
  }

  /** Descifra un valor producido por `encrypt`. Devuelve null si es invalido. */
  decrypt(payload: string): string | null {
    try {
      const buffer = Buffer.from(payload, "base64");
      if (buffer.length < IV_LENGTH + AUTH_TAG_LENGTH) return null;
      const iv = buffer.subarray(0, IV_LENGTH);
      const authTag = buffer.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
      const ciphertext = buffer.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
      const decipher = createDecipheriv(ALGORITHM, this.key, iv);
      decipher.setAuthTag(authTag);
      const plain = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plain.toString("utf8");
    } catch {
      this.logger.warn(
        "No se pudo descifrar un valor: integridad o clave incorrecta",
      );
      return null;
    }
  }

  /** Hash SHA-256 en hexadecimal (para almacenar tokens opacos). */
  sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  /** Token aleatorio en base64url (apto para URLs y cabeceras). */
  randomToken(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
  }

  /** Comparacion en tiempo constante para evitar ataques de temporizacion. */
  safeEquals(a: string, b: string): boolean {
    const bufferA = Buffer.from(a);
    const bufferB = Buffer.from(b);
    if (bufferA.length !== bufferB.length) return false;
    return timingSafeEqual(bufferA, bufferB);
  }
}
