import { Injectable } from "@nestjs/common";
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";

/**
 * Parametros de scrypt. Se eligen buscando un equilibrio entre coste para el
 * atacante y latencia aceptable en un servidor modesto:
 *   N = 2^15 (32768)  -> coste de CPU/memoria
 *   r = 8, p = 1      -> parametros habituales recomendados
 * maxmem se eleva porque por defecto Node limita a 32 MB.
 */
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAX_MEM = 128 * 1024 * 1024;

/**
 * Hash de contrasenas con scrypt (incluido en Node.js).
 * Se evita una dependencia nativa (bcrypt/argon2) que complicaria el
 * despliegue en Windows y en contenedores.
 *
 * Formato almacenado: `scrypt$N$r$p$saltBase64$hashBase64`
 */
@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const derived = await this.derive(
      password,
      salt,
      SCRYPT_N,
      SCRYPT_R,
      SCRYPT_P,
      KEY_LENGTH,
    );
    return [
      "scrypt",
      String(SCRYPT_N),
      String(SCRYPT_R),
      String(SCRYPT_P),
      salt.toString("base64"),
      derived.toString("base64"),
    ].join("$");
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;

    const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
    const n = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p))
      return false;

    const salt = Buffer.from(saltRaw ?? "", "base64");
    const expected = Buffer.from(hashRaw ?? "", "base64");
    if (salt.length === 0 || expected.length === 0) return false;

    const derived = await this.derive(password, salt, n, r, p, expected.length);
    return (
      derived.length === expected.length && timingSafeEqual(derived, expected)
    );
  }

  private derive(
    password: string,
    salt: Buffer,
    n: number,
    r: number,
    p: number,
    keyLength: number,
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      scryptCallback(
        password.normalize("NFKC"),
        salt,
        keyLength,
        { N: n, r, p, maxmem: MAX_MEM },
        (error, derivedKey) => {
          if (error) reject(error);
          else resolve(derivedKey);
        },
      );
    });
  }
}
