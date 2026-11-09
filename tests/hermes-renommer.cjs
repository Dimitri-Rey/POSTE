// Hermes : renommer une conversation d'un clic sur son titre (Entrée valide, Échap annule). Usage : node tests/hermes-renommer.cjs [captures]
const {chromium,devices}=require(process.env.PLAYWRIGHT);const {spawn}=require('child_process');const fs=require('fs'),os=require('os');
const P='http://127.0.0.1:8562';const tmp=fs.mkdtempSync(os.tmpdir()+'/hr');const sortie=process.argv[2]||tmp;
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8562','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8562',POSTE_ORIGINES:P,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const json=(r,o)=>r.fulfill({contentType:'application/json',body:JSON.stringify(o)});
(async()=>{for(let i=0;i<60;i++){if(await fetch(P+'/api/auth/etat').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,250))}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 let titre='Friendly greeting';const patchs=[];
 await c.route(/\/api\/hermes\/modele$/,r=>json(r,{actif:'vision',pret:true,arrete:false,demarrable:true,vision:true,choix:[{id:'vision',nom:'Vision',vision:true}]}));
 await c.route(/\/api\/hermes\/habitudes$/,r=>json(r,[]));
 await c.route(/\/api\/hermes\/conversations(\?.*)?$/,r=>json(r,[{id:'c1',titre,date:1000,epinglee:false,run:null,attente:false}]));
 await c.route(/\/api\/hermes\/conversations\/c1$/,r=>{if(r.request().method()==='PATCH'){const d=JSON.parse(r.request().postData());patchs.push(d);titre=d.titre;return json(r,{ok:true})}return json(r,[{role:'user',texte:'Salut'},{role:'assistant',texte:'Bonjour !'}])});
 await p.goto(P);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.goto(P+'/#hermes');await p.waitForSelector('.titre-bouton');
 // Échap annule sans rien envoyer.
 await p.click('.titre-bouton');await p.waitForSelector('.titre-conv input');
 if((await p.inputValue('.titre-conv input'))!=='Friendly greeting')err.push('valeur de départ');
 await p.fill('.titre-conv input','Abandon');await p.keyboard.press('Escape');
 if(patchs.length||(await p.textContent('.titre-texte'))!=='Friendly greeting')err.push('Échap');
 // Entrée renomme.
 await p.click('.titre-bouton');await p.fill('.titre-conv input','Vidéo Luxembourg');await p.screenshot({path:`${sortie}/renommer-${nom}.png`});
 await p.keyboard.press('Enter');await p.waitForSelector('.titre-texte:has-text("Vidéo Luxembourg")');
 if(JSON.stringify(patchs)!=='[{"titre":"Vidéo Luxembourg"}]')err.push('envoi '+JSON.stringify(patchs));
 // Le nouveau nom est aussi dans l'historique.
 if(nom==='mobile')await p.click('.ouvrir-volet');
 await p.waitForSelector('.conv .titre:has-text("Vidéo Luxembourg")',{timeout:5000}).catch(()=>err.push('historique pas à jour'));
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();process.exitCode=tot?1:0})().catch(e=>{console.log('ÉCHEC',String(e).slice(0,400));process.exitCode=1}).finally(()=>{srv.kill();setTimeout(()=>process.exit(),200)});
