"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { navigation, validateOrder } = require("./google-navigation");
const { allowance, periods } = require("./google-policy");
const { createGoogle } = require("./google-client");
const base = { lat: -29.939, lon: -51.051, address: "Casa 547, Gravataí" };
const stops = (n) =>
  Array.from({ length: n }, (_, i) => ({
    placeId: "p" + i,
    address: `Rua ${i}, ${i + 1}, Gravataí`,
    lat: -29.94 - i * 0.001,
    lon: -51.05,
  }));
for (const n of [1, 2, 3, 4, 5, 8, 26, 51])
  test(`links preservam ${n} entregas sem origem`, () => {
    const list = stops(n),
      order = list.map((_, i) => i).reverse(),
      links = navigation(list, order, base);
    assert.deepEqual(
      links.flatMap((l) => l.indices),
      order,
    );
    assert.equal(links.filter((l) => l.returnsHome).length, 1);
    assert.equal(links.at(-1).returnsHome, true);
    if (n <= 3) assert.equal(links.length, 1);
    for (const l of links) {
      const u = new URL(l.url);
      assert.equal(u.searchParams.has("origin"), false);
      assert.equal(u.searchParams.get("travelmode"), "driving");
      assert.ok((u.searchParams.get("waypoints") || "").split("|").length <= 3);
      assert.ok(l.url.length <= 2000);
    }
    assert.equal(
      new URL(links.at(-1).url).searchParams.get("destination"),
      base.address,
    );
  });
test("ordens inválidas não perdem destinos silenciosamente", () => {
  assert.throws(() => validateOrder([0, 0], 2));
  assert.throws(() => validateOrder([0], 2));
  assert.throws(() => validateOrder([0, 2], 2));
});
test("cotas adaptáveis preservam limites absolutos e reduzem ritmo excessivo", () => {
  const at = Date.parse("2026-11-15T15:00:00Z");
  const quiet = allowance("autocomplete", 100, 0, at),
    busy = allowance("autocomplete", 6000, 0, at);
  assert.ok(quiet.daily > busy.daily);
  assert.equal(allowance("routes", 0, 0, at).monthly, 2000);
  assert.ok(allowance("routes", 0, 0, at).daily <= 100);
  assert.equal(allowance("routes", 2000, 0, at).daily, 0);
  assert.equal(
    allowance("routes", 100, 20, at).daily,
    allowance("routes", 110, 30, at).daily,
  );
  assert.equal(periods(Date.parse("2026-12-01T07:00:00Z")).month, "2026-11");
});
test("Google otimiza DRIVE, ida e volta, sem Matrix; divide acima de 25", async () => {
  const original = process.env.GOOGLE_ROUTES_API_KEY;
  process.env.GOOGLE_ROUTES_API_KEY = "fake";
  let requests = [];
  const google = createGoogle({
    budget: { call: async (s, id, input, fn) => fn() },
    fetchImpl: async (url, options) => {
      assert.match(String(url), /directions\/v2:computeRoutes$/);
      const p = JSON.parse(options.body);
      requests.push(p);
      return {
        ok: true,
        json: async () => ({
          routes: [
            {
              distanceMeters: 4500,
              duration: "600s",
              optimizedIntermediateWaypointIndex: p.intermediates
                .map((_, i) => i)
                .reverse(),
            },
          ],
        }),
      };
    },
  });
  try {
    const r = await google.optimize(base, stops(3), "one");
    assert.deepEqual(r.order, [2, 1, 0]);
    assert.deepEqual(requests[0].origin, requests[0].destination);
    assert.equal(requests[0].travelMode, "DRIVE");
    assert.equal(requests[0].routingPreference, "TRAFFIC_AWARE");
    assert.equal(requests[0].optimizeWaypointOrder, true);
    requests = [];
    const large = await google.optimize(base, stops(51), "large");
    assert.equal(new Set(large.order).size, 51);
    assert.equal(large.quality, "partitioned");
    assert.ok(requests.every((p) => p.intermediates.length <= 25));
    assert.deepEqual(requests.at(-1).destination, requests[0].origin);
  } finally {
    process.env.GOOGLE_ROUTES_API_KEY = original || "";
  }
});
test("chave ausente bloqueia antes de reservar ou enviar", async () => {
  const old = process.env.GOOGLE_ROUTES_API_KEY;
  delete process.env.GOOGLE_ROUTES_API_KEY;
  try {
    const g = createGoogle({
      budget: { call: () => assert.fail("no reservation") },
      fetchImpl: () => assert.fail("no network"),
    });
    await assert.rejects(
      g.suggest(base, stops(1)[0], "x"),
      (e) => e.status === 503,
    );
  } finally {
    process.env.GOOGLE_ROUTES_API_KEY = old || "";
  }
});

test("sem escolha de sequência não chama Google; prioridade sai da otimização", async () => {
  const original = process.env.GOOGLE_ROUTES_API_KEY;
  process.env.GOOGLE_ROUTES_API_KEY = "mock";
  let requests = [];
  const g = createGoogle({
    budget: { call: async (s, id, input, fn) => fn() },
    fetchImpl: async (url, options) => {
      const p = JSON.parse(options.body);
      requests.push(p);
      return {
        ok: true,
        json: async () => ({
          routes: [
            {
              distanceMeters: 1000,
              duration: "300s",
              optimizedIntermediateWaypointIndex: p.intermediates
                .map((_, i) => i)
                .reverse(),
            },
          ],
        }),
      };
    },
  });
  try {
    assert.deepEqual((await g.optimize(base, stops(1), "one")).order, [0]);
    assert.deepEqual(
      (await g.optimize(base, stops(2), "fixed", 1)).order,
      [1, 0],
    );
    assert.equal(requests.length, 0);
    const ordered = await g.optimize(base, stops(4), "priority", 2);
    assert.deepEqual(ordered.order, [2, 3, 1, 0]);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].origin, { placeId: "p2" });
    assert.equal(
      requests[0].intermediates.some((p) => p.placeId === "p2"),
      false,
    );
    assert.deepEqual(requests[0].destination, {
      location: { latLng: { latitude: base.lat, longitude: base.lon } },
    });
  } finally {
    process.env.GOOGLE_ROUTES_API_KEY = original || "";
  }
});
test("trechos seguintes conservam os limites depois de cada baixa", () => {
  const { pendingNavigation } = require("./google-navigation");
  const l = stops(7),
    order = [4, 1, 0, 6, 3, 2, 5];
  const all = pendingNavigation(l, order, base, []);
  assert.equal(all.length, 2);
  const remaining = pendingNavigation(l, order, base, [{ index: 4 }]);
  assert.deepEqual(remaining[0].indices, [1, 0, 6]);
  assert.deepEqual(remaining[1].indices, all[1].indices);
  const second = pendingNavigation(
    l,
    order,
    base,
    order.slice(0, 4).map((index) => ({ index })),
  );
  assert.equal(second[0].segment, 2);
  assert.equal(second[0].returnsHome, true);
});
