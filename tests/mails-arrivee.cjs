// Arrivée d'un mail à l'écran (réponses simulées) : pastille sur « Mails », liste rechargée seule, nouveau mail signalé.
// node tests/mails-arrivee.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-arr-'));fs.writeFileSync(tmp+'/poste.toml','');const U='http://127.0.0.1:8613';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8613','--app-dir','api'],{env:{...process.env,POSTE_CONFIG:tmp+'/poste.toml',POSTE_CLE:tmp+'/cle',POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8613',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const fin=(c)=>{srv.kill();process.exit(c)};
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 const t0=Date.now()/1000;const mail=(uid,sujet,ts)=>({compte:'c',uid,de:`Paul <paul@exemple.fr>`,sujet,ts,lu:0,important:1,alertes:[]});
 const S={jeton:'a',nouveaux:0,liste:[mail(1,'Premier',t0-3600)],synchros:0};
 await c.route('**/api/mails**',r=>{const u=new URL(r.request().url());const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
  if(u.pathname==='/api/mails/point')return j({point:null,genere_le:Date.now()/1000,a_jour:true,chiffres:{jour:{total:0,non_lus:0,importants:0,importants_non_lus:0},semaine:{total:0,non_lus:0,importants:0,importants_non_lus:0}},en_cours:false});
  if(u.pathname==='/api/mails/comptes')return j([{id:'c',adresse:'moi@exemple.fr'}]);
  if(u.pathname==='/api/mails/etat')return j({jeton:S.jeton,nouveaux:S.nouveaux,synchro_le:Date.now()/1000});
  if(u.pathname==='/api/mails/synchroniser'){S.synchros++;return j({lance:true})}
  if(u.pathname==='/api/mails')return j(S.liste);
  return r.continue()});
 const reveil=()=>p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');await p.waitForSelector('.salut');
 // Un mail arrive pendant qu'on est sur l'accueil.
 S.jeton='b';S.nouveaux=2;S.liste=[mail(2,'Arrivé à l\'instant',t0),...S.liste];await reveil();
 try{await p.waitForSelector('nav a[href="#mails"] .pastille-nb',{timeout:5000})}catch{err.push('pas de pastille')}
 const texte=await p.textContent('nav a[href="#mails"] .pastille-nb').catch(()=>'');if(texte!=='2')err.push('pastille : '+texte);
 if(S.synchros<1)err.push('pas de vérification au retour');
 await p.screenshot({path:`${sortie}/arrivee-pastille-${nom}.png`});
 // On ouvre Mails : la pastille s'en va, l'état s'affiche.
 await p.click('nav a[href="#mails"]');await p.waitForSelector('.ligne.mail');S.nouveaux=0;
 if(await p.locator('nav a[href="#mails"] .pastille-nb').count())err.push('pastille restée sur Mails');
 try{await p.waitForSelector('.etat-mails:has-text("À jour à")',{timeout:5000})}catch{err.push('état absent')}
 // Un autre arrive pendant qu'on regarde la liste : elle se recharge seule, le nouveau est signalé.
 S.jeton='c';S.liste=[mail(3,'Encore un',t0+5),...S.liste];await reveil();
 try{await p.waitForSelector('.ligne.mail.arrive:has-text("Encore un")',{timeout:5000})}catch{err.push('liste non rechargée')}
 const n=await p.locator('.ligne.mail').count();if(n!==3)err.push('lignes : '+n);
 await p.screenshot({path:`${sortie}/arrivee-liste-${nom}.png`});
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();fin(tot?1:0)})().catch(e=>{console.error(e);fin(1)});
