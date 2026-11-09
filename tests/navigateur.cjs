// Parcours navigateur sur une instance jetable : node tests/navigateur.cjs <dossier-captures>
const {spawn}=require('child_process');const {chromium,devices}=require(process.env.PLAYWRIGHT||'playwright');const os=require('os'),fs=require('fs'),path=require('path');
const sortie=process.argv[2]||'.';const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-'));
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8599','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8599',POSTE_ORIGINES:'http://127.0.0.1:8599',POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0'},stdio:'ignore'});
const U='http://127.0.0.1:8599';
(async()=>{let ok=false;for(let i=0;i<40&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let echec=0;
for(const [nom,ctx] of [['mobile',devices['Pixel 7']],['pc',{viewport:{width:1280,height:800}}]]){
const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>{err.push(e.message);console.log('PE',e.message)});p.on('requestfailed',r=>console.log('RF',r.url(),r.failure()?.errorText));p.on('response',r=>{if(r.status()>=400)console.log(r.status(),r.url())});p.on('console',m=>{if(m.type()==='error'){err.push(m.text());console.log('CE',m.text())}});
await p.goto(U);await p.waitForSelector('.seuil input');await p.screenshot({path:sortie+'/'+nom+'-seuil.png'});
const init=await p.evaluate(()=>fetch('/api/auth/etat').then(r=>r.json()));
await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
for(const v of (process.env.VUES||'accueil,hermes,mails,agenda,taches,serveur').split(',')){await p.goto(U+'/#'+v);await p.waitForTimeout(700);await p.screenshot({path:sortie+'/'+nom+'-'+v+'.png'});
const deb=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(deb){err.push(v+': débordement horizontal')}}
console.log(nom,err.length?err:'ok');echec+=err.length;await c.close()}
await b.close();srv.kill();process.exit(echec?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(2)});
