// Installation minimale (aucun module facultatif) : le menu et les écrans n'en montrent rien. node tests/modules-coupes.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-min-'));fs.writeFileSync(tmp+'/poste.toml','');const U='http://127.0.0.1:8583';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8583','--app-dir','api'],{env:{...process.env,POSTE_CONFIG:tmp+'/poste.toml',POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8583',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');await p.waitForSelector('.salut');
 const liens=await p.$$eval('nav a',l=>l.map(a=>a.getAttribute('href')).join(' '));
 if(/hermes/.test(liens))err.push('menu: '+liens);
 if(await p.locator('.barre-hermes, .fab').count())err.push('Hermes sur l\'accueil');if(/\bnull\b|undefined/.test(await p.textContent('main')))err.push('null affiché');
 if(await p.locator('button.micro:visible').count())err.push('micro visible sans dictée');
 await p.screenshot({path:`${sortie}/minimal-${nom}.png`});
 await p.goto(U+'/#taches');await p.waitForSelector('.ajout-tache');
 await p.goto(U+'/#reglages');await p.waitForSelector('.reglage');if(await p.locator('h2:has-text("Strava")').count())err.push('Strava');
 await p.goto(U+'/#fichiers');await p.click('button:has-text("Nouveau")');const t=await p.$$eval('.fx-type-choix',l=>l.map(x=>x.textContent).join('|'));if(/Word|Excel|Diagramme/.test(t))err.push('types: '+t);
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
