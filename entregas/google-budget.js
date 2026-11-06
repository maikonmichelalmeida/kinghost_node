"use strict";
const crypto = require("crypto");
const fs = require("fs");
const { POLICIES, periods, allowance } = require("./google-policy");
const error = (status, message) =>
  Object.assign(new Error(message), { status });
const parse = (s) => (typeof s === "string" ? JSON.parse(s) : s);
function createBudget({
  openDb,
  now = Date.now,
  fetchImpl = fetch,
  monitorProvider,
}) {
  let syncing = false,
    accessToken = null;
  const db = async (fn) => {
    const c = await openDb();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  async function initialize() {
    await db(async (c) => {
      await c.query(
        `CREATE TABLE IF NOT EXISTS delivery_google_operations (operation_key CHAR(64) PRIMARY KEY, signature CHAR(64) NOT NULL, sku VARCHAR(20) NOT NULL, day_key CHAR(10) NOT NULL, month_key CHAR(7) NOT NULL, reserved_ms BIGINT NOT NULL, state VARCHAR(20) NOT NULL, result LONGTEXT NULL, INDEX(month_key,sku), INDEX(reserved_ms)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      await c.query(
        `CREATE TABLE IF NOT EXISTS delivery_google_monitor (id INT PRIMARY KEY,payload LONGTEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      );
      await c.execute(
        "INSERT IGNORE INTO delivery_google_monitor (id,payload) VALUES (1,?)",
        [
          JSON.stringify({
            lastSuccess: 0,
            lastAttempt: 0,
            reason: "Configure a consulta de métricas do Google Cloud.",
            baseline: {},
            counts: {},
          }),
        ],
      );
    });
  }
  async function totals(c, sku, p) {
    const [rows] = await c.execute(
      `SELECT COALESCE(SUM(month_key=?),0) AS monthCount,COALESCE(SUM(day_key=?),0) AS dayCount,COALESCE(SUM(reserved_ms>?),0) AS minuteCount FROM delivery_google_operations WHERE (month_key=? OR reserved_ms>?) AND sku=?`,
      [p.month, p.day, now() - 60000, p.month, now() - 60000, sku],
    );
    return {
      month: +rows[0].monthCount,
      day: +rows[0].dayCount,
      minute: +rows[0].minuteCount,
    };
  }
  function baseline(t, m, p, sku) {
    t.month += (m.month === p.month ? m.baseline?.[sku] : 0) || 0;
    t.day += (m.baselineDay === p.day ? m.dayBaseline?.[sku] : 0) || 0;
    return t;
  }
  async function summary() {
    return db(async (c) => {
      const [rows] = await c.query(
        "SELECT payload FROM delivery_google_monitor WHERE id=1",
      );
      const m = parse(rows[0].payload),
        p = periods(now()),
        usage = {};
      for (const sku of Object.keys(POLICIES)) {
        const t = await totals(c, sku, p);
        baseline(t, m, p, sku);
        usage[sku] = { ...t, ...allowance(sku, t.month, t.day, now()) };
      }
      return {
        monitor: {
          lastSuccess: m.lastSuccess,
          lastAttempt: m.lastAttempt,
          reason: m.reason || null,
          blocked:
            !m.lastSuccess ||
            now() - m.lastSuccess > 48 * 3600000 ||
            !!m.blocked,
        },
        usage,
      };
    });
  }
  async function call(sku, id, input, request) {
    const operationKey = crypto
      .createHash("sha256")
      .update(sku + ":" + id)
      .digest("hex");
    const signature = crypto
      .createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const reservation = await db(async (c) => {
      await c.beginTransaction();
      try {
        const [monitorRows] = await c.query(
          "SELECT payload FROM delivery_google_monitor WHERE id=1 FOR UPDATE",
        );
        const m = parse(monitorRows[0].payload);
        const [existing] = await c.execute(
          "SELECT * FROM delivery_google_operations WHERE operation_key=?",
          [operationKey],
        );
        if (existing.length) {
          const op = existing[0];
          if (op.signature !== signature)
            throw error(409, "Esta operação já foi usada com outro conteúdo.");
          if (
            op.state === "success" &&
            op.result &&
            now() - Number(op.reserved_ms) < 900000
          ) {
            await c.commit();
            return { duplicate: true, value: parse(op.result) };
          }
          throw error(
            409,
            op.state === "reserved"
              ? "Consulta em andamento. Aguarde."
              : "Consulta já registrada; não será repetida automaticamente.",
          );
        }
        if (!m.lastSuccess || now() - m.lastSuccess > 48 * 3600000 || m.blocked)
          throw error(
            503,
            "Consultas Google pausadas: verifique o monitoramento em Ajustes.",
          );
        const p = periods(now()),
          t = await totals(c, sku, p);
        baseline(t, m, p, sku);
        const a = allowance(sku, t.month, t.day, now());
        if (t.month >= a.monthly || t.day >= a.daily || t.minute >= a.minute)
          throw error(
            429,
            sku === "autocomplete"
              ? "Sugestões pausadas para preservar a franquia. Digite o endereço completo e toque em Confirmar."
              : "Limite de consultas atingido. O pedido pode ser enviado com endereço escrito e valor manual.",
          );
        // Stop optional typing first if essential daily budgets are close to exhaustion.
        if (sku === "autocomplete")
          for (const essential of ["routes", "details", "geocode"]) {
            const v = await totals(c, essential, p);
            baseline(v, m, p, essential);
            const limit = allowance(essential, v.month, v.day, now());
            if (v.day >= limit.daily * 0.65 || v.month >= limit.monthly * 0.85)
              throw error(
                429,
                "Sugestões pausadas. Digite o endereço completo e confirme.",
              );
          }
        await c.execute(
          "INSERT INTO delivery_google_operations (operation_key,signature,sku,day_key,month_key,reserved_ms,state) VALUES (?,?,?,?,?,?,?)",
          [operationKey, signature, sku, p.day, p.month, now(), "reserved"],
        );
        await c.commit();
        return { duplicate: false };
      } catch (e) {
        await c.rollback();
        throw e;
      }
    });
    if (reservation.duplicate) return reservation.value;
    try {
      const result = await request();
      await db((c) =>
        c.execute(
          "UPDATE delivery_google_operations SET state=?,result=? WHERE operation_key=?",
          ["success", JSON.stringify(result), operationKey],
        ),
      );
      return result;
    } catch (e) {
      await db((c) =>
        c.execute(
          "UPDATE delivery_google_operations SET state=? WHERE operation_key=?",
          ["uncertain", operationKey],
        ),
      ).catch(() => {});
      throw e;
    }
  }
  async function token() {
    if (accessToken && accessToken.expires > now() + 60000)
      return accessToken.value;
    const file = process.env.GOOGLE_MONITORING_CREDENTIALS;
    if (!file)
      throw new Error(
        "Falta credencial de leitura das métricas (Monitoring Viewer).",
      );
    const a = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!a.client_email || !a.private_key)
      throw new Error("Credencial de monitoramento inválida.");
    const encode = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
    const issued = Math.floor(now() / 1000);
    const unsigned =
      encode({ alg: "RS256", typ: "JWT" }) +
      "." +
      encode({
        iss: a.client_email,
        scope: "https://www.googleapis.com/auth/monitoring.read",
        aud: "https://oauth2.googleapis.com/token",
        iat: issued,
        exp: issued + 3600,
      });
    const assertion =
      unsigned +
      "." +
      crypto
        .sign("RSA-SHA256", Buffer.from(unsigned), a.private_key)
        .toString("base64url");
    const response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new Error("Não foi possível autenticar o monitoramento.");
    const b = await response.json();
    accessToken = {
      value: b.access_token,
      expires: now() + Number(b.expires_in) * 1000,
    };
    return accessToken.value;
  }
  async function readMetrics() {
    if (monitorProvider) return monitorProvider();
    const auth = await token(),
      p = periods(now()),
      counts = Object.fromEntries(Object.keys(POLICIES).map((s) => [s, 0]));
    const cutoff = now() - 3600000;
    const start = Date.parse(p.month + "-01T00:00:00Z");
    if (cutoff < start) return { counts, cutoff };
    const project = process.env.GOOGLE_CLOUD_PROJECT || "maikontech";
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(project))
      throw new Error("Projeto Google inválido.");
    const u = new URL(
      `https://monitoring.googleapis.com/v3/projects/${project}/timeSeries`,
    );
    u.searchParams.set(
      "filter",
      'metric.type="serviceruntime.googleapis.com/api/request_count" AND resource.type="consumed_api" AND (resource.labels.service="routes.googleapis.com" OR resource.labels.service="places.googleapis.com" OR resource.labels.service="geocoding-backend.googleapis.com")',
    );
    u.searchParams.set("interval.startTime", new Date(start).toISOString());
    u.searchParams.set("interval.endTime", new Date(cutoff).toISOString());
    u.searchParams.set("view", "FULL");
    u.searchParams.set("pageSize", "100000");
    let pages = 0;
    do {
      const response = await fetchImpl(u, {
        headers: { Authorization: "Bearer " + auth },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok)
        throw new Error("Métricas indisponíveis ou permissão insuficiente.");
      const body = await response.json();
      for (const series of body.timeSeries || []) {
        const method = series.resource?.labels?.method || "";
        const service = series.resource?.labels?.service || "";
        const sku = /Autocomplete/i.test(method)
          ? "autocomplete"
          : /GetPlace|PlaceDetails/i.test(method)
            ? "details"
            : /geocod/i.test(service + method)
              ? "geocode"
              : /ComputeRoutes/i.test(method)
                ? "routes"
                : null;
        if (!sku) {
          if (
            (series.points || []).some((p) => Number(p.value?.int64Value) > 0)
          )
            throw Object.assign(
              new Error("Consumo Google não reconhecido. Revisão necessária."),
              { unsafe: true },
            );
          continue;
        }
        for (const point of series.points || [])
          counts[sku] += Number(
            point.value?.int64Value || point.value?.doubleValue || 0,
          );
      }
      if (!body.nextPageToken) break;
      if (++pages >= 20)
        throw new Error("Métricas excederam o limite de leitura.");
      u.searchParams.set("pageToken", body.nextPageToken);
    } while (true);
    return { counts, cutoff };
  }
  async function sync(force = false) {
    if (syncing) return;
    syncing = true;
    try {
      const [rows] = await db((c) =>
        c.query("SELECT payload FROM delivery_google_monitor WHERE id=1"),
      );
      const previous = parse(rows[0].payload);
      if (!force && now() - previous.lastAttempt < 6 * 3600000) return;
      let result,
        failure,
        unsafe = false;
      try {
        result = await readMetrics();
      } catch (e) {
        failure = e.message;
        unsafe = !!e.unsafe;
      }
      await db(async (c) => {
        await c.beginTransaction();
        try {
          const [r] = await c.query(
            "SELECT payload FROM delivery_google_monitor WHERE id=1 FOR UPDATE",
          );
          const m = parse(r[0].payload);
          m.lastAttempt = now();
          if (failure) {
            m.reason = failure;
            if (unsafe) m.blocked = true;
          } else {
            const p = periods(now()),
              initial = m.month !== p.month || !m.lastSuccess;
            m.reason = null;
            m.blocked = false;
            if (initial) {
              m.baseline = {};
              m.dayBaseline = {};
              m.baselineDay = p.day;
            }
            for (const sku of Object.keys(POLICIES)) {
              const [local] = await c.execute(
                "SELECT COUNT(*) AS n FROM delivery_google_operations WHERE month_key=? AND sku=? AND reserved_ms<=?",
                [p.month, sku, result.cutoff],
              );
              const n = Number(local[0].n),
                external = result.counts[sku] || 0;
              if (initial) {
                m.baseline[sku] = Math.max(0, external - n);
                m.dayBaseline[sku] = m.baseline[sku];
              } else if (external > n + (m.baseline[sku] || 0) + 5) {
                m.blocked = true;
                m.reason =
                  "Consumo externo maior que o registrado. Consultas bloqueadas para revisão.";
              } else if (external > n + (m.baseline[sku] || 0)) {
                const extra = external - n - (m.baseline[sku] || 0);
                m.baseline[sku] = (m.baseline[sku] || 0) + extra;
                if (m.baselineDay !== p.day) {
                  m.baselineDay = p.day;
                  m.dayBaseline = {};
                }
                m.dayBaseline[sku] = (m.dayBaseline[sku] || 0) + extra;
              }
            }
            const [oldSuccess] = await c.execute(
              "SELECT COUNT(*) AS n FROM delivery_google_operations WHERE month_key=? AND state='success' AND reserved_ms<?",
              [p.month, now() - 48 * 3600000],
            );
            if (
              Number(oldSuccess[0].n) > 0 &&
              Object.values(result.counts).reduce((a, b) => a + b, 0) === 0
            ) {
              m.blocked = true;
              m.reason =
                "Métricas vazias apesar de consultas confirmadas há mais de 48 horas.";
            }
            m.lastSuccess = now();
            m.month = p.month;
            m.counts = result.counts;
            m.cutoff = result.cutoff;
          }
          await c.execute(
            "UPDATE delivery_google_monitor SET payload=? WHERE id=1",
            [JSON.stringify(m)],
          );
          await c.execute(
            "UPDATE delivery_google_operations SET result=NULL WHERE reserved_ms<?",
            [now() - 900000],
          );
          await c.commit();
        } catch (e) {
          await c.rollback();
          throw e;
        }
      });
    } finally {
      syncing = false;
    }
  }
  return { initialize, call, summary, sync };
}
module.exports = { createBudget };
