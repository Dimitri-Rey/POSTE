// Recherche globale (Ctrl+K), vrai serveur, mails et Hermes simulés : node tests/recherche-globale.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-rg-'));const U='http://127.0.0.1:8588';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8588','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8588',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 await c.route('**/api/mails?**',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(new URL(r.request().url()).searchParams.get('q')?[{compte:'gmail',uid:7,de:'Paul Dupont <p@x.fr>',sujet:'Devis Dupont signé',ts:Date.now()/1000,lu:1,alertes:[]}]:[])}));
 await c.route('**/api/hermes/conversations/recherche**',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify([{id:'conv-42',titre:'Préparer le devis Dupont',date:0,extrait:'… le devis Dupont …'}])}));
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 if(nom==='pc'){const post=(u,o,m='POST')=>p.evaluate(([u,o,m])=>fetch(u,{method:m,headers:{'Content-Type':'application/json'},body:JSON.stringify(o)}).then(r=>r.status),[u,o,m]);
  await post('/api/taches',{titre:'Relancer Dupont'});await post('/api/agenda',{titre:'Appel Dupont',debut:new Date(Date.now()+864e5).toISOString().slice(0,10)+'T14:00'});
  await post('/api/espace/fichier',{chemin:'Clients/dupont.md',contenu:'x'},'PUT');await post('/api/espace/fichier',{chemin:'Notes/reunion.md',contenu:'Réunion avec la société Dupont pour le pare-feu.'},'PUT');}
 await p.goto(U+'/#accueil');await p.waitForSelector('.salut');
 if(nom==='pc')await p.keyboard.press('Control+k');else{await p.click('.nav-plus');await p.click('.feuille a:has-text("Rechercher")')}
 await p.waitForSelector('dialog.palette input');await p.fill('dialog.palette input','dupont');
 await p.waitForSelector('.palette-groupe:has-text("Hermes")',{timeout:8000});
 const groupes=await p.$$eval('.palette-groupe',l=>l.map(x=>x.textContent).join('|'));if(groupes!=='Tâches|Agenda|Fichiers|Mails|Hermes')err.push('groupes '+groupes);
 if(!(await p.locator('.palette-item:has-text("reunion.md") mark').count()))err.push('extrait du contenu');
 await p.screenshot({path:`${sortie}/recherche-globale-${nom}.png`});
 // Clavier : 5e résultat = la conversation Hermes ? On vise plutôt le mail par le texte.
 await p.click('.palette-item:has-text("Devis Dupont signé")');await p.waitForFunction(()=>location.hash==='#mails/gmail/7');
 await p.keyboard.press('Control+k');await p.fill('dialog.palette input','dupont');await p.waitForSelector('.palette-item:has-text("Préparer le devis Dupont")');
 await p.click('.palette-item:has-text("Préparer le devis Dupont")');await p.waitForFunction(()=>location.hash==='#hermes');
 if(await p.evaluate(()=>sessionStorage.getItem('hermes-conversation'))!=='conv-42')err.push('conversation non ouverte');
 await p.keyboard.press('Control+k');await p.waitForSelector('dialog.palette');await p.keyboard.type('agen');await p.keyboard.press('Enter');await p.waitForFunction(()=>location.hash==='#agenda');
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
