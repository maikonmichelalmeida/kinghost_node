const test=require('node:test');const assert=require('node:assert/strict');const D=require('./domain');
test('preços sugeridos: limites inclusivos e múltiplos de cinco acima de 10km',()=>{
 for(const [meters,cents] of [[0,700],[3999,700],[4000,700],[4001,1000],[7000,1000],[7001,1500],[10000,1500],[10001,2000],[11000,2000],[12499,2000],[12500,2500],[13000,2500]])assert.equal(D.price(meters),cents);
 assert.throws(()=>D.price(NaN));assert.throws(()=>D.price(-1));
});
test('dia e fechamento usam Brasília, inclusive depois de meia-noite UTC',()=>{
 assert.equal(D.localDay(Date.parse('2026-11-04T01:00:00Z')),'2026-11-03');
 assert.equal(D.closing(Date.parse('2026-11-03T10:00:00-03:00')),Date.parse('2026-11-03T20:30:00-03:00'));
});
test('agenda abre sem navegador e não reabre depois do fechamento',()=>{
 const at=Date.parse('2026-11-03T10:00:00-03:00');let s={scheduledAt:at,openUntil:0};
 D.applySchedule(s,at-1);assert.equal(D.availability(s,at-1).open,false);
 D.applySchedule(s,at);assert.equal(D.availability(s,at).open,true);assert.equal(s.scheduledAt,null);
 D.applySchedule(s,D.closing(at));assert.equal(D.availability(s,D.closing(at)).open,false);
 D.applySchedule(s,at+86400000);assert.equal(s.openUntil,0);
});
