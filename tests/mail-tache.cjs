// Mail → tâche / rendez-vous, réglages du point du matin, carte de l'accueil. Usage : node tests/mail-tache.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-mt-'));const sortie=process.argv[2]||tmp;const U='http://127.0.0.1:8582';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8582','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8582',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const t=Date.now()/1000;const Z={total:0,non_lus:0,importants:0,importants_non_lus:0};
const POINT={urgent:false,titre:"Rien d'urgent aujourd'hui.",aujourdhui:'Calme.',semaine:'Sabine attend ta réponse.',urgences:[],importants:[{compte:'gmail',uid:5,de:'Sabine',sujet:'Diplôme',note:'Fixer le retrait du diplôme',lu:false}],bonnes:[],mauvaises:[]};
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1440,height:900}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));const crees=[];
 await c.route('**/api/mails**',r=>{const u=new URL(r.request().url()),m=r.request().method();const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
  if(u.pathname==='/api/mails/point/reglages')return r.continue();
  if(u.pathname==='/api/mails/point')return j({point:POINT,genere_le:t,a_jour:true,chiffres:{jour:Z,semaine:Z},en_cours:false});
  if(u.pathname.endsWith('/comptes'))return j([{id:'gmail',adresse:'moi@gmail.com'}]);
  if(u.pathname==='/api/mails/synchroniser')return j({lance:false});
  if(u.pathname==='/api/mails'||u.pathname==='/api/mails/bloques')return j([]);
  if(u.pathname.endsWith('/proposition')){const g=JSON.parse(r.request().postData()).genre;
   return setTimeout(()=>j(g==='tache'?{titre:'Répondre à Sabine pour le diplôme',echeance:'2026-11-20',notes:'Créneau à fixer.\n\nMail de Sabine : Diplôme'}:{titre:'Cérémonie des diplômes',date:'2026-11-26',heure:'18:30',duree_minutes:120,lieu:'Saint-Étienne',notes:''}),400)}
  return j({de:'Sabine <s@ecole.fr>',a:'moi',sujet:'Diplôme',ts:t,message_id:'<id@x>',texte:'Bonjour',analyse:{niveau:'sain',score:0,raisons:[]},alertes:[],expediteur:'s@ecole.fr',lien_fournisseur:null,a_html:false,images_distantes:false,pieces_jointes:[]})});
 await c.route(/\/api\/(taches|agenda)$/,r=>{if(r.request().method()!=='POST')return r.continue();crees.push([new URL(r.request().url()).pathname,JSON.parse(r.request().postData())]);r.fulfill({status:200,contentType:'application/json',body:'{"id":1}'})});
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 // Depuis le lecteur : tâche proposée par l'IA, relue puis ajoutée.
 await p.goto(U+'/#mails/gmail/5');await p.waitForSelector('h1:has-text("Diplôme")');
 await p.click('button[aria-label="Créer une tâche"]');await p.waitForSelector('dialog[open] input[aria-label="Titre"]:not([disabled])');
 if(await p.inputValue('dialog[open] input[aria-label="Titre"]')!=='Répondre à Sabine pour le diplôme')err.push('titre tâche');
 if(await p.inputValue('dialog[open] input[aria-label="Échéance"]')!=='2026-11-20')err.push('échéance');
 await p.screenshot({path:`${sortie}/tache-${nom}.png`});
 await p.fill('dialog[open] input[aria-label="Titre"]','Répondre à Sabine');await p.click('dialog[open] button:has-text("Ajouter la tâche")');
 await p.waitForSelector('.toast:has-text("Tâche ajoutée")');
 if(JSON.stringify(crees[0])!==JSON.stringify(['/api/taches',{titre:'Répondre à Sabine',echeance:'2026-11-20',notes:'Créneau à fixer.\n\nMail de Sabine : Diplôme'}]))err.push('tâche '+JSON.stringify(crees[0]));
 // Rendez-vous : date, heure et durée de l'IA.
 await p.click('button[aria-label="Ajouter à l\'agenda"]');await p.waitForSelector('dialog[open] input[aria-label="Début"]:not([disabled])');
 if(await p.inputValue('dialog[open] input[aria-label="Début"]')!=='2026-11-26T18:30'||await p.inputValue('dialog[open] input[aria-label="Fin"]')!=='2026-11-26T20:30')err.push('heures');
 await p.screenshot({path:`${sortie}/rdv-${nom}.png`});
 await p.click('dialog[open] button:has-text("Ajouter à l\'agenda")');await p.waitForSelector('.toast:has-text("Rendez-vous ajouté")');
 if(crees[1]?.[0]!=='/api/agenda'||crees[1][1].debut!=='2026-11-26T18:30'||crees[1][1].lieu!=='Saint-Étienne'||crees[1][1].fin!=='2026-11-26T20:30')err.push('rdv '+JSON.stringify(crees[1]));
 // Depuis le point : même feuille.
 await p.goto(U+'/#mails');await p.waitForSelector('.point-element');
 await p.hover('.point-element');await p.click('.point-element button[title="Créer une tâche"]');
 await p.waitForSelector('dialog[open] input[aria-label="Titre"]:not([disabled])');await p.keyboard.press('Escape');
 if(nom==='pc'){
  // Réglages : point du matin (heure, taille, accueil).
  await p.goto(U+'/#reglages');await p.waitForSelector('h2:has-text("Point des mails")');
  await p.click('.segments button:has-text("Grand")');await p.waitForSelector('.segments button.actif:has-text("Grand")');
  await p.fill('input[aria-label="Heure du point"]','06:45');await p.dispatchEvent('input[aria-label="Heure du point"]','change');
  await p.waitForSelector('.toast:has-text("6 h 45")');
  const sec=p.locator('section:has(h2:has-text("Point des mails"))');await sec.screenshot({path:`${sortie}/reglages-point.png`});
  const rg=await p.evaluate(()=>fetch('/api/mails/point/reglages').then(r=>r.json()));
  if(rg.heure!=='06:45'||rg.taille!=='grand')err.push('réglages '+JSON.stringify(rg));
  await p.click('input[aria-label="Point du matin sur le téléphone"]');await p.waitForSelector('input[aria-label="Heure du point"][disabled]');
  await p.click('input[aria-label="Point du matin sur le téléphone"]');
 }
 // Accueil : carte du point (pas encore de point du jour sur ce serveur de test).
 await p.goto(U+'/#accueil');await p.waitForSelector('.point-accueil');
 if(!(await p.textContent('.point-accueil')).includes("Pas encore de point aujourd'hui"))err.push('carte accueil');
 await p.screenshot({path:`${sortie}/accueil-${nom}.png`});
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
