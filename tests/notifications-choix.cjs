// Réglages → Notifications : tout couper, choisir par type ; bandeau dans l'appli à la place de la notification du téléphone.
// node tests/notifications-choix.cjs
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-notif-'));const U='http://127.0.0.1:8584';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8584','--app-dir','api'],{env:{...process.env,POSTE_CONFIG:path.resolve('tests/reglages-test.toml'),POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8584',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;let premier=true;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.goto(U+'/#reglages');await p.waitForSelector('.alertes .reglage');
 const section=p.locator('section:has(> h2:text-is("Notifications"))');
 const noms=await section.locator('.reglage strong').allTextContents();
 for(const n of ['Recevoir les notifications','Nouveaux mails importants','Hermes attend ta confirmation','Rappels de rendez-vous','Alertes serveur'])if(!noms.includes(n))err.push('manque '+n);
 const api=()=>p.evaluate(()=>fetch('/api/connecteurs/alertes').then(r=>r.json()));
 // Couper un type
 const mails=section.locator('input[aria-label="Nouveaux mails importants"]');
 if(premier){if(!await mails.isChecked())err.push('mails coupé au départ');await mails.click();await p.waitForTimeout(400);
  if((await api()).types.find(t=>t.id==='mails').actif)err.push('mails pas coupé côté serveur');}
 // Tout couper : les types sont grisés et inactifs
 const tout=section.locator('input[aria-label="Recevoir les notifications"]');
 if(await tout.isChecked()!==true)err.push('recevoir coupé au départ');
 await tout.click();await p.waitForTimeout(400);
 if((await api()).recevoir)err.push('recevoir pas coupé côté serveur');
 if(!await section.locator('input[aria-label="Alertes serveur"]').isDisabled())err.push('type actif alors que tout est coupé');
 if(nom==='mobile')await p.screenshot({path:path.join(tmp,'reglages-notifs.png'),fullPage:false});
 await section.locator('input[aria-label="Recevoir les notifications"]').click();await p.waitForTimeout(400);
 if(!(await api()).recevoir)err.push('recevoir pas remis');
 // Rechargé : le choix tient
 await p.reload();await p.waitForSelector('.alertes .reglage');
 if(await p.locator('.alertes input[aria-label="Nouveaux mails importants"]').isChecked())err.push('choix mails perdu au rechargement');
 // Bandeau dans l'appli (appelé par l'APK quand Poste est à l'écran)
 await p.evaluate(()=>window.posteNotif('Alerte serveur','Disque presque plein','/#serveur'));
 const t=p.locator('.toast');await t.waitFor({timeout:2000}).catch(()=>err.push('pas de bandeau'));
 if(!/Alerte serveur · Disque presque plein/.test(await t.textContent().catch(()=>'')))err.push('texte bandeau');
 await t.locator('button:has-text("Voir")').click();await p.waitForTimeout(300);
 if(!(await p.evaluate(()=>location.hash)).startsWith('#serveur'))err.push('Voir n\'ouvre pas la page');
 // Déjà sur la page concernée : pas de bandeau
 await p.evaluate(()=>document.querySelector('.toast')?.remove());
 await p.evaluate(()=>window.posteNotif('Alerte serveur','GPU chaud','/#serveur'));await p.waitForTimeout(300);
 if(await p.locator('.toast').count())err.push('bandeau sur la page concernée');
 console.log(nom,err.length?err:'ok');tot+=err.length;premier=false;await c.close()}
console.log('capture',path.join(tmp,'reglages-notifs.png'));
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
