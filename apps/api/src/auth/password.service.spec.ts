import { PasswordService } from "./password.service";

describe("PasswordService", () => {
  const service = new PasswordService();

  describe("hash", () => {
    it("produce el formato scrypt$N$r$p$salt$hash", async () => {
      const stored = await service.hash("Clave1234");
      const parts = stored.split("$");

      expect(parts).toHaveLength(6);
      expect(parts[0]).toBe("scrypt");
      expect(parts[1]).toBe("32768"); // N = 2^15
      expect(parts[2]).toBe("8"); // r
      expect(parts[3]).toBe("1"); // p
      expect(parts[4]).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(parts[5]).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it("nunca guarda la contrasena en claro", async () => {
      const stored = await service.hash("Clave1234");
      expect(stored).not.toContain("Clave1234");
    });

    it("usa un salt distinto en cada llamada", async () => {
      const first = await service.hash("Clave1234");
      const second = await service.hash("Clave1234");

      expect(first).not.toBe(second);
      // Distinto salt, pero ambos verifican la misma contrasena.
      expect(await service.verify("Clave1234", first)).toBe(true);
      expect(await service.verify("Clave1234", second)).toBe(true);
    });
  });

  describe("verify", () => {
    it("acepta la contrasena correcta", async () => {
      const stored = await service.hash("Correcta123");
      expect(await service.verify("Correcta123", stored)).toBe(true);
    });

    it("rechaza una contrasena incorrecta", async () => {
      const stored = await service.hash("Correcta123");
      expect(await service.verify("Incorrecta123", stored)).toBe(false);
      expect(await service.verify("Correcta124", stored)).toBe(false);
      expect(await service.verify("", stored)).toBe(false);
    });

    it("trata las formas Unicode equivalentes igual (normalizacion NFKC)", async () => {
      // "e" y "e\u0301" (e + acento combinante) son equivalentes tras NFKC.
      const stored = await service.hash("cafe\u0301");
      expect(await service.verify("caf\u00e9", stored)).toBe(true);
    });

    it("rechaza valores almacenados malformados sin lanzar excepcion", async () => {
      expect(await service.verify("x", "")).toBe(false);
      expect(await service.verify("x", "bcrypt$1$2$3$4$5")).toBe(false);
      expect(await service.verify("x", "scrypt$no$es$entero$a$b")).toBe(false);
      expect(await service.verify("x", "scrypt$32768$8$1$$")).toBe(false);
      expect(await service.verify("x", "solo-un-valor")).toBe(false);
    });
  });
});
