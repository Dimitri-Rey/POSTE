// Historique Hermes : choisir plusieurs conversations et les supprimer. Usage : node tests/hermes-selection.cjs <dossier-captures>
const {chromium,devices}=require(process.env.PLAYWRIGHT);const {spawn}=require('child_process');const fs=require('fs'),os=require('os');
const P='http://127.0.0.1:8581';const tmp=fs.mkdtempSync(os.tmpdir()+'/hs');const sortie=process.argv[2]||tmp;
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8581','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8581',POSTE_ORIGINES:P,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const t=Date.now()/1000;const json=(r,o,s=200)=>r.fulfill({status:s,contentType:'application/json',body:JSON.stringify(o)});
(async()=>{for(let i=0;i<60;i++){if(await fetch(P+'/api/auth/etat').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,250))}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 let convs=[1,2,3,4,5].map(i=>({id:'c'+i,titre:'Conversation '+i,date:t-i*3600,epinglee:false,run:i===5?'r5':null,attente:false,question:null}));const supprimes=[];
 await p.route(/\/api\/hermes\/conversations(\?.*)?$/,r=>json(r,convs));
 await p.route(/\/api\/hermes\/conversations\/c\d$/,r=>{const id=r.request().url().split('/').pop();
  if(r.request().method()==='DELETE'){supprimes.push(id);if(id==='c3'&&nom==='mobile')return json(r,{detail:'Hermes travaille encore dans cette conversation'},409);convs=convs.filter(x=>x.id!==id);return json(r,{ok:true})}
  return json(r,[{role:'user',texte:'Bonjour'},{role:'assistant',texte:'Salut'}])});
 await p.route(/\/api\/hermes\/executions\/r5(\/.*)?$/,r=>r.request().url().endsWith('/flux')?r.abort():json(r,{statut:'running',sortie:'',approbation:null}));
 await p.goto(P);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.evaluate(()=>sessionStorage.setItem('hermes-conversation','c4'));await p.goto(P+'/#hermes');await p.waitForSelector('.conv',{state:'attached'});
 if(nom==='pc'){
  await p.click('.recherche-conv button:has-text("Sélectionner")');
  if(await p.locator('.conv .case-conv').count()!==5)err.push('cases');
  if(!(await p.locator('.conv:has-text("Conversation 5")').isDisabled()))err.push('en cours sélectionnable');
  if(!(await p.locator('.barre-selection button[aria-label="Supprimer la sélection"]').isDisabled()))err.push('supprimer actif sans choix');
  await p.click('.conv:has-text("Conversation 1")');await p.click('.conv:has-text("Conversation 2")');
  if((await p.textContent('.barre-selection [role=status]'))!=='2 sélectionnées')err.push('compte');
  if(await p.locator('.fil .bulle').count()!==2)err.push('une conversation s\'est ouverte');
  await p.click('.barre-selection button[aria-label="Supprimer la sélection"]');
  await p.waitForTimeout(3600); // la liste se recharge toutes les 3 s : la confirmation doit tenir
  if((await p.textContent('.barre-selection [role=status]'))!=='Supprimer 2 conversations ?')err.push('confirmation perdue');
  if((await p.textContent('.barre-selection')).includes('null'))err.push('null affiché');
  await p.screenshot({path:`${sortie}/hermes-selection-pc.png`});await p.click('.barre-selection button:has-text("Annuler")');await p.screenshot({path:`${sortie}/hermes-selection-pc-0.png`});await p.click('.barre-selection button[aria-label="Supprimer la sélection"]');
  await p.click('.barre-selection button.fort');await p.waitForSelector('.barre-selection',{state:'hidden'});
  if(supprimes.join()!=='c1,c2')err.push('supprimés '+supprimes);
  if(await p.locator('.conv:has-text("Conversation 1"), .conv:has-text("Conversation 2")').count())err.push('encore listées');
  if(await p.locator('.case-conv').count())err.push('toujours en sélection');
 }else{
  await p.click('.ouvrir-volet');await p.waitForSelector('.volet.ouvert');
  // Appui long : passe en sélection avec cette conversation cochée, sans l'ouvrir.
  const l=p.locator('.conv:has-text("Conversation 3")');const bx=await l.boundingBox();
  await p.touchscreen.tap(bx.x+bx.width/2,bx.y+bx.height/2); // un simple appui ouvre…
  await p.waitForSelector('.titre-conv:has-text("Conversation 3")');await p.click('.ouvrir-volet');
  await p.evaluate(()=>{const e=document.querySelector('.conv.actif');const o={pointerType:'touch',bubbles:true};e.dispatchEvent(new PointerEvent('pointerdown',o))});
  await p.waitForTimeout(700);
  await p.evaluate(()=>{const e=document.querySelector('.conv.choisie');e?.dispatchEvent(new PointerEvent('pointerup',{pointerType:'touch',bubbles:true}))});
  if((await p.textContent('.barre-selection [role=status]'))!=='1 sélectionnée')err.push('appui long');
  await p.click('.barre-selection button:has-text("Tout")');
  if((await p.textContent('.barre-selection [role=status]'))!=='4 sélectionnées')err.push('tout '+await p.textContent('.barre-selection [role=status]'));
  await p.screenshot({path:`${sortie}/hermes-selection-mobile.png`});
  await p.click('.barre-selection button[aria-label="Supprimer la sélection"]');await p.click('.barre-selection button.fort');
  await p.waitForSelector('.barre-selection .erreur');
  const msg=await p.textContent('.barre-selection .erreur');if(!msg.startsWith('3 supprimées, 1 refusée'))err.push('message '+msg);
  if((await p.textContent('.barre-selection [role=status]'))!=='1 sélectionnée')err.push('refusée plus cochée');
  if(await p.locator('.conv').count()!==2)err.push('restantes '+await p.locator('.conv').count());
  await p.screenshot({path:`${sortie}/hermes-selection-mobile-2.png`});
  await p.click('.barre-selection button[aria-label="Supprimer la sélection"]');await p.click('.barre-selection button:has-text("Annuler")');
  if((await p.textContent('.barre-selection [role=status]'))!=='1 sélectionnée')err.push('annuler la confirmation');
  await p.click('.barre-selection button[aria-label="Quitter la sélection"]');if(await p.locator('.case-conv').count())err.push('quitter');
  if(!(await p.locator('.recherche-conv button:has-text("Sélectionner")').isVisible()))err.push('bouton Sélectionner absent');
 }
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();process.exitCode=tot?1:0})().catch(e=>{console.log('ÉCHEC',String(e).slice(0,400));process.exitCode=1}).finally(()=>{srv.kill();setTimeout(()=>process.exit(),200)});
