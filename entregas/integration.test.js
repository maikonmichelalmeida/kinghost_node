const test=require('node:test');const assert=require('node:assert/strict');const http=require('http');const fs=require('fs');const path=require('path');const crypto=require('crypto');const mysql=require('mysql2/promise');
const {createService}=require('./service');
test('API com MySQL isolado: sessões, permissões, preço editado, idempotência, agenda e histórico',{skip:!process.env.TEST_DB_PORT},async()=>{
 const env=Object.fromEntries(fs.readFileSync(path.join(__dirname,'../config.local.env'),'utf8').split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
 const config={host:process.env.TEST_DB_HOST||'127.0.0.1',port:Number(process.env.TEST_DB_PORT),user:env.DB_USER,password:env.DB_PASSWORD,database:env.DB_NAME,charset:'utf8mb4'};
 const prefix='delivery_test_'+crypto.randomBytes(5).toString('hex')+'_';
 const openDb=async()=>{const c=await mysql.createConnection(config);for(const method of ['query','execute']){const old=c[method].bind(c);c[method]=(sql,...args)=>old(sql.replace(/delivery_/g,prefix),...args);}return c;};
 const dir=path.join(__dirname,'../../work');fs.mkdirSync(dir,{recursive:true});const seed=path.join(dir,prefix+'accounts.json');
 fs.writeFileSync(seed,JSON.stringify(['driver','client'].map(role=>{const salt=crypto.randomBytes(16).toString('hex');return{username:role+'-test',role,passwordHash:salt+':'+crypto.scryptSync('test-only-password',salt,64).toString('hex')}})));
 let clock=Date.parse('2026-11-03T09:00:00-03:00');const originalKey=process.env.GEOAPIFY_API_KEY;process.env.GEOAPIFY_API_KEY='fake-test-key';
 let calls=0;const service=createService({openDb,seedFile:seed,now:()=>clock,fetchImpl:async(url,options)=>{calls++;const b=JSON.parse(options.body);return{ok:true,json:async()=>({sources_to_targets:b.sources.map((_,i)=>b.targets.map((_,j)=>({time:i===j?0:100+Math.abs(i-j)*10,distance:i===j?0:3800+Math.abs(i-j)*10})))})};}});
 const server=http.createServer((req,res)=>service.handle(req,res,new URL(req.url,'http://test')));await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port+'/api/entregas';
 async function request(route,body,token){const r=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,data:await r.json()};}
 try{
  await service.initialize();assert.equal((await request('/state')).status,401);
  assert.equal((await request('/login',{username:'driver-test',password:'wrong'})).status,401);
  const driver=(await request('/login',{username:'driver-test',password:'test-only-password'})).data.token;
  const client=(await request('/login',{username:'client-test',password:'test-only-password'})).data.token;
  assert.equal((await request('/availability',{action:'open'},client)).status,403);
  assert.equal((await request('/availability',{action:'schedule',at:'2026-11-03T10:00:00-03:00'},driver)).status,200);
  await request('/base',{lat:-29.94,lon:-50.99,confirmed:true},driver);
  const stops=[{lat:-29.95,lon:-50.98,confirmed:true,address:'Teste isolado',number:'1',note:'Nunca publicar'}];
  const q=await request('/quote',{stops},client);assert.equal(q.status,200);assert.equal(q.data.stops[0].suggestedCents,700);assert.equal(calls,1);
  assert.equal((await request('/orders',{quoteId:q.data.id,prices:[-1]},client)).status,400);
  const submit={quoteId:q.data.id,prices:[1234]};const [r1,r2]=await Promise.all([request('/orders',submit,client),request('/orders',submit,client)]);
  assert.equal(r1.status,201);assert.equal(r1.data.id,r2.data.id);assert.equal(r1.data.totalCents,1234);assert.equal(r1.data.stops[0].suggestedCents,700);assert.equal(r1.data.status,'scheduled');
  const id=r1.data.id;
  assert.equal((await request(`/orders/${id}/action`,{action:'start'},driver)).status,409);
  clock=Date.parse('2026-11-03T10:00:00-03:00');await service.maintain();
  let s=(await request('/state',undefined,client)).data;assert.equal(s.availability.open,true);assert.equal(s.orders.length,1);assert.equal(s.orders[0].status,'accepted');
  assert.equal((await request(`/orders/${id}/action`,{action:'seen'},client)).status,403);
  await request(`/orders/${id}/action`,{action:'seen'},driver);
  await request(`/orders/${id}/action`,{action:'delay',minutes:10},driver);
  assert.equal((await request(`/orders/${id}/action`,{action:'start'},driver)).status,200);
  assert.equal((await request(`/orders/${id}/action`,{action:'finish'},driver)).status,409);
  clock=Date.parse('2026-11-03T20:30:00-03:00');
  assert.equal((await request('/quote',{stops},client)).status,409);
  assert.equal((await request('/availability',{action:'open'},driver)).status,400);
  await request(`/orders/${id}/action`,{action:'delivered',index:0},driver);
  clock=Date.parse('2026-11-04T00:01:00-03:00');await service.maintain();
  s=(await request('/state',undefined,client)).data;assert.equal(s.totalCents,0);assert.equal(s.orders.length,1);
  assert.equal((await request(`/orders/${id}/action`,{action:'finish'},driver)).status,200);
  const history=(await request('/history?day=2026-11-03',undefined,client)).data;assert.equal(history.orders.length,1);assert.equal(history.orders[0].status,'done');assert.equal(history.orders[0].totalCents,1234);
  assert.equal((await request('/state',undefined,client)).data.orders.length,0);
  await request('/logout',{},client);assert.equal((await request('/state',undefined,client)).status,401);
  clock+=31*86400000;assert.equal((await request('/state',undefined,driver)).status,401);
 }finally{
  service.stop();await new Promise(r=>server.close(r));process.env.GEOAPIFY_API_KEY=originalKey||'';fs.unlinkSync(seed);
  const c=await mysql.createConnection(config);for(const suffix of ['users','sessions','settings','orders','quotes','history','usage'])await c.query('DROP TABLE IF EXISTS `'+prefix+suffix+'`');await c.end();
 }
});
