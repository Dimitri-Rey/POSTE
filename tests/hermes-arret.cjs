// Arrêter avec un flux qui ne dit jamais rien : l'écran doit se débloquer seul. node tests/hermes-arret.cjs
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');const {chromium,devices}=require(process.env.PLAYWRIGHT);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-'));const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8599','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8599',POSTE_ORIGINES:'http://127.0.0.1:8599',POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0'},stdio:'ignore'});const U='http://127.0.0.1:8599';
(async()=>{let ok=false;for(let i=0;i<40&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});const c=await b.newContext(devices['Pixel 7']);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push(e.message));let statut='running',envois=0,arrets=0;
await c.route('**/api/hermes/**',r=>{const u=new URL(r.request().url()).pathname;const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
 if(u.endsWith('/modele'))return j({actif:'x',pret:true,choix:[]});if(u.endsWith('/envoyer')){envois++;return j({run_id:'r'+envois,conversation:'a'})}
 if(u.endsWith('/flux'))return; // Le flux reste ouvert et muet.
 if(u.endsWith('/arreter')){arrets++;statut='cancelled';return j({})}
 if(/executions\/r\d+$/.test(u))return j({statut,sortie:null,approbation:null});
 return j([])});
await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');await p.goto(U+'/#hermes');await p.waitForSelector('.saisie');
await p.fill('.saisie textarea','Bonjour');await p.click('button.plein:has-text("Envoyer")');await p.waitForSelector('.saisie button:has-text("Arrêter")');
await p.click('.saisie button:has-text("Arrêter")');await p.waitForSelector('button.plein:has-text("Envoyer")',{timeout:9000});
if(!(await p.textContent('.fil')).includes('Arrêté'))err.push('pas de message');
statut='running';await p.fill('.saisie textarea','Encore');await p.click('button.plein:has-text("Envoyer")');await p.waitForSelector('.saisie button:has-text("Arrêter")');if(envois!==2)err.push('envois '+envois);if(arrets!==1)err.push('arrêts '+arrets);
if(await p.isDisabled('.saisie button:has-text("Arrêter")'))err.push('bouton resté grisé');
console.log(err.length?err:'ok');await b.close();srv.kill();process.exit(err.length?1:0)})().catch(e=>{console.error(e.message);srv.kill();process.exit(2)})
