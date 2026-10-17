import { ConfigService } from "@nestjs/config";
import { CryptoService } from "./crypto.service";

/** Construye el servicio con una clave de cifrado de 32 bytes (64 caracteres hex). */
function buildService(hexKey = "a".repeat(64)): CryptoService {
  const config = { getOrThrow: () => hexKey } as unknown as ConfigService;
  return new CryptoService(config);
}

describe("CryptoService", () => {
  describe("constructor", () => {
    it("acepta una clave de 32 bytes", () => {
      expect(() => buildService()).not.toThrow();
    });

    it("rechaza una clave que no represente 32 bytes", () => {
      // 32 caracteres hex = 16 bytes: longitud insuficiente.
      expect(() => buildService("ab".repeat(16))).toThrow(/32 bytes/);
    });
  });

  describe("encrypt / decrypt", () => {
    it("recupera exactamente el texto original", () => {
      const crypto = buildService();
      const plain = "metadatos sensibles con acentos: ubicacion, motivo";
      const encrypted = crypto.encrypt(plain);

      expect(encrypted).not.toContain(plain);
      expect(crypto.decrypt(encrypted)).toBe(plain);
    });

    it("produce un texto cifrado distinto cada vez (IV aleatorio)", () => {
      const crypto = buildService();
      const plain = "mismo texto";

      const first = crypto.encrypt(plain);
      const second = crypto.encrypt(plain);

      expect(first).not.toBe(second);
      expect(crypto.decrypt(first)).toBe(plain);
      expect(crypto.decrypt(second)).toBe(plain);
    });

    it("devuelve null si el texto cifrado fue manipulado (integridad GCM)", () => {
      const crypto = buildService();
      const encrypted = crypto.encrypt("contenido original");
      const buffer = Buffer.from(encrypted, "base64");
      // Se altera el ultimo byte del criptograma.
      buffer[buffer.length - 1] ^= 0xff;

      expect(crypto.decrypt(buffer.toString("base64"))).toBeNull();
    });

    it("devuelve null si el valor no tiene la longitud minima", () => {
      const crypto = buildService();
      expect(
        crypto.decrypt(Buffer.from("corto").toString("base64")),
      ).toBeNull();
    });

    it("devuelve null si se intenta descifrar con otra clave", () => {
      const encrypted = buildService("a".repeat(64)).encrypt("secreto");
      const otherKeyService = buildService("b".repeat(64));

      expect(otherKeyService.decrypt(encrypted)).toBeNull();
    });
  });

  describe("sha256", () => {
    it("es determinista y en hexadecimal de 64 caracteres", () => {
      const crypto = buildService();
      const hash = crypto.sha256("token-opaco");

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(crypto.sha256("token-opaco")).toBe(hash);
    });

    it("cambia por completo ante una minima variacion", () => {
      const crypto = buildService();
      expect(crypto.sha256("token")).not.toBe(crypto.sha256("tokeN"));
    });
  });

  describe("randomToken", () => {
    it("genera tokens distintos y aptos para cabeceras", () => {
      const crypto = buildService();
      const a = crypto.randomToken();
      const b = crypto.randomToken();

      expect(a).not.toBe(b);
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("respeta el numero de bytes solicitado", () => {
      const crypto = buildService();
      // 48 bytes en base64url ocupan exactamente 64 caracteres.
      expect(crypto.randomToken(48)).toHaveLength(64);
    });
  });

  describe("safeEquals", () => {
    it("devuelve true para cadenas iguales", () => {
      const crypto = buildService();
      expect(crypto.safeEquals("secreto", "secreto")).toBe(true);
    });

    it("devuelve false para cadenas distintas o de distinta longitud", () => {
      const crypto = buildService();
      expect(crypto.safeEquals("secreto", "secreta")).toBe(false);
      expect(crypto.safeEquals("secreto", "secreto-largo")).toBe(false);
    });
  });
});
