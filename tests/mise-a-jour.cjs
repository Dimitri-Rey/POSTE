// Une nouvelle version recharge l'interface, sauf pendant une saisie : node tests/mise-a-jour.cjs
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');const {chromium,devices}=require(process.env.PLAYWRIGHT);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-'));const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8599','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8599',POSTE_ORIGINES:'http://127.0.0.1:8599',POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0'},stdio:'ignore'});const U='http://127.0.0.1:8599';
(async()=>{let ok=false;for(let i=0;i<40&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});const c=await b.newContext(devices['Pixel 7']);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push(e.message));
await c.route('**/api/hermes/**',r=>{const u=new URL(r.request().url()).pathname;const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});if(u.endsWith('/modele'))return j({actif:'x',pret:true,choix:[]});return j([])});
await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');await p.goto(U+'/#hermes');await p.waitForSelector('.saisie');await p.waitForTimeout(400);
let charges=0;p.on('load',()=>charges++);
const vers=(v)=>c.route('**/api/auth/etat',async r=>{const x=await r.fetch();const d=await x.json();await r.fulfill({response:x,json:{...d,version:v}})});
const retour=()=>p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
await retour();await p.waitForTimeout(500);if(charges)err.push('rechargé sans nouvelle version');
await vers('99.0.0');await p.fill('.saisie textarea','texte en cours');await retour();await p.waitForTimeout(600);if(charges)err.push('saisie perdue');if(await p.inputValue('.saisie textarea')!=='texte en cours')err.push('texte');
await p.fill('.saisie textarea','');await retour();await p.waitForTimeout(1500);if(charges<1)err.push('pas rechargé');
await p.waitForSelector('.saisie');console.log(err.length?err:'ok');await b.close();srv.kill();process.exit(err.length?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(2)})
