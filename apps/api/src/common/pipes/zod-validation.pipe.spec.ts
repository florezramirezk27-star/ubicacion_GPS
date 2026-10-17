import { BadRequestException } from "@nestjs/common";
import type { ArgumentMetadata } from "@nestjs/common";
import { ingestLocationSchema, loginSchema } from "@geo/shared";
import { ZodValidationPipe } from "./zod-validation.pipe";

const metadata: ArgumentMetadata = { type: "body" };

describe("ZodValidationPipe", () => {
  describe("entrada valida", () => {
    it("devuelve los datos ya validados", () => {
      const pipe = new ZodValidationPipe(loginSchema);
      const result = pipe.transform(
        { email: "ana@correo.com", password: "Clave1234" },
        metadata,
      );

      expect(result).toEqual({
        email: "ana@correo.com",
        password: "Clave1234",
      });
    });

    it("acepta una coordenada en el limite exacto de precision", () => {
      const pipe = new ZodValidationPipe(ingestLocationSchema);
      const result = pipe.transform(
        { latitude: 4.6768, longitude: -74.0482, accuracyMeters: 5000 },
        metadata,
      ) as { accuracyMeters: number };

      expect(result.accuracyMeters).toBe(5000);
    });
  });

  describe("entrada invalida", () => {
    it("lanza BadRequestException", () => {
      const pipe = new ZodValidationPipe(loginSchema);
      expect(() =>
        pipe.transform({ email: "no-es-correo", password: "corta" }, metadata),
      ).toThrow(BadRequestException);
    });

    it("describe el campo y el motivo del rechazo", () => {
      const pipe = new ZodValidationPipe(ingestLocationSchema);

      try {
        pipe.transform(
          { latitude: 91, longitude: 0, accuracyMeters: 10 },
          metadata,
        );
        throw new Error("deberia haber lanzado");
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        const body = (error as BadRequestException).getResponse() as {
          error: string;
          details: { field: string; message: string }[];
        };
        expect(body.error).toBe("ValidationError");
        expect(body.details.some((detail) => detail.field === "latitude")).toBe(
          true,
        );
      }
    });

    it("rechaza una precision poco fiable (mas de 5000 m)", () => {
      const pipe = new ZodValidationPipe(ingestLocationSchema);
      expect(() =>
        pipe.transform(
          { latitude: 4.6, longitude: -74, accuracyMeters: 5001 },
          metadata,
        ),
      ).toThrow(BadRequestException);
    });

    it("rechaza una fecha de captura que no sea ISO 8601", () => {
      const pipe = new ZodValidationPipe(ingestLocationSchema);
      expect(() =>
        pipe.transform(
          {
            latitude: 4.6,
            longitude: -74,
            accuracyMeters: 10,
            recordedAt: "ayer por la tarde",
          },
          metadata,
        ),
      ).toThrow(BadRequestException);
    });

    it("rechaza un cuerpo que no es un objeto", () => {
      const pipe = new ZodValidationPipe(ingestLocationSchema);
      expect(() => pipe.transform(null, metadata)).toThrow(BadRequestException);
      expect(() => pipe.transform("texto", metadata)).toThrow(
        BadRequestException,
      );
    });
  });
});
