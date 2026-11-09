// Hermes : une conversation s'ouvre sur ses derniers messages et y reste malgré les images ; remonter lire n'est pas contrarié. Usage : node tests/hermes-bas.cjs <dossier-captures>
const {chromium,devices}=require(process.env.PLAYWRIGHT);const {spawn}=require('child_process');const fs=require('fs'),os=require('os');
const P='http://127.0.0.1:8586';const tmp=fs.mkdtempSync(os.tmpdir()+'/hb');const sortie=process.argv[2]||tmp;
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8586','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8586',POSTE_ORIGINES:P,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const json=(r,o)=>r.fulfill({contentType:'application/json',body:JSON.stringify(o)});
const MSG=[];for(let i=0;i<30;i++){MSG.push({role:'user',texte:'Question '+i});MSG.push({role:'assistant',texte:('Réponse '+i+' : '+'blabla '.repeat(60))+(i===29?'\n\n![image](/api/fichiers/0123456789abcdef0123456789abcdef/x.png)':'')})}
(async()=>{for(let i=0;i<60;i++){if(await fetch(P+'/api/auth/etat').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,250))}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 await c.route(/\/api\/hermes\/modele$/,r=>json(r,{actif:'vision',pret:true,arrete:false,demarrable:true,vision:true,choix:[{id:'vision',nom:'V',vision:true}]}));
 await c.route(/\/api\/hermes\/habitudes$/,r=>json(r,[]));
 await c.route(/\/api\/hermes\/conversations(\?.*)?$/,r=>json(r,[{id:'c1',titre:'Longue conversation',date:1000,epinglee:false,run:null,attente:false}]));
 await c.route(/\/api\/hermes\/conversations\/c1$/,r=>json(r,MSG));
 await c.route(/\/api\/fichiers\//,async r=>{await new Promise(x=>setTimeout(x,600));r.fulfill({contentType:'image/png',body:fs.readFileSync('android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png')})});
 await p.goto(P);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.goto(P+'/#hermes');await p.waitForSelector('.saisie');
 const mesure=()=>p.evaluate(()=>{const f=document.querySelector('.fil');return {reste:Math.round(f.scrollHeight-f.scrollTop-f.clientHeight),haut:f.scrollHeight,vue:f.clientHeight,fenetre:Math.round(scrollY)}});
 if(nom==='mobile')await p.click('.ouvrir-volet');
 await p.click('.volet :text("Longue conversation")');await p.waitForSelector('.fil .bulle');
 const verifier=async(quand)=>{const m=await mesure();if(m.reste>2)err.push(quand+' '+JSON.stringify(m))};
 await verifier('ouverture');await p.waitForTimeout(2500);await verifier('après les images');
 await p.goto(P+'/#accueil');await p.waitForTimeout(300);await p.goto(P+'/#hermes');await p.waitForSelector('.fil .bulle');await p.waitForTimeout(2000);
 await verifier('retour sur la page');
 // Remonté pour relire : une image qui finit de charger ne ramène pas en bas.
 await p.evaluate(()=>{const f=document.querySelector('.fil');f.scrollTop=300;f.dispatchEvent(new Event('scroll'));const i=new Image();i.src='/api/fichiers/0123456789abcdef0123456789abcdef/y.png';f.querySelector('.bulle').append(i)});
 await p.waitForTimeout(1500);{const m=await mesure();if(m.reste<1000)err.push('ramené en bas pendant la lecture '+JSON.stringify(m))}
 await p.screenshot({path:`${sortie}/bas-${nom}.png`});console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
