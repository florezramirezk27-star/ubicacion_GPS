import {
  FRESHNESS_CURRENT_SECONDS,
  FRESHNESS_DEFAULT_OFFLINE_MINUTES,
  classifyFreshness,
  ingestLocationSchema,
} from "@geo/shared";

/**
 * La politica de frescura es un requisito explicito del proyecto: "tiempo real
 * no significa GPS continuo e instantaneo". Estas pruebas fijan los limites
 * exactos para que ni el backend ni el panel puedan presentar como actual un
 * dato antiguo.
 */
describe("clasificacion de frescura (politica compartida)", () => {
  it("un dispositivo que nunca reporto es UNKNOWN", () => {
    expect(classifyFreshness(null)).toBe("UNKNOWN");
  });

  it("una lectura reciente es CURRENT", () => {
    expect(classifyFreshness(0)).toBe("CURRENT");
    expect(classifyFreshness(1)).toBe("CURRENT");
    // El limite exacto sigue siendo actual.
    expect(classifyFreshness(FRESHNESS_CURRENT_SECONDS)).toBe("CURRENT");
  });

  it("una lectura pasada de 2 minutos es STALE (datos antiguos)", () => {
    expect(classifyFreshness(FRESHNESS_CURRENT_SECONDS + 1)).toBe("STALE");
    expect(classifyFreshness(600)).toBe("STALE");
    // 15 minutos (900 s) todavia es STALE, no OFFLINE.
    expect(classifyFreshness(FRESHNESS_DEFAULT_OFFLINE_MINUTES * 60)).toBe(
      "STALE",
    );
  });

  it("una lectura pasada de 15 minutos es OFFLINE (dispositivo desconectado)", () => {
    expect(classifyFreshness(FRESHNESS_DEFAULT_OFFLINE_MINUTES * 60 + 1)).toBe(
      "OFFLINE",
    );
    expect(classifyFreshness(60 * 60 * 24)).toBe("OFFLINE");
  });

  it("respeta un umbral de desconexion personalizado", () => {
    // El limite de CURRENT (120 s) es fijo; el parametro solo mueve el de
    // desconexion. Con 5 minutos, la banda STALE va de 121 s a 300 s.
    expect(classifyFreshness(200, 5)).toBe("STALE");
    expect(classifyFreshness(300, 5)).toBe("STALE");
    expect(classifyFreshness(301, 5)).toBe("OFFLINE");
  });

  it("si el umbral de desconexion cae por debajo de 2 minutos, no hay banda STALE", () => {
    // Con 2 minutos (120 s) como umbral, cualquier lectura de mas de 120 s ya
    // es OFFLINE: no existe zona intermedia.
    expect(classifyFreshness(100, 2)).toBe("CURRENT");
    expect(classifyFreshness(121, 2)).toBe("OFFLINE");
  });

  it("los umbrales por defecto son los documentados", () => {
    expect(FRESHNESS_CURRENT_SECONDS).toBe(120);
    expect(FRESHNESS_DEFAULT_OFFLINE_MINUTES).toBe(15);
  });

  it("la clasificacion nunca es ambigua en los bordes", () => {
    // No puede haber un valor que cumpla dos clasificaciones a la vez.
    expect(classifyFreshness(120)).not.toBe(classifyFreshness(121));
    expect(classifyFreshness(900)).not.toBe(classifyFreshness(901));
  });
});

describe("ingestLocationSchema (limites fisicos)", () => {
  const base = { latitude: 4.6768, longitude: -74.0482, accuracyMeters: 10 };

  it("acepta una coordenada valida con los campos opcionales", () => {
    const result = ingestLocationSchema.safeParse({
      ...base,
      altitudeMeters: 2551.3,
      speedMps: 1.4,
      headingDegrees: 90,
      recordedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it("exige la precision en metros", () => {
    const result = ingestLocationSchema.safeParse({
      latitude: 4.6,
      longitude: -74,
    });
    expect(result.success).toBe(false);
  });

  it("rechaza coordenadas fuera del rango fisico", () => {
    expect(
      ingestLocationSchema.safeParse({ ...base, latitude: 90.1 }).success,
    ).toBe(false);
    expect(
      ingestLocationSchema.safeParse({ ...base, latitude: -90.1 }).success,
    ).toBe(false);
    expect(
      ingestLocationSchema.safeParse({ ...base, longitude: 180.1 }).success,
    ).toBe(false);
    expect(
      ingestLocationSchema.safeParse({ ...base, longitude: -180.1 }).success,
    ).toBe(false);
  });

  it("acepta exactamente los limites del rango", () => {
    expect(
      ingestLocationSchema.safeParse({ ...base, latitude: 90 }).success,
    ).toBe(true);
    expect(
      ingestLocationSchema.safeParse({ ...base, latitude: -90 }).success,
    ).toBe(true);
    expect(
      ingestLocationSchema.safeParse({ ...base, longitude: 180 }).success,
    ).toBe(true);
    expect(
      ingestLocationSchema.safeParse({ ...base, longitude: -180 }).success,
    ).toBe(true);
  });

  it("rechaza una precision negativa o excesiva", () => {
    expect(
      ingestLocationSchema.safeParse({ ...base, accuracyMeters: -1 }).success,
    ).toBe(false);
    expect(
      ingestLocationSchema.safeParse({ ...base, accuracyMeters: 5001 }).success,
    ).toBe(false);
    expect(
      ingestLocationSchema.safeParse({ ...base, accuracyMeters: 5000 }).success,
    ).toBe(true);
  });

  it("rechaza un rumbo fuera de 0-360", () => {
    expect(
      ingestLocationSchema.safeParse({ ...base, headingDegrees: 361 }).success,
    ).toBe(false);
    expect(
      ingestLocationSchema.safeParse({ ...base, headingDegrees: 360 }).success,
    ).toBe(true);
  });

  it("permite altitud, velocidad y rumbo nulos", () => {
    const result = ingestLocationSchema.safeParse({
      ...base,
      altitudeMeters: null,
      speedMps: null,
      headingDegrees: null,
    });
    expect(result.success).toBe(true);
  });
});
