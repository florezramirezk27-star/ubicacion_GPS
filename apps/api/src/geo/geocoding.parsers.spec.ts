import { parseGoogle, parseNominatim } from "./geocoding.parsers";

const FETCHED_AT = "2026-10-16T12:00:00.000Z";

describe("parseNominatim", () => {
  it("extrae calle, numero, barrio y ciudad de una respuesta de Nominatim", () => {
    const payload = {
      place_id: 123,
      licence: "ODbL",
      display_name: "Calle 93 # 12-34, Chico Norte, Bogota, Colombia",
      address: {
        house_number: "12-34",
        road: "Calle 93",
        neighbourhood: "Chico Norte",
        city: "Bogota",
        state: "Bogota",
        postcode: "110221",
        country: "Colombia",
        country_code: "co",
      },
    };

    const address = parseNominatim(payload, FETCHED_AT);

    expect(address).not.toBeNull();
    expect(address).toMatchObject({
      formattedAddress: "Calle 93 # 12-34, Chico Norte, Bogota, Colombia",
      label: "Calle 93 12-34",
      street: "Calle 93",
      number: "12-34",
      neighborhood: "Chico Norte",
      city: "Bogota",
      region: "Bogota",
      country: "Colombia",
      postalCode: "110221",
      provider: "nominatim",
      fetchedAt: FETCHED_AT,
    });
  });

  it("cae a suburb/municipality cuando faltan neighbourhood/city", () => {
    const address = parseNominatim(
      {
        display_name: "Carrera 7, Colombia",
        address: {
          road: "Carrera 7",
          suburb: "La Candelaria",
          municipality: "Bogota",
        },
      },
      FETCHED_AT,
    );

    expect(address?.neighborhood).toBe("La Candelaria");
    expect(address?.city).toBe("Bogota");
    expect(address?.label).toBe("Carrera 7");
  });

  it("devuelve null cuando el proveedor reporta error", () => {
    expect(
      parseNominatim({ error: "Unable to geocode" }, FETCHED_AT),
    ).toBeNull();
  });

  it("devuelve null cuando no hay display_name ni calle", () => {
    expect(parseNominatim({ address: {} }, FETCHED_AT)).toBeNull();
    expect(parseNominatim(null, FETCHED_AT)).toBeNull();
    expect(parseNominatim("texto", FETCHED_AT)).toBeNull();
  });

  it("usa el display_name como etiqueta si no hay calle", () => {
    const address = parseNominatim(
      {
        display_name: "Bucaramanga, Santander, Colombia",
        address: { city: "Bucaramanga" },
      },
      FETCHED_AT,
    );
    expect(address?.label).toBeNull();
    expect(address?.city).toBe("Bucaramanga");
  });
});

describe("parseGoogle", () => {
  const okPayload = {
    status: "OK",
    results: [
      {
        formatted_address: "Cl. 93 #12-34, Bogota, Colombia",
        address_components: [
          { long_name: "Cl. 93", short_name: "Cl. 93", types: ["route"] },
          { long_name: "12-34", short_name: "12-34", types: ["street_number"] },
          {
            long_name: "Chico Norte",
            short_name: "Chico Norte",
            types: ["sublocality_level_1", "sublocality", "political"],
          },
          {
            long_name: "Bogota",
            short_name: "Bogota",
            types: ["locality", "political"],
          },
          {
            long_name: "Bogota",
            short_name: "DC",
            types: ["administrative_area_level_1", "political"],
          },
          {
            long_name: "Colombia",
            short_name: "CO",
            types: ["country", "political"],
          },
          { long_name: "110221", short_name: "110221", types: ["postal_code"] },
        ],
      },
    ],
  };

  it("extrae los componentes de Google", () => {
    const address = parseGoogle(okPayload, FETCHED_AT);

    expect(address).toMatchObject({
      formattedAddress: "Cl. 93 #12-34, Bogota, Colombia",
      label: "Cl. 93 12-34",
      street: "Cl. 93",
      number: "12-34",
      neighborhood: "Chico Norte",
      city: "Bogota",
      region: "Bogota",
      country: "Colombia",
      postalCode: "110221",
      provider: "google",
    });
  });

  it("devuelve null si el estado no es OK (sin resultados)", () => {
    expect(
      parseGoogle({ status: "ZERO_RESULTS", results: [] }, FETCHED_AT),
    ).toBeNull();
    expect(parseGoogle({ status: "REQUEST_DENIED" }, FETCHED_AT)).toBeNull();
  });

  it("devuelve null si no hay resultados", () => {
    expect(parseGoogle({ status: "OK", results: [] }, FETCHED_AT)).toBeNull();
    expect(parseGoogle(null, FETCHED_AT)).toBeNull();
  });
});
