"use strict";
// All limits are local safety ceilings. Official Cloud quotas are never changed.
const POLICIES = Object.freeze({
  routes: { month: 2000, free: 5000, day: 100, minute: 20, burst: 2 },
  autocomplete: { month: 7000, free: 10000, day: 400, minute: 40, burst: 1.4 },
  details: { month: 7000, free: 10000, day: 160, minute: 20, burst: 2 },
  geocode: { month: 7000, free: 10000, day: 100, minute: 15, burst: 2 },
});
function periods(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  const days = new Date(Date.UTC(+p.year, +p.month, 0)).getUTCDate();
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    month: `${p.year}-${p.month}`,
    dayNumber: +p.day,
    days,
    remainingDays: days - +p.day + 1,
  };
}
function allowance(sku, monthUsed, todayUsed, ms) {
  const p = POLICIES[sku];
  if (!p) throw new Error("Operação inválida");
  const cal = periods(ms),
    monthly = Math.min(p.month, Math.floor(p.free * 0.7));
  // Recomputed from usage BEFORE today: the day's own calls cannot increase its allowance.
  const before = Math.max(0, monthUsed - todayUsed),
    remaining = Math.max(0, monthly - before);
  const target = monthly / cal.days,
    average = remaining / cal.remainingDays;
  const ahead = before > target * (cal.dayNumber - 1) + target;
  const factor = ahead ? (sku === "autocomplete" ? 0.65 : 1) : p.burst;
  const daily = Math.min(
    p.day,
    remaining,
    Math.max(0, Math.floor(average * factor)),
  );
  return {
    monthly,
    daily,
    minute: p.minute,
    remaining: Math.max(0, monthly - monthUsed),
    todayRemaining: Math.max(
      0,
      Math.min(daily - todayUsed, monthly - monthUsed),
    ),
    ahead,
  };
}
module.exports = { POLICIES, periods, allowance };
