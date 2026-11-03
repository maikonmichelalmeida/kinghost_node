"use strict";
// Explicit migration entry point: never starts the legacy web server.
const fs=require('fs');const path=require('path');const mysql=require('mysql2/promise');
for(const file of ['config.local.env','.env']) {
 const p=path.join(__dirname,'..',file);if(!fs.existsSync(p))continue;
 for(const line of fs.readFileSync(p,'utf8').split(/\r?\n/)) {
  const m=line.match(/^([A-Z_0-9]+)=(.*)$/);if(m&&process.env[m[1]]===undefined)process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');
 }
}
const openDb=()=>mysql.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_NAME,port:Number(process.env.DB_PORT||3306),connectTimeout:10000,charset:'utf8mb4'});
const service=require('./service').createService({openDb});
service.initialize().then(()=>console.log('Tabelas de entregas e contas configuradas.')).catch(e=>{console.error('Não foi possível configurar o banco:',e.code||e.message);process.exitCode=1;});
