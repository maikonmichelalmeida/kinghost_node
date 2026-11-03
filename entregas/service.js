"use strict";
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const D = require('./domain');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
const text = (s, max = 300) => String(s ?? '').trim().slice(0, max);
const terminal = o => ['done', 'cancelled'].includes(o.status);
function createService({ openDb, fetchImpl = fetch, now = Date.now, seedFile = path.join(__dirname, 'accounts.local.json') }) {
  let initPromise;
  let timer;
  const limits = new Map();
  const tileCache = new Map();
  let providerQueue = Promise.resolve();
  async function db(fn) { const c = await openDb(); try { return await fn(c); } finally { await c.end(); } }
  async function initialize() {
    if (initPromise) return initPromise;
    initPromise = db(async c => {
      const tables = [
        `CREATE TABLE IF NOT EXISTS delivery_users (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(50) NOT NULL UNIQUE, role VARCHAR(15) NOT NULL, password_hash VARCHAR(200) NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS delivery_sessions (token_hash CHAR(64) PRIMARY KEY, user_id INT NOT NULL, expires_ms BIGINT NOT NULL, INDEX(expires_ms))`,
        `CREATE TABLE IF NOT EXISTS delivery_settings (id INT PRIMARY KEY, payload LONGTEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS delivery_orders (id CHAR(36) PRIMARY KEY, user_id INT NOT NULL, day_key CHAR(10) NOT NULL, status VARCHAR(20) NOT NULL, created_ms BIGINT NOT NULL, payload LONGTEXT NOT NULL, INDEX(day_key), INDEX(status))`,
        `CREATE TABLE IF NOT EXISTS delivery_quotes (id CHAR(36) PRIMARY KEY, user_id INT NOT NULL, expires_ms BIGINT NOT NULL, payload LONGTEXT NOT NULL, order_id CHAR(36) NULL, INDEX(expires_ms))`,
        `CREATE TABLE IF NOT EXISTS delivery_history (order_id CHAR(36) PRIMARY KEY, day_key CHAR(10) NOT NULL, archived_ms BIGINT NOT NULL, payload LONGTEXT NOT NULL, INDEX(day_key))`,
        `CREATE TABLE IF NOT EXISTS delivery_usage (day_key CHAR(10) PRIMARY KEY, units INT NOT NULL DEFAULT 0)`
      ];
      for (const sql of tables) await c.query(`${sql} ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await c.execute('INSERT IGNORE INTO delivery_settings (id,payload) VALUES (1,?)', [JSON.stringify({ base: null, baseAddress: D.BASE_ADDRESS, openUntil: 0, scheduledAt: null })]);
      if (fs.existsSync(seedFile)) {
        const seeds = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
        for (const u of seeds) await c.execute('INSERT IGNORE INTO delivery_users (username,role,password_hash) VALUES (?,?,?)', [u.username, u.role, u.passwordHash]);
      }
    }).catch(e => { initPromise = null; throw e; });
    return initPromise;
  }
  async function settings(c, lock = false) {
    const [rows] = await c.query(`SELECT payload FROM delivery_settings WHERE id=1${lock ? ' FOR UPDATE' : ''}`);
    return D.applySchedule(json(rows[0].payload), now());
  }
  async function saveSettings(c, s) { await c.execute('UPDATE delivery_settings SET payload=? WHERE id=1', [JSON.stringify(s)]); }
  async function transaction(fn) {
    return db(async c => {
      await c.beginTransaction();
      try { const s = await settings(c, true); const result = await fn(c, s); await saveSettings(c, s); await c.commit(); return result; }
      catch (e) { await c.rollback(); throw e; }
    });
  }
  async function storeOrder(c, o) {
    await c.execute('UPDATE delivery_orders SET status=?,payload=? WHERE id=?', [o.status, JSON.stringify(o), o.id]);
    await c.execute('UPDATE delivery_history SET payload=?,archived_ms=? WHERE order_id=?', [JSON.stringify(o), now(), o.id]);
  }
  async function maintain() {
    await initialize();
    await transaction(async (c, s) => {
      const [rows] = await c.query("SELECT payload FROM delivery_orders WHERE status='scheduled'");
      for (const row of rows) {
        const o = json(row.payload);
        if (o.scheduledFor <= now() && D.availability(s, now()).open) {
          o.status = 'accepted'; o.acceptedAt = now(); await storeOrder(c, o);
        }
      }
      const day = D.localDay(now());
      const late = now() >= Date.parse(`${day}T23:55:00-03:00`);
      await c.execute(`INSERT INTO delivery_history (order_id,day_key,archived_ms,payload)
        SELECT id,day_key,?,payload FROM delivery_orders WHERE day_key ${late ? '<=' : '<'} ?
        ON DUPLICATE KEY UPDATE payload=VALUES(payload),archived_ms=VALUES(archived_ms)`, [now(), day]);
      await c.execute('DELETE FROM delivery_sessions WHERE expires_ms < ?', [now()]);
      await c.execute('DELETE FROM delivery_quotes WHERE expires_ms < ? AND order_id IS NULL', [now() - 86400000]);
    });
  }
  function start() {
    maintain().catch(e => console.error('Entregas: inicialização pendente:', e.code || e.message));
    timer = setInterval(() => maintain().catch(e => console.error('Entregas: manutenção falhou:', e.code || e.message)), 60000);
    timer.unref();
  }
  function throttle(key, max, ms) {
    const time = now();
    if (limits.size > 10000) for (const [k, v] of limits) if (v.until < time) limits.delete(k);
    let v = limits.get(key);
    if (!v || v.until < time) { v = { count: 0, until: time + ms }; limits.set(key, v); }
    if (++v.count > max) fail(429, 'Muitas tentativas. Aguarde alguns minutos.');
  }
  async function body(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'Envie JSON.');
    let data = ''; let length = 0;
    for await (const chunk of req) { length += chunk.length; if (length > 32768) fail(413, 'Pedido muito grande.'); data += chunk.toString(); }
    try { return JSON.parse(data || '{}'); } catch { fail(400, 'JSON inválido.'); }
  }
  async function auth(req) {
    const raw = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (!/^[a-f0-9]{64}$/.test(raw)) fail(401, 'Entre novamente.');
    const rows = await db(async c => (await c.execute(`SELECT u.id,u.username,u.role FROM delivery_sessions s JOIN delivery_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_ms>?`, [hash(raw), now()]))[0]);
    if (!rows.length) fail(401, 'Sessão expirada. Entre novamente.');
    return { ...rows[0], sessionHash: hash(raw) };
  }
  function requireRole(u, role) { if (u.role !== role) fail(403, 'Acesso não permitido.'); }
  async function reserveCredits(credits) {
    // UTC window matches provider accounting; conservative headroom below free quota.
    const day = new Date(now()).toISOString().slice(0, 10);
    const cap = Math.min(2800, Number(process.env.GEOAPIFY_DAILY_LIMIT || 2500));
    await db(async c => {
      await c.execute('INSERT IGNORE INTO delivery_usage (day_key,units) VALUES (?,0)', [day]);
      const [r] = await c.execute('UPDATE delivery_usage SET units=units+? WHERE day_key=? AND units+?<=?', [Math.ceil(credits*4), day, Math.ceil(credits*4), cap*4]);
      if (!r.affectedRows) fail(429, 'Limite diário de mapas atingido. Tente novamente amanhã.');
    });
  }
  async function provider(endpoint, params, credits, data, binary = false) {
    const key = process.env.GEOAPIFY_API_KEY;
    if (!key) fail(503, 'Mapas ainda não configurados. Falta cadastrar a chave gratuita do Geoapify no servidor.');
    await reserveCredits(credits);
    const run = async () => {
      const url = new URL(endpoint, 'https://api.geoapify.com');
      for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
      url.searchParams.set('apiKey', key);
      try {
        const response = await fetchImpl(url, { method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(20000) });
        if (!response.ok) fail(502, 'Serviço de mapas indisponível. Tente novamente em instantes.');
        return binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
      } catch (e) { if (e.status) throw e; fail(502, 'Não foi possível consultar o mapa. Tente novamente.'); }
      finally { await new Promise(resolve => setTimeout(resolve, 230)); }
    };
    const result = providerQueue.then(run, run);
    providerQueue = result.catch(() => {});
    return result;
  }
  async function snapshot(u) {
    await maintain();
    return db(async c => {
      const s = await settings(c);
      const [rows] = await c.execute(`SELECT payload FROM delivery_orders WHERE (day_key=? OR status NOT IN ('done','cancelled')) ${u.role === 'client' ? 'AND user_id=?' : ''} ORDER BY created_ms DESC`, u.role === 'client' ? [D.localDay(now()), u.id] : [D.localDay(now())]);
      const orders = rows.map(r => json(r.payload));
      const [usage] = await c.execute('SELECT units FROM delivery_usage WHERE day_key=?', [new Date(now()).toISOString().slice(0,10)]);
      return { user: { username: u.username, role: u.role }, settings: s, availability: D.availability(s, now()), orders,
        day: D.localDay(now()), serverTime: now(), mapsReady: Boolean(process.env.GEOAPIFY_API_KEY),
        credits: u.role === 'driver' ? (usage[0]?.units || 0) / 4 : undefined,
        totalCents: orders.filter(o => o.day === D.localDay(now()) && o.status !== 'cancelled').reduce((n,o) => n+o.totalCents,0) };
    });
  }
  function validateStops(stops, base) {
    if (!Array.isArray(stops) || stops.length < 1 || stops.length > 5) fail(400, 'Informe de 1 a 5 entregas.');
    return stops.map(p => {
      if (!D.validPoint(p) || p.confirmed !== true || !text(p.address) || !text(p.number, 20)) fail(400, 'Confirme o ponto e informe endereço e número de cada entrega.');
      if (D.airDistance(base, p) > 100000) fail(400, 'O ponto fica a mais de 100 km da base. Confira o endereço.');
      return { lat: p.lat, lon: p.lon, address: text(p.address), number: text(p.number,20), complement: text(p.complement,120), note: text(p.note,1000), confirmed: true };
    });
  }
  async function handle(req, res, url) {
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    try {
      await initialize();
      const route = url.pathname.slice('/api/entregas'.length);
      if (route === '/login' && req.method === 'POST') {
        const b = await body(req);
        throttle('login-ip:'+req.socket.remoteAddress, 30, 900000);
        throttle('login-user:'+text(b.username,50).toLowerCase(), 12, 900000);
        const [u] = await db(async c => (await c.execute('SELECT * FROM delivery_users WHERE username=?', [text(b.username,50)]))[0]);
        const [salt, expected] = (u?.password_hash || '0000000000000000:'+'0'.repeat(128)).split(':');
        const actual = await scrypt(String(b.password || '').slice(0,200), salt, 64);
        if (!u || !expected || !crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'))) fail(401, 'Usuário ou senha incorretos.');
        const token = crypto.randomBytes(32).toString('hex'); const expiresAt = now()+30*86400000;
        await db(c => c.execute('INSERT INTO delivery_sessions (token_hash,user_id,expires_ms) VALUES (?,?,?)', [hash(token), u.id, expiresAt]));
        reply(200, { token, expiresAt, role: u.role }); return;
      }
      const u = await auth(req);
      if (route === '/logout' && req.method === 'POST') { await db(c => c.execute('DELETE FROM delivery_sessions WHERE token_hash=?', [u.sessionHash])); reply(200, { ok: true }); return; }
      if (route === '/state' && req.method === 'GET') { reply(200, await snapshot(u)); return; }
      if (route === '/search' && req.method === 'GET') {
        throttle('search:'+u.id, 40, 60000);
        const q = text(url.searchParams.get('q'));
        if (q.length < 5) fail(400, 'Informe rua, número e cidade.');
        const data = await provider('/v1/geocode/search', { text: q, filter: 'countrycode:br', lang: 'pt', limit: '5', format: 'json' }, 1);
        reply(200, { results: (data.results || []).map(p => ({ lat:p.lat, lon:p.lon, address:p.formatted, number:p.housenumber || '', exact: p.result_type === 'building', confidence:p.rank?.confidence })) }); return;
      }
      const tile = route.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)$/);
      if (tile && req.method === 'GET') {
        const [z,x,y] = tile.slice(1).map(Number);
        if (z<0 || z>20 || x<0 || y<0 || x>=2**z || y>=2**z) fail(400,'Mapa inválido.');
        const cacheKey = `${z}/${x}/${y}`;
        let buffer = tileCache.get(cacheKey);
        if (!buffer) {
          throttle('tiles:'+u.id, 250, 60000);
          buffer = await provider(`/v1/tile/osm-carto/${cacheKey}.png`, {}, 0.25, null, true);
          if (tileCache.size >= 500) tileCache.delete(tileCache.keys().next().value);
          tileCache.set(cacheKey, buffer);
        }
        res.writeHead(200, { 'Content-Type':'image/png', 'Cache-Control':'private, max-age=86400' }); res.end(buffer); return;
      }
      if (route === '/availability' && req.method === 'POST') {
        requireRole(u, 'driver'); const b = await body(req);
        await transaction(async (c,s) => {
          if (b.action === 'open') { if (now() >= D.closing(now())) fail(400, 'Hoje o atendimento encerrou às 20h30. Agende a próxima abertura.'); s.openUntil=D.closing(now()); s.scheduledAt=null; }
          else if (b.action === 'close') { s.openUntil=0; }
          else if (b.action === 'schedule') {
            const time = Date.parse(b.at);
            if (!Number.isFinite(time) || time <= now() || time >= D.closing(time) || time > now()+30*86400000) fail(400,'Escolha uma abertura futura antes das 20h30, em até 30 dias.');
            s.scheduledAt=time;
          } else if (b.action === 'unschedule') {
            const [rows] = await c.query("SELECT id FROM delivery_orders WHERE status='scheduled' LIMIT 1");
            if (rows.length) fail(409,'Há encomendas para esse horário. Cancele-as antes de remover o agendamento.');
            s.scheduledAt=null;
          } else fail(400,'Ação inválida.');
          if (b.action === 'schedule') {
            const [rows] = await c.query("SELECT payload FROM delivery_orders WHERE status='scheduled'");
            for (const row of rows) { const o=json(row.payload); o.scheduledFor=s.scheduledAt; await storeOrder(c,o); }
          }
        }); reply(200, await snapshot(u)); return;
      }
      if (route === '/base' && req.method === 'POST') {
        requireRole(u,'driver'); const b=await body(req);
        if (!D.validPoint(b) || b.confirmed !== true) fail(400,'Confirme o ponto da farmácia/casa.');
        await transaction(async(c,s)=>{ s.base={lat:b.lat,lon:b.lon}; });
        reply(200, await snapshot(u)); return;
      }
      if (route === '/configuration' && req.method === 'POST') {
        requireRole(u,'driver'); const b=await body(req); const key=text(b.key,128);
        if(!/^[A-Za-z0-9_-]{20,128}$/.test(key))fail(400,'Chave inválida. Copie a chave do projeto Geoapify.');
        const envFile=path.join(__dirname,'..','config.local.env');
        let content=fs.existsSync(envFile)?fs.readFileSync(envFile,'utf8'):'';
        const line=`GEOAPIFY_API_KEY=${key}`;
        content=/^GEOAPIFY_API_KEY=.*$/m.test(content)?content.replace(/^GEOAPIFY_API_KEY=.*$/m,line):content+'\n'+line+'\n';
        const temporary=envFile+'.tmp';fs.writeFileSync(temporary,content,{mode:0o600});fs.renameSync(temporary,envFile);
        process.env.GEOAPIFY_API_KEY=key;
        reply(200,{ok:true});return;
      }
      if (route === '/quote' && req.method === 'POST') {
        requireRole(u,'client'); throttle('quote:'+u.id,12,60000);
        await maintain(); const b=await body(req); const s=await db(c=>settings(c)); const av=D.availability(s,now());
        if (!av.open && !av.scheduledAt) fail(409,'Maikon está ocupado, sem previsão de abertura.');
        if (!D.validPoint(s.base)) fail(503,'Maikon precisa confirmar o ponto da farmácia/casa antes do primeiro pedido.');
        const stops=validateStops(b.stops,s.base); const priority=Number(b.priority ?? -1);
        if (!Number.isInteger(priority) || priority < -1 || priority >= stops.length) fail(400,'Prioridade inválida.');
        const points=[s.base,...stops].map(p=>({location:[p.lon,p.lat]}));
        const result=await provider('/v1/routematrix',{},points.length**2,{mode:'drive',sources:points,targets:points,units:'metric',traffic:'approximated'});
        let routeData;
        try { routeData=D.optimize(result.sources_to_targets,stops.length,priority); } catch(e) { fail(422,e.message); }
        stops.forEach((p,i)=>{p.meters=result.sources_to_targets[0][i+1].distance;p.priceCents=D.price(p.meters);p.suggestedCents=p.priceCents;});
        const q={ id:crypto.randomUUID(), base:s.base, stops, priority, route:routeData, totalCents:stops.reduce((n,p)=>n+p.priceCents,0), expiresAt:now()+15*60000 };
        await db(c=>c.execute('INSERT INTO delivery_quotes (id,user_id,expires_ms,payload) VALUES (?,?,?,?)',[q.id,u.id,q.expiresAt,JSON.stringify(q)]));
        reply(200,q); return;
      }
      if (route === '/orders' && req.method === 'POST') {
        requireRole(u,'client'); const b=await body(req);
        const order=await transaction(async(c,s)=>{
          const [rows]=await c.execute('SELECT * FROM delivery_quotes WHERE id=? AND user_id=? FOR UPDATE',[text(b.quoteId,36),u.id]);
          const row=rows[0]; if(!row) fail(404,'Cotação não encontrada.');
          if(row.order_id) { const [existing]=await c.execute('SELECT payload FROM delivery_orders WHERE id=?',[row.order_id]); return json(existing[0].payload); }
          if(Number(row.expires_ms)<=now()) fail(409,'A cotação expirou. Calcule novamente.');
          const av=D.availability(s,now()); if(!av.open&&!av.scheduledAt) fail(409,'Atendimento encerrado. O pedido não foi enviado.');
          const q=json(row.payload); if(JSON.stringify(q.base)!==JSON.stringify(s.base)) fail(409,'A base mudou. Calcule novamente.');
          if(!Array.isArray(b.prices)||b.prices.length!==q.stops.length||b.prices.some(v=>!Number.isInteger(v)||v<0||v>100000))fail(400,'Informe o preço de cada entrega, entre R$ 0 e R$ 1.000.');
          q.stops.forEach((p,i)=>{p.priceCents=b.prices[i];});
          q.totalCents=b.prices.reduce((a,b)=>a+b,0);
          const o={...q,id:crypto.randomUUID(),day:D.localDay(now()),createdAt:now(),status:av.open?'accepted':'scheduled',acceptedAt:av.open?now():null,scheduledFor:av.open?null:av.scheduledAt,seenAt:null,startedAt:null,finishedAt:null,delayUntil:null,delivered:[]};
          delete o.expiresAt;
          await c.execute('INSERT INTO delivery_orders (id,user_id,day_key,status,created_ms,payload) VALUES (?,?,?,?,?,?)',[o.id,u.id,o.day,o.status,o.createdAt,JSON.stringify(o)]);
          await c.execute('UPDATE delivery_quotes SET order_id=? WHERE id=?',[o.id,q.id]);
          return o;
        }); reply(201,order); return;
      }
      const actionMatch=route.match(/^\/orders\/([a-f0-9-]{36})\/action$/);
      if(actionMatch&&req.method==='POST') {
        const b=await body(req);
        const order=await transaction(async(c,s)=>{
          const [rows]=await c.execute('SELECT * FROM delivery_orders WHERE id=? FOR UPDATE',[actionMatch[1]]);
          if(!rows.length) fail(404,'Pedido não encontrado.');
          if(u.role==='client'&&rows[0].user_id!==u.id) fail(403,'Acesso não permitido.');
          const o=json(rows[0].payload);
          if(terminal(o)) fail(409,'Esse pacote já foi encerrado.');
          if(b.action==='cancel') {
            if(u.role==='client'&&!['scheduled','accepted'].includes(o.status)) fail(409,'O pacote já foi visualizado. Fale com Maikon para cancelar.');
            if(!text(b.reason,300)) fail(400,'Informe o motivo do cancelamento.');
            o.status='cancelled';o.cancelReason=text(b.reason);o.finishedAt=now();
          } else {
            requireRole(u,'driver');
            if(b.action==='seen') {
              if(!['accepted','scheduled','seen'].includes(o.status)) fail(409,'Pacote já iniciado.');
              o.seenAt=o.seenAt||now();
              if(o.status!=='scheduled')o.status='seen';
            } else if(b.action==='delay') {
              const minutes=Number(b.minutes); if(!Number.isInteger(minutes)||minutes<1||minutes>120)fail(400,'Informe de 1 a 120 minutos.');
              o.seenAt=o.seenAt||now();o.delayUntil=now()+minutes*60000;
              if(o.status==='accepted')o.status='seen';
            } else if(b.action==='start') {
              if(!['accepted','seen'].includes(o.status)) fail(409,'Este pacote ainda não pode ser iniciado.');
              const [active]=await c.query("SELECT id FROM delivery_orders WHERE status='running' LIMIT 1");
              if(active.length) fail(409,'Conclua o pacote em andamento antes de iniciar outro.');
              o.status='running';o.startedAt=now();o.seenAt=o.seenAt||now();o.delayUntil=null;
            } else if(b.action==='delivered') {
              if(o.status!=='running')fail(409,'Inicie a rota primeiro.');
              const index=Number(b.index);const next=o.route.order.find(i=>!o.delivered.some(d=>d.index===i));
              if(index!==next)fail(409,'Conclua as entregas na ordem da rota.');
              o.delivered.push({index,at:now()});
            } else if(b.action==='finish') {
              if(o.status!=='running'||o.delivered.length!==o.stops.length)fail(409,'Marque todas as entregas antes de concluir.');
              o.status='done';o.finishedAt=now();
            } else fail(400,'Ação inválida.');
          }
          await storeOrder(c,o);return o;
        }); reply(200,order);return;
      }
      if(route==='/history'&&req.method==='GET') {
        const day=text(url.searchParams.get('day'),10);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(day))fail(400,'Data inválida.');
        await maintain();
        const rows=await db(async c=>(await c.execute(`SELECT h.payload FROM delivery_history h JOIN delivery_orders o ON o.id=h.order_id WHERE h.day_key=? ${u.role==='client'?'AND o.user_id=?':''} ORDER BY o.created_ms`,u.role==='client'?[day,u.id]:[day]))[0]);
        reply(200,{orders:rows.map(r=>json(r.payload))});return;
      }
      fail(404,'Endpoint não encontrado.');
    } catch(e) {
      if(!e.status) console.error('Entregas:',e.code||e.message);
      if(!res.headersSent) reply(e.status||503,{error:e.status?e.message:'Serviço temporariamente indisponível. Tente novamente.'});
    }
  }
  return {handle,initialize,maintain,start,stop:()=>clearInterval(timer)};
}
module.exports={createService};
