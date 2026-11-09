// Touche Retour de l'appli Android (ce que la page répond au natif) : node tests/retour-android.cjs
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-ra-'));const U='http://127.0.0.1:8592';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8592','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8592',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});const c=await b.newContext(devices['Pixel 7']);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
const retour=()=>p.evaluate(()=>window.posteRetour());
if(await retour()!=='quitter')err.push('accueil ne quitte pas');
// Feuille « Plus » ouverte : Retour la ferme.
await p.click('.nav-plus');await p.waitForSelector('.feuille:not([hidden])');
if(await retour()!=='fait'||!(await p.locator('.feuille[hidden]').count()))err.push('feuille');
// Fenêtre ouverte : Retour ferme la dernière, pas l'écran.
await p.goto(U+'/#taches');await p.waitForTimeout(300);
await p.evaluate(()=>import('/js/outils.js').then(o=>{o.fenetre('Une');o.fenetre('Deux')}));
if(await retour()!=='fait'||await p.locator('dialog[open]').count()!==1)err.push('fenêtre');
await retour();if(await p.locator('dialog[open]').count())err.push('fenêtre restante');
if(await retour()!=='reculer')err.push('section ne recule pas');
// Ouvert depuis une notification (pas d'écran précédent) : on remonte d'un cran, puis à l'accueil.
await p.evaluate(()=>{location.hash='mails/gmail/5'});await p.evaluate(()=>window.posteRemonter());
if(await p.evaluate(()=>location.hash)!=='#mails')err.push('remonter mail '+await p.evaluate(()=>location.hash));
await p.evaluate(()=>window.posteRemonter());
if(await p.evaluate(()=>location.hash)!=='#accueil')err.push('remonter accueil');
// Hermes : Retour sort de la sélection, puis ferme l'historique, puis recule.
await c.route(/\/api\/hermes\/conversations(\?.*)?$/,r=>r.fulfill({contentType:'application/json',body:JSON.stringify([{id:'c1',titre:'Un',date:Date.now()/1000,epinglee:false,run:null,attente:false}])}));
await p.evaluate(()=>{location.hash='hermes'});await p.waitForSelector('.ouvrir-volet');
await p.click('.ouvrir-volet');await p.waitForSelector('.volet.ouvert');await p.click('.recherche-conv button:has-text("Sélectionner")');
if(await retour()!=='fait'||await p.locator('.case-conv').count())err.push('hermes sélection');
if(await retour()!=='fait'||await p.locator('.volet.ouvert').count())err.push('hermes volet');
if(await retour()!=='reculer')err.push('hermes recule');
// Accueil : la carte du point, taille Moyen.
await c.route('**/api/accueil',async r=>{const rep=await r.fetch();const j=await rep.json();j.point={taille:'moyen',genere_le:Date.now()/1000,chiffres:{},point:{urgent:true,titre:'Une urgence : la banque a refusé un paiement.',aujourdhui:'x',semaine:'y',
 urgences:[{compte:'g',uid:1,de:'Banque',sujet:'s',note:'Paiement de 40 € refusé',lu:false}],importants:[{compte:'g',uid:2,de:'Sabine',sujet:'s',note:'Attend ta réponse pour le diplôme',lu:true}],bonnes:[{compte:'g',uid:3,de:'Colissimo',sujet:'s',note:'Colis livré',lu:true}],mauvaises:[]}};r.fulfill({response:rep,json:j})});
await p.evaluate(()=>{location.hash='accueil'});await p.waitForSelector('.point-accueil .point-titre.urgent');
const groupes=await p.$$eval('.point-accueil .titre-groupe',l=>l.map(x=>x.firstChild.textContent));
if(groupes.join('|')!=='Urgent|Important')err.push('accueil moyen '+groupes);
if(process.argv[2])await p.locator('.point-accueil').screenshot({path:process.argv[2]+'/accueil-point.png'});
console.log('retour',err.length?err:'ok');await b.close();srv.kill();process.exit(err.length?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
