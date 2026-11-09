// Branchements dans Réglages, sur une installation vierge : agenda iCal, IA compatible OpenAI, boîte mail refusée, modules.
// Un faux agenda et un faux service d'IA tournent dans ce script. node tests/branchements.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-br-'));fs.writeFileSync(tmp+'/poste.toml','');const U='http://127.0.0.1:8587';
const j=new Date(Date.now()+864e5),d=j.toISOString().slice(0,10).replace(/-/g,'');
const ICS=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//t//FR','BEGIN:VEVENT','UID:a',`DTSTART:${d}T090000`,`DTEND:${d}T100000`,'SUMMARY:Dentiste test','LOCATION:Cabinet','DESCRIPTION:Apporter la carte','END:VEVENT',
 'BEGIN:VEVENT','UID:b',`DTSTART;VALUE=DATE:${d}`,'SUMMARY:Congés test','END:VEVENT','END:VCALENDAR'].join('\r\n');
const faux=http.createServer((q,r)=>{
 if(q.url==='/a.ics'){r.writeHead(200,{'content-type':'text/calendar'});return r.end(ICS)}
 if(q.url==='/v1/models'){r.writeHead(200,{'content-type':'application/json'});return r.end(JSON.stringify({data:[{id:'llama-test'},{id:'mistral-test'}]}))}
 r.writeHead(404);r.end()}).listen(8588);
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8587','--app-dir','api'],{env:{...process.env,POSTE_CONFIG:tmp+'/poste.toml',POSTE_CLE:tmp+'/cle',POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8587',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const fin=(code)=>{srv.kill();faux.close();process.exit(code)};
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:900}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.goto(U+'/#reglages');await p.waitForSelector('.br-zone section');
 const titres=await p.$$eval('.reglages-page h2',l=>l.map(x=>x.firstChild.textContent.trim()));
 for(const t of ['Boîtes mail','Agendas','Intelligence artificielle','Dictée vocale','Notifications sur le téléphone','Modules'])if(!titres.includes(t))err.push('section absente : '+t);
 if(await p.evaluate(()=>document.scrollingElement.scrollWidth>innerWidth+1))err.push('déborde en largeur');
 await p.screenshot({path:`${sortie}/branchements-${nom}.png`,fullPage:true});
 // Agenda iCal (première passe seulement : la seconde le retrouve déjà branché).
 if(nom==='pc'){
  await p.click('h2:has-text("Agendas") button');await p.click('.br-fournisseur:has-text("Lien iCal")');
  await p.fill('input[aria-label^="Lien iCal"]','http://127.0.0.1:8588/a.ics');await p.click('button:has-text("Tester et brancher")');
  await p.waitForSelector('.toast:has-text("Agenda branché")');
 }
 await p.waitForSelector('.br-ligne:has-text("Lien iCal")');const ligneAg=await p.textContent('.br-ligne:has-text("Lien iCal")');if(!/2 événements/.test(ligneAg))err.push('agenda : '+ligneAg);
 // IA : adresse, essai, liste des modèles.
 await p.fill('input[aria-label="Adresse du service"]','http://127.0.0.1:8588/v1');await p.click('button:has-text("Enregistrer et tester") >> nth=0');
 await p.waitForSelector('.br-message.ok');const msgIA=await p.textContent('.br-message.ok');if(!/2 modèles.*llama-test/.test(msgIA))err.push('ia : '+msgIA);
 // Boîte mail injoignable : message clair, la fenêtre reste ouverte, rien n'est ajouté.
 await p.click('h2:has-text("Boîtes mail") button');await p.click('.br-fournisseur:has-text("Autre serveur IMAP")');
 await p.fill('input[aria-label="Adresse mail"]','moi@exemple.test');await p.fill('input[aria-label="Mot de passe"]','x');
 await p.fill('input[aria-label="Serveur IMAP"]','127.0.0.1');await p.fill('input[aria-label="Port"]','1');
 await p.click('button:has-text("Tester et ajouter")');await p.waitForSelector('dialog .br-message.erreur');
 const msgMail=await p.textContent('dialog .br-message.erreur');if(!/injoignable/.test(msgMail))err.push('mail : '+msgMail);
 await p.screenshot({path:`${sortie}/branchements-mail-${nom}.png`});await p.click('dialog button:has-text("Annuler")');
 if(await p.locator('.br-ligne:has-text("moi@exemple.test")').count())err.push('boîte ajoutée malgré l\'échec');
 // L'événement externe dans l'Agenda : marqué, et en lecture seule.
 await p.goto(U+'/#agenda');await p.click('.segments button:has-text("Liste")');await p.waitForSelector('.ag-ligne.externe');
 const premier=await p.textContent('.ag-ligne.externe >> nth=0');if(!/Journée.*Congés test/.test(premier))err.push('journée pas en tête : '+premier);
 await p.click('.ag-ligne.externe:has-text("Dentiste test")');await p.waitForSelector('dialog:has-text("lecture seule")');
 const fiche=await p.textContent('dialog');if(!/09:00 – 10:00/.test(fiche)||!/Apporter la carte/.test(fiche)||!/Cabinet/.test(fiche))err.push('fiche : '+fiche);
 if(await p.locator('dialog button:has-text("Supprimer")').count())err.push('externe supprimable');
 await p.screenshot({path:`${sortie}/agenda-externe-${nom}.png`});await p.click('dialog button:has-text("Fermer")');
 // Accueil : la journée entière en tête de « Ta journée » si c'est aujourd'hui (ici demain : rien à vérifier), pas de « null ».
 await p.goto(U+'/#accueil');await p.waitForSelector('.salut');if(/\bnull\b|undefined/.test(await p.textContent('main')))err.push('null affiché');
 // Module coupé dans l'interface : il disparaît du menu après rechargement.
 if(nom==='pc'){
  await p.goto(U+'/#reglages');await p.waitForSelector('.br-zone section');
  await p.click('.reglage:has-text("Tâches") .interrupteur');await p.waitForSelector('.toast:has-text("Tâches coupé")');
  await p.reload();await p.waitForSelector('nav');if(await p.locator('nav a[href="#taches"]').count())err.push('Tâches encore au menu');
  await p.goto(U+'/#reglages');await p.waitForSelector('.br-zone section');await p.click('.reglage:has-text("Tâches") .interrupteur');await p.waitForSelector('.toast:has-text("Tâches activé")');
 }
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();fin(tot?1:0)})().catch(e=>{console.error(e);fin(1)});
