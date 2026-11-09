// Réseau lent (1,2 s par réponse) : le menu réagit tout de suite et une barre dit que la page arrive. Usage : node tests/navigation-lente.cjs
const {spawn}=require('child_process'),fs=require('fs'),os=require('os');
const {chromium}=require(process.env.PLAYWRIGHT);const tmp=fs.mkdtempSync(os.tmpdir()+'/nl');const U='http://127.0.0.1:8579';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8579','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8579',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
(async()=>{for(let i=0;i<60;i++){if(await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,250))}
const b=await chromium.launch({executablePath:process.env.CHROME});const c=await b.newContext({viewport:{width:1440,height:900}});const p=await c.newPage();const err=[];
p.on('pageerror',e=>err.push('js:'+e.message));
await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');await p.waitForTimeout(800);
await c.route('**/api/**',async r=>{await new Promise(x=>setTimeout(x,1200));r.continue().catch(()=>{})});
await p.click('nav a[href="#taches"]');await p.waitForTimeout(350);
const pendant=await p.evaluate(()=>({actif:document.querySelector('nav a.actif')?.getAttribute('href'),barre:document.body.classList.contains('navigation-en-cours'),titre:document.querySelector('main h1')?.textContent}));
if(pendant.actif!=='#taches')err.push('menu pas à jour '+pendant.actif);
if(!pendant.barre)err.push('pas de barre');
if(pendant.titre!=='Bonjour')err.push('page changée trop tôt ?'+pendant.titre);
await p.waitForSelector('main h1:has-text("Tâches")',{timeout:8000});
if(await p.evaluate(()=>document.body.classList.contains('navigation-en-cours')))err.push('barre restée');
// Deux clics rapides : seule la dernière page s'affiche, et la barre s'en va.
await p.click('nav a[href="#agenda"]');await p.waitForTimeout(100);await p.click('nav a[href="#mails"]');
await p.waitForSelector('main h1:has-text("Mails")',{timeout:10000});await p.waitForTimeout(2000);
if(await p.evaluate(()=>document.querySelector('main h1')?.textContent)!=='Mails')err.push('mauvaise page');
if(await p.evaluate(()=>document.body.classList.contains('navigation-en-cours')))err.push('barre restée après deux clics');
console.log('navigation lente',err.length?err:'ok');await b.close();srv.kill();process.exit(err.length?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
