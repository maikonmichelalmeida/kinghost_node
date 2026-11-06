"use strict";
const { waypoint, navigation, validateOrder } = require("./google-navigation");
const D = require("./domain");
const failure = (message, status = 502) =>
  Object.assign(new Error(message), { status });
function createGoogle({ budget, fetchImpl = fetch }) {
  async function request(sku, id, input, url, options, keyName) {
    const key = process.env[keyName];
    if (!key)
      throw failure("Google Maps ainda não configurado no servidor.", 503);
    return budget.call(sku, id, input, async () => {
      try {
        const headers = { ...options.headers, "X-Goog-Api-Key": key };
        const response = await fetchImpl(url, {
          ...options,
          headers,
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok)
          throw failure(
            response.status === 429
              ? "O Google suspendeu consultas por limite de uso."
              : "Google Maps indisponível. O chamado permanece registrado.",
            response.status === 429 ? 429 : 502,
          );
        const result = await response.json();
        if (result.error)
          throw failure("O Google não conseguiu processar esta consulta.");
        return result;
      } catch (e) {
        if (e.status) throw e;
        throw failure(
          "Consulta sem resposta confirmada. Não será repetida automaticamente.",
        );
      }
    });
  }
  async function autocomplete(input, session, id) {
    const payload = {
      input,
      sessionToken: session,
      includedRegionCodes: ["br"],
      languageCode: "pt-BR",
      regionCode: "BR",
    };
    const r = await request(
      "autocomplete",
      id,
      payload,
      "https://places.googleapis.com/v1/places:autocomplete",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-FieldMask":
            "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text",
        },
        body: JSON.stringify(payload),
      },
      "GOOGLE_PLACES_API_KEY",
    );
    return (r.suggestions || []).flatMap((s) =>
      s.placePrediction
        ? [
            {
              placeId: s.placePrediction.placeId,
              label: s.placePrediction.text?.text || "",
            },
          ]
        : [],
    );
  }
  async function details(placeId, session, id) {
    const input = { placeId, session };
    const u = new URL(
      "https://places.googleapis.com/v1/places/" + encodeURIComponent(placeId),
    );
    u.searchParams.set("languageCode", "pt-BR");
    if (session) u.searchParams.set("sessionToken", session);
    const r = await request(
      "details",
      id,
      input,
      u,
      {
        headers: {
          "X-Goog-FieldMask": "id,formattedAddress,location,addressComponents",
        },
      },
      "GOOGLE_PLACES_API_KEY",
    );
    const number = (r.addressComponents || []).find((c) =>
      c.types?.includes("street_number"),
    )?.longText;
    if (!r.id || !r.location || !number)
      throw failure(
        "Inclua o número no endereço e escolha o resultado correspondente.",
        422,
      );
    return {
      placeId: r.id,
      lat: r.location.latitude,
      lon: r.location.longitude,
      address: r.formattedAddress,
      number,
    };
  }
  async function geocode(address, id) {
    // Geocoding is kept separate from optional typing and has its own quota/key restriction.
    const key = process.env.GOOGLE_GEOCODING_API_KEY;
    if (!key)
      throw failure(
        "Confirmação por texto indisponível. Você pode enviar o endereço escrito com preço manual.",
        503,
      );
    const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    u.searchParams.set("address", address);
    u.searchParams.set("components", "country:BR");
    u.searchParams.set("language", "pt-BR");
    u.searchParams.set("key", key);
    const r = await request(
      "geocode",
      id,
      { address },
      u,
      {},
      "GOOGLE_GEOCODING_API_KEY",
    );
    const p = r.results?.[0];
    if (r.status !== "OK" || !p || p.partial_match)
      throw failure(
        "Endereço não encontrado por completo. Confira rua, número e cidade.",
        422,
      );
    const number = p.address_components?.find((c) =>
      c.types?.includes("street_number"),
    )?.long_name;
    if (!number) throw failure("Informe o número do endereço.", 422);
    return {
      placeId: p.place_id,
      lat: p.geometry.location.lat,
      lon: p.geometry.location.lng,
      address: p.formatted_address,
      number,
    };
  }
  async function compute(
    origin,
    destination,
    intermediates,
    id,
    optimize = true,
  ) {
    const payload = {
      origin: waypoint(origin),
      destination: waypoint(destination),
      intermediates: intermediates.map(waypoint),
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE",
      computeAlternativeRoutes: false,
      languageCode: "pt-BR",
      units: "METRIC",
    };
    if (optimize && intermediates.length > 1)
      payload.optimizeWaypointOrder = true;
    const r = await request(
      "routes",
      id,
      payload,
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-FieldMask":
            "routes.duration,routes.distanceMeters,routes.optimizedIntermediateWaypointIndex",
        },
        body: JSON.stringify(payload),
      },
      "GOOGLE_ROUTES_API_KEY",
    );
    const route = r.routes?.[0];
    if (
      !route ||
      !Number.isFinite(route.distanceMeters) ||
      !/^\d+(\.\d+)?s$/.test(route.duration || "")
    )
      throw failure("Nenhuma rota válida foi encontrada.", 422);
    const order =
      intermediates.length <= 1
        ? intermediates.map((_, i) => i)
        : validateOrder(
            route.optimizedIntermediateWaypointIndex,
            intermediates.length,
          );
    return {
      order,
      meters: route.distanceMeters,
      seconds: parseFloat(route.duration),
    };
  }
  async function suggest(base, stop, id) {
    const r = await compute(base, stop, [], id, false);
    return { suggestedCents: D.price(r.meters), meters: r.meters };
  }
  async function optimize(base, stops, id, priority = -1) {
    const indices = stops.map((_, i) => i).filter((i) => i !== priority);
    if (indices.length < 2) {
      const order = priority < 0 ? indices : [priority, ...indices];
      return { order, quality: "fixed", links: navigation(stops, order, base) };
    }
    const origin = priority < 0 ? base : stops[priority],
      free = indices.map((i) => stops[i]);
    const section = await optimizeSection(origin, base, free, id);
    const order = [
      ...(priority < 0 ? [] : [priority]),
      ...section.order.map((i) => indices[i]),
    ];
    validateOrder(order, stops.length);
    return {
      order,
      quality: section.quality,
      links: navigation(stops, order, base),
    };
  }
  async function optimizeSection(origin, base, stops, id) {
    if (stops.length <= 25) {
      const r = await compute(origin, base, stops, id + ":0");
      return {
        ...r,
        quality: "google",
        links: navigation(stops, r.order, base),
      };
    }
    // Above Google's per-call capacity: geographic nearest-neighbor partition, then Google
    // optimizes each consecutive section. No claim of a global optimum across sections.
    let rest = stops.map((_, i) => i),
      current = origin,
      seed = [];
    while (rest.length) {
      rest.sort(
        (a, b) =>
          D.airDistance(current, stops[a]) - D.airDistance(current, stops[b]),
      );
      const i = rest.shift();
      seed.push(i);
      current = stops[i];
    }
    current = origin;
    const order = [];
    let meters = 0,
      seconds = 0,
      part = 0;
    while (seed.length) {
      const indices = seed.splice(0, 25),
        last = seed.length ? indices.pop() : null,
        destination = last === null ? base : stops[last];
      const r = await compute(
        current,
        destination,
        indices.map((i) => stops[i]),
        id + ":" + part++,
      );
      order.push(...r.order.map((i) => indices[i]));
      if (last !== null) order.push(last);
      current = destination;
      meters += r.meters;
      seconds += r.seconds;
    }
    validateOrder(order, stops.length);
    return {
      order,
      meters,
      seconds,
      quality: "partitioned",
      links: navigation(stops, order, base),
    };
  }
  return { autocomplete, details, geocode, suggest, optimize };
}
module.exports = { createGoogle };
