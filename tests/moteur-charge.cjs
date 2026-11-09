// Moteur en chargement : bandeau, envoi bloqué, puis retour à la normale. node tests/moteur-charge.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-'));
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8599','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8599',POSTE_ORIGINES:'http://127.0.0.1:8599',POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0'},stdio:'ignore'});
const U='http://127.0.0.1:8599';
(async()=>{let ok=false;for(let i=0;i<40&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});const c=await b.newContext(devices['Pixel 7']);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push(e.message));
let pret=false,envois=0;
await c.route('**/api/hermes/**',r=>{const u=new URL(r.request().url()).pathname;const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
 if(u.endsWith('/modele'))return j({actif:'rapide',pret,choix:[{id:'rapide',nom:'Rapide'},{id:'precis',nom:'Précis'}]});
 if(u.endsWith('/envoyer')){envois++;return j({run_id:'r',conversation:'n'})}
 if(u.endsWith('/flux'))return r.fulfill({status:200,contentType:'text/event-stream',body:'data: {"event":"run.failed","error":"Connection error."}\n\n'});
 if(u.endsWith('/executions/r'))return j({statut:'failed'});
 return j([])});
await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');await p.goto(U+'/#hermes');await p.waitForSelector('.etat-moteur:not([hidden])',{timeout:6000});
await p.screenshot({path:sortie+'/moteur-charge.png'});
await p.fill('.saisie textarea','Coucou');await p.keyboard.press('Enter');await p.evaluate(()=>document.querySelector('.saisie').requestSubmit());await p.waitForTimeout(200);
if(envois)err.push('parti pendant le chargement');if((await p.inputValue('.saisie textarea')).trim()!=='Coucou')err.push('texte perdu');
if(!await p.isDisabled('button.plein:has-text("Envoyer")'))err.push('Envoyer actif');
pret=true;await p.waitForSelector('.etat-moteur',{state:'hidden',timeout:8000});
await p.click('button.plein:has-text("Envoyer")');await p.waitForSelector('.fil .erreur');if(envois!==1)err.push('pas envoyé après retour');
if(!(await p.textContent('.fil .erreur')).includes('moteur IA ne répond pas'))err.push('message technique');
console.log(err.length?err:'ok');await b.close();srv.kill();process.exit(err.length?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(2)})
