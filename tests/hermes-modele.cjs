// Choix du modèle dans l'en-tête de la discussion Hermes. Usage : node tests/hermes-modele.cjs <dossier-captures>
const {chromium,devices}=require(process.env.PLAYWRIGHT);const {spawn}=require('child_process');const fs=require('fs'),os=require('os');
const P='http://127.0.0.1:8578';const tmp=fs.mkdtempSync(os.tmpdir()+'/hm');const sortie=process.argv[2]||tmp;
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8578','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8578',POSTE_ORIGINES:P,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const json=(r,o,s=200)=>r.fulfill({status:s,contentType:'application/json',body:JSON.stringify(o)});
const CHOIX=[{id:'precis',nom:'Précis',vision:false},{id:'rapide',nom:'Rapide',vision:false},{id:'vision',nom:'Vision',vision:true}];
(async()=>{for(let i=0;i<60;i++){if(await fetch(P+'/api/auth/etat').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,250))}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 let etat={actif:'vision',pret:true,arrete:false,demarrable:true,vision:true,choix:CHOIX};const posts=[];
 await c.route(/\/api\/hermes\/modele$/,r=>{if(r.request().method()==='POST'){const m=JSON.parse(r.request().postData()).modele;posts.push(m);etat={...etat,actif:m,pret:false,vision:CHOIX.find(x=>x.id===m).vision}}return json(r,etat)});
 await c.route(/\/api\/hermes\/habitudes$/,r=>json(r,[]));
 await c.route(/\/api\/hermes\/conversations(\?.*)?$/,r=>json(r,[]));
 await p.goto(P);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.goto(P+'/#hermes');await p.waitForSelector('.choix-modele summary:has-text("Vision")');
 await p.click('.choix-modele summary');await p.waitForSelector('.choix-modele[open] .choix-modele-menu');
 if(await p.locator('.choix-modele-menu button').count()!==3)err.push('trois modèles');
 if((await p.getAttribute('.choix-modele-menu button:has-text("Vision")','aria-checked'))!=='true')err.push('coche');
 await p.screenshot({path:`${sortie}/modele-${nom}.png`});
 // Annuler la confirmation : rien ne bouge.
 p.once('dialog',d=>d.dismiss());await p.click('.choix-modele-menu button:has-text("Rapide") >> nth=0');await p.waitForTimeout(300);
 if(posts.length)err.push('basculé sans accord');
 // Accepter : bascule, « chargement… » dans l'en-tête, envoi bloqué.
 await p.click('.choix-modele summary');p.once('dialog',d=>{if(!d.message().includes('rechargement'))err.push('message');d.accept()});
 await p.click('.choix-modele-menu button:has-text("Précis") >> nth=0');
 await p.waitForSelector('.choix-modele summary:has-text("Précis")');await p.waitForSelector('.choix-modele-etat');
 if(posts.join()!=='precis')err.push('post '+posts);
 if(!(await p.locator('.saisie button[aria-label="Envoyer"]').isDisabled()))err.push('envoi possible pendant le chargement');
 // Clic ailleurs : le menu se ferme.
 await p.click('.choix-modele summary');await p.click('.fil',{force:true});if(await p.locator('.choix-modele[open]').count())err.push('menu resté ouvert');
 await p.screenshot({path:`${sortie}/modele-${nom}-charge.png`});
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();process.exitCode=tot?1:0})().catch(e=>{console.log('ÉCHEC',String(e).slice(0,400));process.exitCode=1}).finally(()=>{srv.kill();setTimeout(()=>process.exit(),200)});
