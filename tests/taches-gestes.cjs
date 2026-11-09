// Gestes sur les tâches (téléphone) : glisser à droite termine (Annuler la remet), à gauche retire. node tests/taches-gestes.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-tg-'));const U='http://127.0.0.1:8587';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8587','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8587',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});const err=[];
const c=await b.newContext(devices['Pixel 7']);const p=await c.newPage();p.on('pageerror',e=>err.push('js:'+e.message));
await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
for(const t of ['Payer la facture','Appeler le garage'])await p.evaluate(t=>fetch('/api/taches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({titre:t})}),t);
await p.goto(U+'/#taches');await p.waitForSelector('.ligne.tache');
const glisser=(titre,dx)=>p.evaluate(([titre,dx])=>{const l=[...document.querySelectorAll('.ligne.tache')].find(x=>x.textContent.includes(titre));const r=l.getBoundingClientRect();const y=r.top+r.height/2,x=r.left+r.width/2;
 const t=(cx)=>new Touch({identifier:1,target:l,clientX:cx,clientY:y});
 l.dispatchEvent(new TouchEvent('touchstart',{touches:[t(x)],changedTouches:[t(x)],bubbles:true}));
 for(let i=1;i<=6;i++)l.dispatchEvent(new TouchEvent('touchmove',{touches:[t(x+dx*i/6)],changedTouches:[t(x+dx*i/6)],bubbles:true}));
 l.dispatchEvent(new TouchEvent('touchend',{touches:[],changedTouches:[t(x+dx)],bubbles:true}))},[titre,dx]);
const titres=()=>p.evaluate(()=>fetch('/api/taches').then(r=>r.json()).then(l=>l.map(t=>t.titre).sort().join('|')));
await glisser('Payer la facture',140);await p.waitForSelector('.toast:has-text("Tâche terminée")');await p.screenshot({path:`${sortie}/taches-geste.png`});
if(await titres()!=='Appeler le garage')err.push('terminée: '+await titres());
await p.click('.toast button:has-text("Annuler")');await p.waitForSelector('.ligne.tache:has-text("Payer la facture")');
if(await titres()!=='Appeler le garage|Payer la facture')err.push('annuler: '+await titres());
await glisser('Appeler le garage',-140);await p.waitForSelector('.toast:has-text("Tâche retirée")');
if(await titres()!=='Payer la facture')err.push('retirée: '+await titres());
await glisser('Payer la facture',30);await p.waitForTimeout(400);if(await titres()!=='Payer la facture')err.push('petit glissement compté');
console.log('mobile',err.length?err:'ok');await b.close();srv.kill();process.exit(err.length?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
