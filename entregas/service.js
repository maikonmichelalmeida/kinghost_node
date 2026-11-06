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
function createService({ openDb, fetchImpl = fetch, now = Date.now, monitorProvider, seedFile = path.join(__dirname, 'accounts.local.json') }) {
  let initPromise;
  let timer, lastMaintenance=0;
  const listeners=new Set();
  function notifyViews(){for(const res of listeners)if(!res.destroyed)res.write('event: change\ndata: 1\n\n');}

  const limits = new Map();
  const budget = require('./google-budget').createBudget({openDb,now,fetchImpl,monitorProvider});
  const google = require('./google-client').createGoogle({budget,fetchImpl});
  const workflow = require('./google-workflow').createWorkflow({db,transaction,storeOrder,google,budget,now});
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
        `CREATE TABLE IF NOT EXISTS delivery_history_items (order_id CHAR(36) NOT NULL, stop_index INT NOT NULL, day_key CHAR(10) NOT NULL, finished_day CHAR(10) NULL, payload LONGTEXT NOT NULL, PRIMARY KEY(order_id,stop_index), INDEX(day_key), INDEX(finished_day))`,
        `CREATE TABLE IF NOT EXISTS delivery_usage (day_key CHAR(10) PRIMARY KEY, units INT NOT NULL DEFAULT 0)`
      ];
      await workflow.initialize(c);
      await budget.initialize();
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
  async function transaction(fn,publish=true) {
    return db(async c => {
      await c.beginTransaction();
      try { const s = await settings(c, true); const result = await fn(c, s); await saveSettings(c, s); await c.commit(); if(publish)notifyViews(); return result; }
      catch (e) { await c.rollback(); throw e; }
    });
  }
  async function archiveItems(c,o){
    for(const [index,p] of o.stops.entries()){
      const delivered=o.delivered?.find(d=>d.index===index);
      const item={orderId:o.id,index,address:p.inputAddress&&/\d/.test(p.inputAddress)?p.inputAddress:p.address,priceCents:p.priceCents,createdAt:o.createdAt,acceptedAt:o.acceptedAt,seenAt:o.seenAt,startedAt:o.startedAt,finishedAt:delivered?.at||o.finishedAt,status:delivered?'done':o.status,cancelReason:o.cancelReason||null};
      await c.execute(`INSERT INTO delivery_history_items (order_id,stop_index,day_key,finished_day,payload) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE finished_day=VALUES(finished_day),payload=VALUES(payload)`,[o.id,index,o.day,item.finishedAt?D.localDay(item.finishedAt):null,JSON.stringify(item)]);
    }
  }
  async function storeOrder(c, o) {
    if(terminal(o)&&o.routeStatus){
      o.stops=o.stops.map(p=>({address:p.inputAddress&&/\d/.test(p.inputAddress)?p.inputAddress:p.address,placeId:p.placeId,priceCents:p.priceCents,suggestedCents:p.suggestedCents}));
      delete o.navigation;delete o.routeError;if(o.route)o.route={order:o.route.order,quality:o.route.quality};
    }
    await c.execute('UPDATE delivery_orders SET status=?,payload=? WHERE id=?', [o.status, JSON.stringify(o), o.id]);
    const [archived]=await c.execute('UPDATE delivery_history SET payload=?,archived_ms=? WHERE order_id=?', [JSON.stringify(o), now(), o.id]);
    if(archived.affectedRows)await archiveItems(c,o);
  }
  async function maintain() {
    await initialize();
    let promoted=false;
    await transaction(async (c, s) => {
      const [rows] = await c.query("SELECT payload FROM delivery_orders WHERE status='scheduled'");
      for (const row of rows) {
        const o = json(row.payload);
        if (o.scheduledFor <= now() && D.availability(s, now()).open) {
          promoted=true; o.status = 'accepted'; o.acceptedAt = now(); await storeOrder(c, o);
        }
      }
      const day = D.localDay(now());
      const late = now() >= Date.parse(`${day}T23:55:00-03:00`);
      await c.execute(`INSERT IGNORE INTO delivery_history (order_id,day_key,archived_ms,payload)
        SELECT id,day_key,?,payload FROM delivery_orders WHERE NOT EXISTS (SELECT 1 FROM delivery_history h WHERE h.order_id=delivery_orders.id) AND day_key ${late ? '<=' : '<'} ?`, [now(), day]);
      await c.execute('DELETE FROM delivery_sessions WHERE expires_ms < ?', [now()]);
      const [missing]=await c.query('SELECT h.payload FROM delivery_history h WHERE NOT EXISTS (SELECT 1 FROM delivery_history_items i WHERE i.order_id=h.order_id) ORDER BY h.archived_ms DESC LIMIT 60');
      for(const row of missing)await archiveItems(c,json(row.payload));
      await c.execute('DELETE FROM delivery_quotes WHERE expires_ms < ? AND order_id IS NULL', [now() - 86400000]);
      await c.execute('DELETE FROM delivery_places WHERE created_ms<?',[now()-86400000]);
      await c.execute('UPDATE delivery_google_operations SET result=NULL WHERE result IS NOT NULL AND reserved_ms<?',[now()-900000]);
    },false);
    lastMaintenance=now();if(promoted)notifyViews();
  }
  function start() {
    maintain().catch(e => console.error('Entregas: inicialização pendente:', e.code || e.message));
    void budget.initialize().then(()=>budget.sync()).catch(()=>{});
    timer = setInterval(() => { void budget.sync().catch(()=>{}); return maintain().catch(e => console.error('Entregas: manutenção falhou:', e.code || e.message)); }, 60000);
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
  async function snapshot(u) {
    if(now()-lastMaintenance>=15000)await maintain();
    return db(async c => {
      const s = await settings(c);
      const [rows] = await c.execute(`SELECT payload FROM delivery_orders WHERE (day_key=? OR status NOT IN ('done','cancelled')) ${u.role === 'client' ? 'AND user_id=?' : ''} ORDER BY created_ms DESC`, u.role === 'client' ? [D.localDay(now()), u.id] : [D.localDay(now())]);
      const orders = rows.map(r => workflow.decorate(json(r.payload)));
      return { user: { username: u.username, role: u.role }, settings: s, availability: D.availability(s, now()), orders,
        day: D.localDay(now()), serverTime: now(), mapsReady: Boolean(process.env.GOOGLE_ROUTES_API_KEY && process.env.GOOGLE_PLACES_API_KEY), googleBudget: u.role === 'driver' ? await budget.summary() : undefined,
        totalCents: orders.filter(o => o.day === D.localDay(now()) && o.status !== 'cancelled').reduce((n,o) => n+o.totalCents,0) };
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
      if(route==='/updates'&&req.method==='GET'){
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no','Connection':'keep-alive'});
        res.write('event: change\ndata: 1\n\n');listeners.add(res);
        const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);
        const expiry=setTimeout(()=>res.end(),90000);
        res.once('close',()=>{clearInterval(heartbeat);clearTimeout(expiry);listeners.delete(res);});return;
      }
      if (route === '/state' && req.method === 'GET') { reply(200, await snapshot(u)); return; }
      if (req.method === 'POST' && (['/autocomplete','/resolve','/google-base','/orders'].includes(route) || /^\/orders\/[a-f0-9-]{36}\/route$/.test(route))) {
        throttle('google:'+u.id,90,60000);
        const result=await workflow.handle(route,await body(req),u); reply(route==='/orders'?201:200,result); return;
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
              if(!o.route?.order)fail(409,'A rota está pendente. Calcule a rota antes de iniciar.');
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
        }); reply(200,workflow.decorate(order));return;
      }
      if(route==='/history'&&req.method==='GET') {
        const day=text(url.searchParams.get('day'),10);
        if(!/^\d{4}-\d{2}-\d{2}$/.test(day))fail(400,'Data inválida.');
        await maintain();
        const rows=await db(async c=>(await c.execute(`SELECT h.payload FROM delivery_history h JOIN delivery_orders o ON o.id=h.order_id WHERE h.day_key=? ${u.role==='client'?'AND o.user_id=?':''} ORDER BY o.created_ms`,u.role==='client'?[day,u.id]:[day]))[0]);
        const items=await db(async c=>(await c.execute(`SELECT i.payload FROM delivery_history_items i JOIN delivery_orders o ON i.order_id=o.id WHERE i.day_key=? ${u.role==='client'?'AND o.user_id=?':''} ORDER BY o.created_ms,i.stop_index`,u.role==='client'?[day,u.id]:[day]))[0]);
        reply(200,{orders:rows.map(r=>json(r.payload)),items:items.map(r=>json(r.payload))});return;
      }
      fail(404,'Endpoint não encontrado.');
    } catch(e) {
      if(!e.status) console.error('Entregas:',e.code||e.message);
      if(!res.headersSent) reply(e.status||503,{error:e.status?e.message:'Serviço temporariamente indisponível. Tente novamente.'});
    }
  }
  return {handle,initialize,maintain,start,budget,stop:()=>{clearInterval(timer);for(const res of listeners)res.end();}};
}
module.exports={createService};
