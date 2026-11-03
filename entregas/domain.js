"use strict";
const ZONE = 'America/Sao_Paulo';
const BASE_ADDRESS = 'Rua Walmor M. Sousa, 547, Gravataí, RS';
function localDay(ms = Date.now()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const v = Object.fromEntries(p.map(x => [x.type, x.value]));
  return `${v.year}-${v.month}-${v.day}`;
}
function closing(ms = Date.now()) { return Date.parse(`${localDay(ms)}T20:30:00-03:00`); }
function price(meters) {
  if (!Number.isFinite(meters) || meters < 0) throw new Error('Distância inválida');
  if (meters <= 4000) return 700;
  if (meters <= 7000) return 1000;
  if (meters <= 10000) return 1500;
  return Math.floor((meters / 1000 * 2) / 5) * 500;
}
function availability(s, now = Date.now()) {
  return { open: Number(s.openUntil) > now,
    scheduledAt: Number(s.scheduledAt) > now ? Number(s.scheduledAt) : null };
}
function applySchedule(s, now = Date.now()) {
  if (s.scheduledAt && s.scheduledAt <= now) {
    s.openUntil = closing(s.scheduledAt) > now ? closing(s.scheduledAt) : 0;
    s.scheduledAt = null;
  }
  if (s.openUntil <= now) s.openUntil = 0;
  return s;
}
function optimize(matrix, count, priority = -1) {
  if (!Array.isArray(matrix) || matrix.length !== count + 1) throw new Error('Matriz inválida');
  for (let i = 0; i <= count; i++) for (let j = 0; j <= count; j++) {
    if (i === j) continue;
    const cell = matrix[i]?.[j];
    if (!cell || !Number.isFinite(cell.time) || cell.time < 0 || !Number.isFinite(cell.distance) || cell.distance < 0)
      throw new Error('Não foi encontrada uma rota entre todos os pontos. Confira os marcadores.');
  }
  let best = null;
  function visit(order, rest, time, distance, from) {
    if (!rest.length) {
      time += matrix[from][0].time; distance += matrix[from][0].distance;
      if (!best || time < best.seconds) best = { order, seconds: time, meters: distance };
      return;
    }
    for (const index of rest) {
      if (!order.length && priority >= 0 && index !== priority) continue;
      const cell = matrix[from][index + 1];
      visit([...order, index], rest.filter(x => x !== index), time + cell.time, distance + cell.distance, index + 1);
    }
  }
  visit([], Array.from({ length: count }, (_, i) => i), 0, 0, 0);
  return best;
}
function validPoint(p) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat >= -90 && p.lat <= 90 && p.lon >= -180 && p.lon <= 180;
}
function airDistance(a, b) {
  const r = Math.PI / 180;
  const h = Math.sin((b.lat-a.lat)*r/2)**2 + Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin((b.lon-a.lon)*r/2)**2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
module.exports = { ZONE, BASE_ADDRESS, localDay, closing, price, availability, applySchedule, optimize, validPoint, airDistance };
