// Hermes sur PC : replier et rouvrir la colonne de l'historique (retenu au rechargement). Usage : node tests/hermes-volet.cjs <dossier-captures>
const {chromium,devices}=require(process.env.PLAYWRIGHT);const {spawn}=require('child_process');const fs=require('fs'),os=require('os');
const P='http://127.0.0.1:8577';const tmp=fs.mkdtempSync(os.tmpdir()+'/hv');const sortie=process.argv[2]||tmp;
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8577','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8577',POSTE_ORIGINES:P,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const json=(r,o)=>r.fulfill({contentType:'application/json',body:JSON.stringify(o)});
(async()=>{for(let i=0;i<60;i++){if(await fetch(P+'/api/auth/etat').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,250))}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 await c.route(/\/api\/hermes\/modele$/,r=>json(r,{actif:'vision',pret:true,arrete:false,demarrable:true,vision:true,choix:[{id:'vision',nom:'Vision',vision:true}]}));
 await c.route(/\/api\/hermes\/habitudes$/,r=>json(r,[]));
 await c.route(/\/api\/hermes\/conversations(\?.*)?$/,r=>json(r,[{id:'c1',titre:'Une conversation',date:Date.now()/1000,epinglee:false,run:null,attente:false}]));
 await p.goto(P);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.goto(P+'/#hermes');await p.waitForSelector('.saisie');
 const bouton=p.locator('.basculer-volet');
 if(nom==='mobile'){ if(await bouton.isVisible())err.push('bouton visible sur téléphone'); }
 else{
  if(!(await p.locator('.volet').isVisible()))err.push('volet caché au départ');
  await bouton.click();
  if(await p.locator('.volet').isVisible())err.push('pas replié');
  if(!(await p.locator('.nouvelle-mobile').isVisible()))err.push('pas de + une fois replié');
  if((await bouton.getAttribute('aria-label'))!=="Afficher l'historique")err.push('étiquette');
  await p.screenshot({path:`${sortie}/volet-replie.png`});
  await p.reload();await p.waitForSelector('.saisie');
  if(await p.locator('.volet').isVisible())err.push('pas retenu');
  await p.locator('.basculer-volet').click();
  if(!(await p.locator('.volet').isVisible()))err.push('pas rouvert');
  if(await p.locator('.nouvelle-mobile').isVisible())err.push('+ resté');
 }
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();process.exitCode=tot?1:0})().catch(e=>{console.log('ÉCHEC',String(e).slice(0,400));process.exitCode=1}).finally(()=>{srv.kill();setTimeout(()=>process.exit(),200)});
