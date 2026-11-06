const test=require('node:test');const assert=require('node:assert/strict');const http=require('http');const fs=require('fs');const path=require('path');const crypto=require('crypto');const mysql=require('mysql2/promise');
const {createService}=require('./service');
test('API com MySQL isolado: sessões, permissões, preço editado, idempotência, agenda e histórico',{skip:!process.env.TEST_DB_PORT},async()=>{
 const env=Object.fromEntries(fs.readFileSync(path.join(__dirname,'../config.local.env'),'utf8').split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
 const config={host:process.env.TEST_DB_HOST||'127.0.0.1',port:Number(process.env.TEST_DB_PORT),user:env.DB_USER,password:env.DB_PASSWORD,database:env.DB_NAME,charset:'utf8mb4'};
 const prefix='delivery_test_'+crypto.randomBytes(5).toString('hex')+'_';
 const openDb=async()=>{const c=await mysql.createConnection(config);for(const method of ['query','execute']){const old=c[method].bind(c);c[method]=(sql,...args)=>old(sql.replace(/delivery_/g,prefix),...args);}return c;};
 const dir=path.join(__dirname,'../../work');fs.mkdirSync(dir,{recursive:true});const seed=path.join(dir,prefix+'accounts.json');
 fs.writeFileSync(seed,JSON.stringify(['driver','client'].map(role=>{const salt=crypto.randomBytes(16).toString('hex');return{username:role+'-test',role,passwordHash:salt+':'+crypto.scryptSync('test-only-password',salt,64).toString('hex')}})));
 let clock=Date.parse('2026-11-03T09:00:00-03:00');const originalKey=process.env.GOOGLE_ROUTES_API_KEY;process.env.GOOGLE_ROUTES_API_KEY='fake-test-key';process.env.GOOGLE_PLACES_API_KEY='fake-test-key';
 let routeGate=null,calls=0,alerts=0,simulateFailure=false;const service=createService({openDb,seedFile:seed,now:()=>clock,announceNewOrder:async()=>{alerts++;throw new Error("simulated voice outage");},monitorProvider:async()=>({counts:{routes:0,autocomplete:0,details:0,geocode:0},cutoff:clock-3600000}),fetchImpl:async(url,options)=>{
  calls++;if(routeGate)await routeGate;if(simulateFailure)throw new Error('mock timeout');
  const b=options.body?JSON.parse(options.body):{};
  if(String(url).includes('/places/'))return {ok:true,json:async()=>({id:'place-test',formattedAddress:'Rua Teste, 1, Gravataí',location:{latitude:-29.95,longitude:-50.98},addressComponents:[{types:['street_number'],longText:'1'}]})};
  return{ok:true,json:async()=>({routes:[{duration:'250s',distanceMeters:3900,optimizedIntermediateWaypointIndex:(b.intermediates||[]).map((_,i)=>i).reverse()}]})};
 }});
 const server=http.createServer((req,res)=>service.handle(req,res,new URL(req.url,'http://test')));await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port+'/api/entregas';
 async function request(route,body,token){const r=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json()};}
 try{
  await service.initialize();await service.budget.sync(true);assert.equal((await request('/state')).status,401);
  assert.equal((await request('/login',{username:'driver-test',password:'wrong'})).status,401);
  const driver=(await request('/login',{username:'driver-test',password:'test-only-password'})).data.token;
  const client=(await request('/login',{username:'client-test',password:'test-only-password'})).data.token;
  assert.equal((await request('/availability',{action:'open'},client)).status,403);
  const control=new AbortController();const stream=await fetch(origin+'/updates',{headers:{Authorization:'Bearer '+client},signal:control.signal});
  assert.match(stream.headers.get('content-type'),/event-stream/);const reader=stream.body.getReader();await reader.read();
  assert.equal((await request('/availability',{action:'schedule',at:'2026-11-03T10:00:00-03:00'},driver)).status,200);
  let timeout;try{const change=await Promise.race([reader.read(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('missing SSE change')),3000);})]);assert.match(Buffer.from(change.value).toString(),/event: change/);}finally{clearTimeout(timeout);control.abort();await reader.cancel().catch(()=>{});}

  await request('/base',{lat:-29.94,lon:-50.99,confirmed:true},driver);
  const resolved=await request('/resolve',{placeId:'place-test',address:'Rua Teste, 1, Gravataí',operationId:crypto.randomUUID(),session:crypto.randomUUID()},client);
  assert.equal(resolved.status,200);assert.equal(resolved.data.suggestedCents,700);
  const stops=[{selectionId:resolved.data.selectionId,priceCents:1234}];
  const submit={submissionId:crypto.randomUUID(),stops};
  const [r1,r2]=await Promise.all([request('/orders',submit,client),request('/orders',submit,client)]);
  assert.equal(r1.status,201);assert.equal(r1.data.id,r2.data.id);assert.equal(r1.data.totalCents,1234);assert.equal(r1.data.stops[0].suggestedCents,700);assert.equal(r1.data.status,'scheduled');assert.equal(calls,2);
  const ready=[r1.data,r2.data].find(o=>o.routeStatus==='ready');assert.ok(ready);
  assert.equal(new URL(ready.navigation[0].url).searchParams.has('origin'),false);
  const id=r1.data.id;
  const chatPath=`/orders/${id}/messages`;
  const msg={messageKey:crypto.randomUUID(),message:'Portão azul',sender:'entregador'};
  assert.equal((await request(chatPath,msg)).status,401);
  const chatStreamAbort=new AbortController();const liveChat=await fetch(origin+'/updates',{headers:{Authorization:'Bearer '+driver},signal:chatStreamAbort.signal});
  const chatReader=liveChat.body.getReader();await chatReader.read();
  try {
    const sends=await Promise.all([request(chatPath,msg,client),request(chatPath,msg,client)]);
    assert.ok(sends.every(r=>r.status===200));
    assert.match(Buffer.from((await chatReader.read()).value).toString(),/event: change/);
  }finally{chatStreamAbort.abort();await chatReader.cancel().catch(()=>{});}
  await request(chatPath,{messageKey:crypto.randomUUID(),message:'Estou chegando'},driver);
  const thread=(await request('/state',undefined,client)).data.messages[id];
  assert.deepEqual(thread.map(m=>[m.sender,m.message]),[['entregador','Estou chegando'],['farmacia','Portão azul']]);
  assert.equal((await request(`/orders/${crypto.randomUUID()}/messages`,undefined,driver)).status,404);

  // A conta do entregador deve enxergar imediatamente a encomenda criada pela farmácia.
  const pendingDriver=(await request('/state',undefined,driver));
  assert.equal(pendingDriver.status,200);
  assert.equal(pendingDriver.data.orders.find(o=>o.id===id)?.status,'scheduled');
  assert.equal((await request(`/orders/${id}/action`,{action:'start'},driver)).status,409);
  clock=Date.parse('2026-11-03T10:00:00-03:00');await service.maintain();
  let s=(await request('/state',undefined,client)).data;assert.equal(s.availability.open,true);assert.equal(s.orders.length,1);assert.equal(s.orders[0].status,'accepted');
  const acceptedDriver=(await request('/state',undefined,driver)).data;
  assert.equal(acceptedDriver.orders.find(o=>o.id===id)?.status,'accepted');
  assert.equal((await request(`/orders/${id}/action`,{action:'seen'},client)).status,403);
  await request(`/orders/${id}/action`,{action:'seen'},driver);
  assert.equal((await request('/state',undefined,client)).data.orders.find(o=>o.id===id)?.status,'seen');
  await request(`/orders/${id}/action`,{action:'delay',minutes:10},driver);
  assert.equal((await request(`/orders/${id}/action`,{action:'start'},driver)).status,200);
  assert.equal((await request('/state',undefined,client)).data.orders.find(o=>o.id===id)?.status,'running');
  assert.equal((await request(`/orders/${id}/action`,{action:'finish'},driver)).status,409);
  clock=Date.parse('2026-11-03T20:30:00-03:00');
  assert.equal((await request('/orders',{submissionId:crypto.randomUUID(),stops},client)).status,409);
  assert.equal((await request('/availability',{action:'open'},driver)).status,400);
  await request(`/orders/${id}/action`,{action:'delivered',index:0},driver);
  clock=Date.parse('2026-11-04T00:01:00-03:00');await service.maintain();
  s=(await request('/state',undefined,client)).data;assert.equal(s.totalCents,0);assert.equal(s.orders.length,1);
  assert.equal((await request(`/orders/${id}/action`,{action:'finish'},driver)).status,200);
  assert.equal((await request(chatPath,{messageKey:crypto.randomUUID(),message:'novo'},driver)).status,409);
  assert.equal((await request(chatPath,undefined,client)).data.messages.length,2);
  const history=(await request('/history?day=2026-11-03',undefined,client)).data;assert.equal(history.items.length,1);assert.equal(history.items[0].priceCents,1234);assert.equal(history.orders.length,1);assert.equal(history.orders[0].status,'done');assert.equal(history.orders[0].totalCents,1234);
  assert.equal((await request('/state',undefined,client)).data.orders.length,0);
  clock=Date.parse('2026-11-04T12:00:00-03:00');await request('/availability',{action:'open'},driver);
  assert.equal(alerts,0); // Scheduled orders and their later promotion stay silent.
  simulateFailure=true;const liveSubmission={submissionId:crypto.randomUUID(),stops:[{address:'Rua Teste, 123, Gravataí',priceCents:700},{address:'Rua Teste, 124, Gravataí',priceCents:700}]};
  const failed=await request('/orders',liveSubmission,client);
  const repeated=await request('/orders',liveSubmission,client);assert.equal(repeated.data.id,failed.data.id);assert.equal(alerts,1);
  assert.equal(failed.status,201);assert.equal(failed.data.routeStatus,'pending');assert.equal(failed.data.route,null);
  assert.equal((await request('/state',undefined,driver)).data.orders.some(o=>o.id===failed.data.id),true);
  // Even with slow Maps, the receipt and the first chat message are available immediately.
  let releaseRoute;routeGate=new Promise(resolve=>{releaseRoute=resolve;});simulateFailure=false;
  const background={...liveSubmission,submissionId:crypto.randomUUID(),backgroundRoute:true,firstMessage:'Portão lateral'};
  const watchdog=setTimeout(releaseRoute,4000);
  let created;
  try {
    created=await request('/orders',background,client);assert.equal(created.status,201);assert.equal(created.data.routeStatus,'queued');
    const receipt=await request('/state',undefined,driver);assert.deepEqual(receipt.data.messages[created.data.id].map(m=>m.message),['Portão lateral']);
    assert.equal((await request('/orders',background,client)).data.id,created.data.id);
    assert.equal((await request('/orders',{...background,firstMessage:'Diferente'},client)).status,409);
  }finally{clearTimeout(watchdog);releaseRoute();routeGate=null;}
  for(let tries=0;tries<50;tries++){const snapshot=(await request('/state',undefined,driver)).data;
    if(snapshot.orders.find(o=>o.id===created.data.id)?.routeStatus==='ready')break;
    await new Promise(r=>setTimeout(r,40));}
  const startPath=`/orders/${created.data.id}/action`;
  for(let attempt=0;attempt<2;attempt++){const started=await request(startPath,{action:'start'},driver);assert.equal(started.status,200);assert.ok(started.data.navigation[0].url);}
  // A simultaneous burst reserves at most the configured 20 routes per minute.
  clock+=60000;let executions=0;
  const burst=await Promise.allSettled(Array.from({length:30},(_,i)=>service.budget.call('routes','burst-'+i,{i},async()=>{executions++;return {ok:true};})));
  assert.equal(executions,20);assert.equal(burst.filter(r=>r.status==='rejected').length,10);
  const fresh=require('./google-budget').createBudget({openDb,now:()=>clock});
  const persisted=await fresh.summary();assert.equal(persisted.usage.routes.minute,20);
  await assert.rejects(fresh.call('routes','restart',{},async()=>assert.fail('must not call')),e=>e.status===429);
  clock+=60001;let duplicateCount=0;
  await fresh.call('details','same',{},async()=>{duplicateCount++;return {x:1};});
  await fresh.call('details','same',{},async()=>{duplicateCount++;return {x:1};});assert.equal(duplicateCount,1);
  await assert.rejects(fresh.call('details','uncertain',{},async()=>{throw new Error('timeout');}));
  await assert.rejects(fresh.call('details','uncertain',{},async()=>assert.fail('must not retry')),e=>e.status===409);
  const periods=require('./google-policy').periods(clock);
  async function adjustMonitor(fn){const c=await openDb();try{const [rows]=await c.query('SELECT payload FROM delivery_google_monitor WHERE id=1');const m=JSON.parse(rows[0].payload);fn(m);await c.execute('UPDATE delivery_google_monitor SET payload=? WHERE id=1',[JSON.stringify(m)]);}finally{await c.end();}}
  await adjustMonitor(m=>{m.baseline={routes:2000};m.month=periods.month;});
  await assert.rejects(fresh.call('routes','month',{},async()=>assert.fail('monthly cap')),e=>e.status===429);
  await adjustMonitor(m=>{m.baseline={};m.dayBaseline={routes:100};m.baselineDay=periods.day;});
  await assert.rejects(fresh.call('routes','day',{},async()=>assert.fail('daily cap')),e=>e.status===429);
  await assert.rejects(fresh.call('autocomplete','early',{},async()=>assert.fail('optional calls paused')),e=>e.status===429);
  await adjustMonitor(m=>{m.dayBaseline={};m.lastSuccess=clock-49*3600000;});
  await assert.rejects(fresh.call('routes','stale',{},async()=>assert.fail('stale monitoring')),e=>e.status===503);
  await request('/logout',{},client);assert.equal((await request('/state',undefined,client)).status,401);
  clock+=31*86400000;assert.equal((await request('/state',undefined,driver)).status,401);
 }finally{
  service.stop();await new Promise(r=>server.close(r));process.env.GOOGLE_ROUTES_API_KEY=originalKey||'';fs.unlinkSync(seed);
  const c=await mysql.createConnection(config);for(const suffix of ['users','sessions','settings','orders','quotes','history','history_items','messages','usage','places','submissions','google_operations','google_monitor'])await c.query('DROP TABLE IF EXISTS `'+prefix+suffix+'`');await c.end();
 }
});
