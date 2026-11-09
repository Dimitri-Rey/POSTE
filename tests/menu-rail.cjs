// Menu PC : barre d'icônes toujours étroite, nom en bulle au survol ; téléphone inchangé. Usage : node tests/menu-rail.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const tmp=fs.mkdtempSync(os.tmpdir()+'/mr');const sortie=process.argv[2]||tmp;const U='http://127.0.0.1:8576';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8576','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8576',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
(async()=>{for(let i=0;i<60;i++){if(await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,250))}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1440,height:900}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');await p.waitForTimeout(600);
 const bulle=(sel)=>p.evaluate(s=>{const t=document.querySelector(s+' .nav-texte');const r=t.getBoundingClientRect();return {op:+getComputedStyle(t).opacity,x:r.left,txt:t.textContent}},sel);
 if(nom==='pc'){
  const largeur=await p.evaluate(()=>document.querySelector('nav').getBoundingClientRect().width);
  if(largeur>70)err.push('barre trop large '+largeur);
  if((await bulle('nav a[href="#mails"]')).op!==0)err.push('nom visible sans survol');
  await p.hover('nav a[href="#mails"]');await p.waitForTimeout(250);
  const m=await bulle('nav a[href="#mails"]');if(m.op!==1||m.x<64||m.txt!=='Mails')err.push('bulle mails '+JSON.stringify(m));
  await p.screenshot({path:`${sortie}/menu-mails.png`,clip:{x:0,y:0,width:420,height:420}});
  await p.hover('.nav-recherche');await p.waitForTimeout(250);
  const r=await bulle('.nav-recherche');if(r.op!==1||!r.txt.startsWith('Rechercher'))err.push('bulle recherche');
  await p.screenshot({path:`${sortie}/menu-recherche.png`,clip:{x:0,y:0,width:420,height:200}});
  await p.click('nav a[href="#mails"]');await p.waitForSelector('main h1:has-text("Mails")');
  await p.mouse.move(800,500);await p.waitForTimeout(250);
  if((await bulle('nav a[href="#mails"]')).op!==0)err.push('bulle restée');
  // Au clavier, la bulle suit le focus.
  await p.focus('nav a[href="#agenda"]');await p.keyboard.press('Tab');await p.keyboard.press('Shift+Tab');await p.waitForTimeout(250);
  if((await bulle('nav a[href="#agenda"]')).op!==1)err.push('bulle au clavier');
  await p.screenshot({path:`${sortie}/menu-page.png`});
  // Le style de la barre ne doit toucher aucune autre balise nav (l'arbre des Fichiers en est une).
  await p.goto(U+'/#fichiers');await p.waitForSelector('.fx-arbre');
  const arbre=await p.evaluate(()=>document.querySelector('.fx-arbre').getBoundingClientRect().width);
  if(arbre<200)err.push('arbre des fichiers écrasé '+arbre);
 }else{
  if(await p.evaluate(()=>getComputedStyle(document.querySelector('nav a[href="#mails"] .nav-texte')).position)==='absolute')err.push('bulles sur téléphone');
  await p.screenshot({path:`${sortie}/menu-mobile.png`});
 }
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
