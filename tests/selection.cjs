// Panneau Sélection et archive zip, vrai serveur : node tests/selection.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-sel-'));
const U='http://127.0.0.1:8596';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8596','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8596',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 const d=`Lot-${nom}`;
 for(const [f,t] of [[`${d}/Photos/a.md`,'aaaa'],[`${d}/b.md`,'bb'],[`${d}/c.txt`,'c']])
  await p.evaluate(([f,t])=>fetch('/api/espace/fichier',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({chemin:f,contenu:t})}),[f,t]);
 const el=x=>`.fx-el[data-chemin="${x}"]`;
 await p.goto(U+'/#fichiers/d/'+d);await p.waitForSelector(el(`${d}/b.md`));
 if(nom==='pc'){
  await p.click(`${el(`${d}/Photos`)} .fx-date`);await p.click(`${el(`${d}/b.md`)} .fx-date`,{modifiers:['Control']});await p.click(`${el(`${d}/c.txt`)} .fx-poids`,{modifiers:["Control"]});
  await p.waitForSelector('.fx-selection:not([hidden])');
  const resume=await p.textContent('.fx-resume');if(resume!=='1 dossier · 2 fichiers · 7 o'||!(await p.textContent('.fx-statut')).includes('7 o'))err.push('résumé: '+resume);
  if(await p.locator('.fx-choisis li').count()!==3)err.push('liste');
  await p.screenshot({path:`${sortie}/selection-pc.png`});
  await p.click('.fx-choisis button[aria-label="Retirer c.txt de la sélection"]');
  if(await p.locator('.fx-choisis li').count()!==2)err.push('retrait');
  if(await p.locator(`${el(`${d}/c.txt`)}.choisi`).count())err.push('retrait non reporté dans la liste');
  await p.click('.fx-selection button:has-text("Compresser")');
 } else {
  await p.click(`${el(`${d}/Photos`)} .fx-case`);await p.click(`${el(`${d}/b.md`)} .fx-case`);
  if(!(await p.locator('.fx-selection').isHidden()))err.push('panneau sur téléphone');
  await p.click('.fx-actions button:has-text("Compresser")');
 }
 await p.waitForSelector('dialog input[aria-label="Nom de l\'archive"]');
 if(await p.inputValue('dialog input[aria-label="Nom de l\'archive"]')!==d)err.push('nom par défaut');
 await p.screenshot({path:`${sortie}/compresser-${nom}.png`});
 await p.fill('dialog input[aria-label="Nom de l\'archive"]','envoi');await p.click('dialog button:has-text("Créer")');
 await p.waitForSelector(`${el(`${d}/envoi.zip`)}.choisi`);
 if(!(await p.textContent('.fx-statut')).includes('Archive créée : envoi.zip'))err.push('statut');
 const zip=await p.evaluate(async x=>{const r=await fetch('/api/espace/telecharger?chemin='+encodeURIComponent(x));const a=new Uint8Array(await r.arrayBuffer());return String.fromCharCode(a[0],a[1])+new TextDecoder('latin1').decode(a)},`${d}/envoi.zip`);
 if(!zip.startsWith('PK')||!zip.includes('Photos/a.md')||!zip.includes('b.md')||zip.includes('c.txt'))err.push('contenu du zip');
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
