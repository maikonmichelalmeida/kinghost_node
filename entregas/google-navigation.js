"use strict";
function waypoint(p) {
  if (p.placeId) return { placeId: p.placeId };
  if (Number.isFinite(p.lat) && Number.isFinite(p.lon))
    return { location: { latLng: { latitude: p.lat, longitude: p.lon } } };
  return { address: p.address };
}
function target(p) {
  return p.placeId
    ? "place_id:" + p.placeId
    : Number.isFinite(p.lat) && Number.isFinite(p.lon)
      ? `${p.lat},${p.lon}`
      : p.address;
}
function navigation(stops, order, base, includeHome = true) {
  const points = order.map((index) => ({ point: stops[index], index }));
  if (includeHome) points.push({ point: base, index: null });
  const links = [];
  while (points.length) {
    let count = Math.min(4, points.length),
      url;
    while (count) {
      const slice = points.slice(0, count),
        last = slice.at(-1).point;
      url = new URL("https://www.google.com/maps/dir/");
      url.searchParams.set("api", "1");
      url.searchParams.set("travelmode", "driving");
      url.searchParams.set("dir_action", "navigate");
      url.searchParams.set("destination", last.address || target(last));
      if (last.placeId)
        url.searchParams.set("destination_place_id", last.placeId);
      const via = slice.slice(0, -1).map((x) => x.point);
      if (via.length) {
        url.searchParams.set(
          "waypoints",
          via.map((p) => p.address || target(p)).join("|"),
        );
        if (via.every((p) => p.placeId))
          url.searchParams.set(
            "waypoint_place_ids",
            via.map((p) => p.placeId).join("|"),
          );
      }
      if (url.href.length <= 2000) break;
      count--;
    }
    if (!count)
      throw new Error(
        "Endereço excede o tamanho permitido pelo link do Google Maps.",
      );
    const chunk = points.splice(0, count);
    links.push({
      url: url.href,
      indices: chunk.filter((p) => p.index !== null).map((p) => p.index),
      returnsHome: chunk.at(-1).index === null,
    });
  }
  return links;
}
function pendingNavigation(stops, order, base, delivered) {
  const chunks = navigation(stops, order, base),
    done = new Set(delivered.map((d) => d.index));
  return chunks.flatMap((chunk, i) =>
    navigation(
      stops,
      chunk.indices.filter((index) => !done.has(index)),
      base,
      chunk.returnsHome,
    ).map((link) => ({ ...link, segment: i + 1, segments: chunks.length })),
  );
}
function validateOrder(order, count) {
  if (
    !Array.isArray(order) ||
    order.length !== count ||
    new Set(order).size !== count ||
    order.some((x) => !Number.isInteger(x) || x < 0 || x >= count)
  )
    throw new Error("Google retornou uma sequência incompleta.");
  return order;
}
module.exports = { waypoint, navigation, pendingNavigation, validateOrder };
