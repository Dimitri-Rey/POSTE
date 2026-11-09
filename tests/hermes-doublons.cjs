// Une exécution finie mais encore listée « en cours » ne doit rien afficher en double. Usage : node tests/hermes-doublons.cjs
const {chromium}=require(process.env.PLAYWRIGHT);const {spawn}=require('child_process');const fs=require('fs'),os=require('os');
const P='http://127.0.0.1:8598';const tmp=fs.mkdtempSync(os.tmpdir()+'/hd');
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8598','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8598',POSTE_ORIGINES:P,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
(async()=>{for(let i=0;i<60;i++){if(await fetch(P+'/api/auth/etat').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,250))}
const b=await chromium.launch({executablePath:process.env.CHROME});const p=await (await b.newContext({viewport:{width:412,height:900}})).newPage();
let etat='completed';const json=(r,o)=>r.fulfill({contentType:'application/json',body:JSON.stringify(o)});
await p.route(/\/api\/hermes\/conversations(\?.*)?$/,r=>r.request().method()==='GET'?json(r,[{id:'c',titre:'Essai',date:1,run:'r1',question:'Oui',attente:false}]):r.continue());
await p.route(/\/api\/hermes\/conversations\/c$/,r=>json(r,[{role:'user',texte:'Installe'},{role:'assistant',texte:'Plan'},{role:'user',texte:'Oui'},{role:'assistant',texte:'Fait'}]));
await p.route(/\/api\/hermes\/executions\/r1$/,r=>json(r,{statut:etat,sortie:'Fait',approbation:null}));
await p.route(/\/api\/hermes\/executions\/r1\/flux$/,r=>r.abort());
await p.goto(P);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
await p.evaluate(()=>sessionStorage.setItem('hermes-conversation','c'));await p.goto(P+'/#hermes');await p.waitForSelector('.saisie');await p.waitForTimeout(4500);
const textes=await p.locator('.bulle').allTextContents();console.log(JSON.stringify(textes));const ok=textes.filter(t=>t.trim()==='Oui').length===1&&textes.filter(t=>t.trim()==='Fait').length===1;console.log(ok?'OK   rien en double':'ÉCHEC doublons');await b.close();process.exitCode=ok?0:1})().catch(e=>{console.log('ÉCHEC',String(e).slice(0,300));process.exitCode=1}).finally(()=>{srv.kill();setTimeout(()=>process.exit(),200)});
