"use strict";
const crypto = require("crypto");
const D = require("./domain");
const { deliveryPart } = require("./google-navigation");
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const parse = (value) =>
  typeof value === "string" ? JSON.parse(value) : value;
const uuid = (value) => /^[a-f0-9-]{36}$/i.test(String(value || ""));
function createWorkflow({
  db,
  transaction,
  storeOrder,
  google,
  budget,
  announceNewOrder = require("./voice-monkey").announceNewOrder,
  now = Date.now,
}) {
  async function initialize(c) {
    await c.query(
      `CREATE TABLE IF NOT EXISTS delivery_places (id CHAR(36) PRIMARY KEY,user_id INT NOT NULL,created_ms BIGINT NOT NULL,payload LONGTEXT NOT NULL,INDEX(created_ms)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    await c.query(
      `CREATE TABLE IF NOT EXISTS delivery_submissions (id CHAR(64) PRIMARY KEY,signature CHAR(64) NOT NULL,order_id CHAR(36) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
  }
  async function selection(c, id, userId) {
    const [rows] = await c.execute(
      "SELECT payload FROM delivery_places WHERE id=? AND user_id=? AND created_ms>?",
      [String(id || "").slice(0, 36), userId, now() - 86400000],
    );
    if (!rows.length) fail(409, "Confirme novamente o endereço.");
    return parse(rows[0].payload);
  }
  async function optimize(id, user) {
    const claimed = await transaction(async (c) => {
      const [rows] = await c.execute(
        "SELECT * FROM delivery_orders WHERE id=? FOR UPDATE",
        [id],
      );
      if (!rows.length) fail(404, "Pedido não encontrado.");
      if (user.role === "client" && rows[0].user_id !== user.id)
        fail(403, "Acesso não permitido.");
      const o = parse(rows[0].payload);
      if (o.stops.some(p => p.needsValidation)) fail(409, "Valide os endereços pendentes antes de calcular a rota.");
      if (
        o.routeStatus === "ready" ||
        ["running", "done", "cancelled"].includes(o.status)
      )
        return { order: o, skip: true };
      if (o.routeStatus === "calculating" && now() - o.routeStartedAt < 120000)
        return { order: o, skip: true };
      o.routeStatus = "calculating";
      o.routeStartedAt = now();
      o.routeAttempt = (o.routeAttempt || 0) + 1;
      await storeOrder(c, o);
      return { order: o };
    });
    if (claimed.skip) return decorate(claimed.order);
    const initial = claimed.order;
    let result, reason;
    try {
      result = await google.optimize(
        initial.base,
        initial.stops,
        initial.id + ":" + initial.routeAttempt,
        initial.priority ?? -1,
      );
    } catch (e) {
      reason = e.status
        ? e.message
        : "Cálculo indisponível. O pedido foi registrado.";
    }
    let estimate = null;
    if (result) {
      try { estimate = await google.estimateTrip(initial.base, initial.stops, result, initial.priority ?? -1, initial.id+':estimate:'+initial.routeAttempt); }
      catch { /* Navigation stays available when the estimate quota is exhausted. */ }
    }
    return transaction(async (c) => {
      const [rows] = await c.execute(
        "SELECT payload FROM delivery_orders WHERE id=? FOR UPDATE",
        [id],
      );
      const o = parse(rows[0].payload);
      if (["done","cancelled"].includes(o.status) || o.routeAttempt !== initial.routeAttempt) return decorate(o);
      if (result) {
        o.route = { order: result.order, quality: result.quality, estimate };
        o.routeStatus = "ready";
        o.routeError = null;
      } else {
        o.routeStatus = "pending";
        o.routeError = reason;
      }
      await storeOrder(c, o);
      return decorate(o);
    });
  }
  function decorate(o) {
    if (o.route?.order && o.base && !["done", "cancelled"].includes(o.status)) {
      const { links, ...part } = deliveryPart(o);
      o.part = part;
      o.navigation = links;
    }
    return o;
  }
  async function handle(route, b, u) {
    if (u.role === "client" && ["/autocomplete", "/resolve"].includes(route)) {
      const [rows] = await db((c) =>
        c.query("SELECT payload FROM delivery_settings WHERE id=1"),
      );
      const av = D.availability(
        D.applySchedule(parse(rows[0].payload), now()),
        now(),
      );
      if (!av.open && !av.scheduledAt)
        fail(409, "Atendimento fechado, sem horário programado.");
    }
    if (route === "/autocomplete") {
      if (
        typeof b.input !== "string" ||
        b.input.trim().length < 5 ||
        b.input.length > 300 ||
        !uuid(b.session) ||
        !uuid(b.operationId)
      )
        fail(400, "Informe rua, número e cidade.");
      return {
        suggestions: await google.autocomplete(
          b.input.trim(),
          b.session,
          u.id + ":" + b.operationId,
        ),
      };
    }
    if (route === "/resolve") {
      if (!uuid(b.operationId) || !uuid(b.session))
        fail(400, "Consulta inválida.");
      if (
        !b.placeId &&
        (typeof b.address !== "string" ||
          b.address.trim().length < 8 ||
          b.address.length > 300 ||
          !/[0-9]/.test(b.address))
      )
        fail(400, "Informe rua, número e cidade.");
      const p = b.placeId
        ? await google.details(
            String(b.placeId).slice(0, 300),
            b.session,
            u.id + ":" + b.operationId,
          )
        : await google.geocode(
            String(b.address || "").slice(0, 300),
            u.id + ":" + b.operationId,
          );
      const requested = String(b.address || "").match(
        /,\s*(\d+[a-z]?)\b/i,
      )?.[1];
      if (
        requested &&
        String(p.number).toLowerCase() !== requested.toLowerCase()
      )
        fail(
          422,
          "O número encontrado difere do número digitado. Confira o endereço.",
        );
      if (!D.validPoint(p))
        fail(422, "Localização inválida. Confira o endereço.");
      p.inputAddress = String(b.address || p.address)
        .trim()
        .slice(0, 300);
      const [rows] = await db((c) =>
        c.query("SELECT payload FROM delivery_settings WHERE id=1"),
      );
      const s = parse(rows[0].payload);
      if (b.base !== true) {
        try {
          Object.assign(
            p,
            await google.suggest(
              s.base || { address: s.baseAddress || D.BASE_ADDRESS },
              p,
              u.id + ":price:" + b.operationId,
            ),
          );
        } catch (e) {
          p.priceNotice = e.status ? e.message : "Informe o valor da entrega.";
        }
      }
      const selectionId = crypto.randomUUID();
      await db((c) =>
        c.execute(
          "INSERT INTO delivery_places (id,user_id,created_ms,payload) VALUES (?,?,?,?)",
          [selectionId, u.id, now(), JSON.stringify(p)],
        ),
      );
      return { ...p, selectionId };
    }
    if (route === "/google-base") {
      if (u.role !== "driver") fail(403, "Acesso não permitido.");
      await transaction(async (c, s) => {
        s.base = await selection(c, b.selectionId, u.id);
        s.baseAddress = s.base.address;
      });
      return { ok: true };
    }
    if (route === "/orders") {
      if (u.role !== "client") fail(403, "Acesso não permitido.");
      if (!uuid(b.submissionId) || !Array.isArray(b.stops) || !b.stops.length)
        fail(400, "Adicione ao menos um endereço.");
      const key = crypto
        .createHash("sha256")
        .update(u.id + ":" + b.submissionId)
        .digest("hex");
      const priority = b.priority ?? -1;
      const firstMessage = b.firstMessage ?? "";
      if (typeof firstMessage !== "string" || firstMessage.trim().length > 1000)
        fail(400, "A primeira mensagem deve ter até 1.000 caracteres.");
      const message = firstMessage.trim();
      if (
        !Number.isInteger(priority) ||
        priority < -1 ||
        priority >= b.stops.length ||
        (priority >= 0 && b.stops.length < 2)
      )
        fail(400, "Prioridade inválida.");
      const signature = crypto
        .createHash("sha256")
        .update(JSON.stringify(message ? [b.stops, priority, message] : [b.stops, priority]))
        .digest("hex");
      const saved = await transaction(async (c, s) => {
        const [existing] = await c.execute(
          "SELECT * FROM delivery_submissions WHERE id=?",
          [key],
        );
        if (existing.length) {
          if (existing[0].signature !== signature)
            fail(409, "Pedido já enviado com outro conteúdo.");
          return { id: existing[0].order_id, duplicate: true };
        }
        const av = D.availability(s, now());
        if (!av.open && !av.scheduledAt)
          fail(409, "Maikon está ocupado, sem abertura programada.");
        const base = s.base || { address: s.baseAddress || D.BASE_ADDRESS };
        const stops = [];
        for (const input of b.stops) {
          if (
            input.selectionId && (!Number.isInteger(input.priceCents) ||
            input.priceCents < 0 ||
            input.priceCents > 100000)
          )
            fail(400, "Informe um valor entre R$ 0 e R$ 1.000 por entrega.");
          let p;
          if (input.selectionId)
            p = await selection(c, input.selectionId, u.id);
          else {
            const address = String(input.address || "").trim();
            if (!address || address.length > 300 || input.allowUnresolved !== true)
              fail(400, "Confirme Enviar mesmo assim para incluir um endereço pendente.");
            p = { address, inputAddress: address, needsValidation: true };
          }
          if (
            D.validPoint(base) &&
            D.validPoint(p) &&
            D.airDistance(base, p) > 100000
          )
            fail(400, "Endereço a mais de 100 km. Confira a cidade.");
          stops.push({ ...p, priceCents: p.needsValidation ? null : input.priceCents });
        }
        const o = {
          id: crypto.randomUUID(),
          day: D.localDay(now()),
          base,
          priority,
          stops,
          totalCents: stops.reduce((n, p) => n + p.priceCents, 0),
          createdAt: now(),
          status: av.open ? "accepted" : "scheduled",
          acceptedAt: av.open ? now() : null,
          scheduledFor: av.open ? null : av.scheduledAt,
          seenAt: null,
          startedAt: null,
          finishedAt: null,
          delayUntil: null,
          delivered: [],
          route: null,
          routeStatus: stops.some(p => p.needsValidation) ? "awaiting_address" : b.backgroundRoute === true ? "queued" : "pending",
        };
        await c.execute(
          "INSERT INTO delivery_orders (id,user_id,day_key,status,created_ms,payload) VALUES (?,?,?,?,?,?)",
          [o.id, u.id, o.day, o.status, o.createdAt, JSON.stringify(o)],
        );
        await c.execute(
          "INSERT INTO delivery_submissions (id,signature,order_id) VALUES (?,?,?)",
          [key, signature, o.id],
        );
        if (message) {
          await c.execute(
            "INSERT INTO delivery_messages (order_id,user_id,message_key,sender,message,sent_ms) VALUES (?,?,?,?,?,?)",
            [o.id, u.id, b.submissionId, "farmacia", message, o.createdAt],
          );
        }
        return { id: o.id, order: o, alertUntil: av.open ? s.openUntil : 0 };
      });
      // A retry of the HTTP submission never creates another billable optimization.
      if (saved.duplicate) {
        const [rows] = await db((c) =>
          c.execute("SELECT payload FROM delivery_orders WHERE id=?", [
            saved.id,
          ]),
        );
        return decorate(parse(rows[0].payload));
      }
      if (saved.alertUntil > now()) {
        void announceNewOrder().catch(() => {
          console.warn("Entregas: aviso de voz sem confirmação para", saved.id);
        });
      }
      if (saved.order.routeStatus === "awaiting_address") return saved.order;
      if (b.backgroundRoute === true) {
        void optimize(saved.id, u).catch(() => console.warn("Entregas: cálculo interrompido para", saved.id));
        return saved.order;
      }
      return optimize(saved.id, u);
    }
    const estimateRequest=route.match(/^\/orders\/([a-f0-9-]{36})\/estimate$/);
    if(estimateRequest){
      if(u.role!=='driver')fail(403,'Acesso não permitido.');
      const id=estimateRequest[1];
      const [rows]=await db(c=>c.execute('SELECT payload FROM delivery_orders WHERE id=?',[id]));
      const order=rows[0] && parse(rows[0].payload);
      if(!order?.route || ['done','cancelled'].includes(order.status))fail(409,'Rota indisponível.');
      if(order.route.estimate)return order.route.estimate;
      const estimate=await google.estimateTrip(order.base,order.stops,order.route,order.priority??-1,id+':estimate-request:'+new Date(now()).toISOString().slice(0,10));
      await transaction(async c=>{
        const [current]=await c.execute('SELECT payload FROM delivery_orders WHERE id=? FOR UPDATE',[id]);
        const o=current[0] && parse(current[0].payload);
        if(!o?.route || ['done','cancelled'].includes(o.status))return;
        o.route.estimate=estimate;await storeOrder(c,o);
      });return estimate;
    }
    const correction = route.match(/^\/orders\/([a-f0-9-]{36})\/correct$/);
    if (correction) {
      if (u.role !== 'driver') fail(403, 'Somente o entregador pode validar o endereço.');
      const id = correction[1];
      const order = await transaction(async c => {
        const [rows] = await c.execute('SELECT payload FROM delivery_orders WHERE id=? FOR UPDATE', [id]);
        if (!rows.length) fail(404, 'Pedido não encontrado.');
        const o = parse(rows[0].payload);
        if (!['accepted','seen','scheduled'].includes(o.status)) fail(409, 'Pedido já iniciado ou encerrado.');
        const stop = Number.isInteger(b.index) && o.stops[b.index];
        if (!stop?.needsValidation) fail(409, 'Este endereço já foi validado. Atualize o pedido.');
        const place = await selection(c, b.selectionId, u.id);
        if (!D.validPoint(place) || !place.number || (D.validPoint(o.base) && D.airDistance(o.base,place)>100000)) fail(422, 'Confira o número e a cidade do endereço corrigido.');
        if (!Number.isInteger(b.priceCents) || b.priceCents<0 || b.priceCents>100000) fail(400,'Informe um valor entre R$ 0 e R$ 1.000.');
        o.stops[b.index] = {...place, originalAddress:stop.address, inputAddress:place.address, priceCents:b.priceCents};
        o.totalCents = o.stops.reduce((total,p)=>total+(p.priceCents ?? 0),0);
        o.routeStatus = o.stops.some(p=>p.needsValidation) ? 'awaiting_address' : 'queued';
        await storeOrder(c,o);
        return o;
      });
      if (order.routeStatus === 'queued') void optimize(id,u).catch(()=>console.warn('Entregas: cálculo interrompido para',id));
      return order;
    }
    const retry = route.match(/^\/orders\/([a-f0-9-]{36})\/route$/);
    if (retry) return optimize(retry[1], u);
    return null;
  }
  return { initialize, handle, decorate };
}
module.exports = { createWorkflow };
