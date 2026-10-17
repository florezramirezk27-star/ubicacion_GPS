import {
  GEOCODE_GATE_DEFAULTS,
  GeocodeGate,
  haversineMeters,
} from "./geocode-gate";

/**
 * Requisito explicito del proyecto: no se envia cada coordenada a un servicio
 * de geocodificacion. Estas pruebas fijan cuando SI y cuando NO se consulta la
 * direccion, para que nadie "optimice" esto sin darse cuenta de que dispara el
 * consumo de red y de cuota del proveedor.
 */
describe("filtro de cambio significativo (geocodificacion)", () => {
  const options = { minMoveMeters: 100, refreshMs: 10 * 60 * 1_000 };
  const t0 = Date.UTC(2026, 0, 15, 12, 0, 0);

  // Bogota, Plaza de Bolivar.
  const BOGOTA = { latitude: 4.5981, longitude: -74.0758 };

  /** Desplaza una latitud el numero de metros indicado (aprox, hacia el norte). */
  function north(latitude: number, meters: number): number {
    return latitude + meters / 111_320;
  }

  it("la primera coordenada de un dispositivo siempre se resuelve", () => {
    const gate = new GeocodeGate({ minMoveMeters: 100, refreshMs: 600_000 });
    const decision = gate.shouldResolve("dev-1", BOGOTA.latitude, BOGOTA.longitude, t0);

    expect(decision.shouldResolve).toBe(true);
    expect(decision.reason).toBe("first");
    expect(decision.distanceMeters).toBeNull();
  });

  it("un movimiento pequeno no vuelve a consultar la direccion", () => {
    const gate = new GeocodeGate({ minMoveMeters: 100, refreshMs: 600_000 });
    gate.shouldResolve("dev-1", BOGOTA.latitude, BOGOTA.longitude, t0);

    const decision = gate.shouldResolve(
      "dev-1",
      north(BOGOTA.latitude, 20),
      BOGOTA.longitude,
      t0 + 5_000,
    );

    expect(decision.shouldResolve).toBe(false);
    expect(decision.reason).toBe("unchanged");
    expect(decision.distanceMeters).toBeGreaterThan(15);
    expect(decision.distanceMeters).toBeLessThan(25);
  });

  it("un movimiento significativo si consulta la direccion", () => {
    const gate = new GeocodeGate({ minMoveMeters: 100, refreshMs: 600_000 });
    gate.shouldResolve("dev-1", BOGOTA.latitude, BOGOTA.longitude, t0);

    const decision = gate.shouldResolve(
      "dev-1",
      north(BOGOTA.latitude, 250),
      BOGOTA.longitude,
      t0 + 5_000,
    );

    expect(decision.shouldResolve).toBe(true);
    expect(decision.reason).toBe("moved");
    expect(decision.distanceMeters).toBeGreaterThan(240);
  });

  it("sin moverse, transcurrido el tiempo de refresco se reintenta", () => {
    const gate = new GeocodeGate({ minMoveMeters: 100, refreshMs: 600_000 });
    gate.shouldResolve("dev-1", BOGOTA.latitude, BOGOTA.longitude, t0);

    const decision = gate.shouldResolve(
      "dev-1",
      BOGOTA.latitude,
      BOGOTA.longitude,
      t0 + 600_000,
    );

    expect(decision.shouldResolve).toBe(true);
    expect(decision.reason).toBe("refresh");
  });

  it("el filtro es por dispositivo: el primero de cada uno se resuelve", () => {
    const gate = new GeocodeGate({ minMoveMeters: 100, refreshMs: 600_000 });
    gate.shouldResolve("dev-1", BOGOTA.latitude, BOGOTA.longitude, t0);

    expect(
      gate.shouldResolve("dev-2", BOGOTA.latitude, BOGOTA.longitude, t0).reason,
    ).toBe("first");
    expect(gate.size).toBe(2);

    gate.forget("dev-1");
    expect(gate.size).toBe(1);
    expect(
      gate.shouldResolve("dev-1", BOGOTA.latitude, BOGOTA.longitude, t0 + 1).reason,
    ).toBe("first");
  });

  it("un movimiento pequeno se acumula: dos saltos de 60 m ya cuentan como 120 m", () => {
    const gate = new GeocodeGate({ minMoveMeters: 100, refreshMs: 600_000 });
    gate.shouldResolve("dev-1", BOGOTA.latitude, BOGOTA.longitude, t0);

    const first = gate.shouldResolve(
      "dev-1",
      north(BOGOTA.latitude, 60),
      BOGOTA.longitude,
      t0 + 1_000,
    );
    expect(first.shouldResolve).toBe(false);

    const second = gate.shouldResolve(
      "dev-1",
      north(BOGOTA.latitude, 120),
      BOGOTA.longitude,
      t0 + 2_000,
    );
    // La referencia no se actualizo en el salto pequeno, asi que el acumulado
    // (120 m) supera el umbral.
    expect(second.shouldResolve).toBe(true);
    expect(second.reason).toBe("moved");
  });

  it("la distancia usa la formula del semiverseno", () => {
    // ~111,3 km por grado de latitud.
    expect(haversineMeters(0, 0, 1, 0)).toBeGreaterThan(110_000);
    expect(haversineMeters(0, 0, 1, 0)).toBeLessThan(112_000);
    // Mismo punto: distancia cero.
    expect(haversineMeters(4.5, -74, 4.5, -74)).toBe(0);
  });

  it("los valores por defecto de la politica son 100 m y 10 minutos", () => {
    expect(GEOCODE_GATE_DEFAULTS.minMoveMeters).toBe(100);
    expect(GEOCODE_GATE_DEFAULTS.refreshMinutes).toBe(10);
  });
});
