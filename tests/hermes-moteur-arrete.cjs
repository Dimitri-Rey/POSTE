// Moteur IA arrêté : la page Hermes le dit (et pas « en train de charger »), propose de le démarrer, puis suit le chargement.
// node tests/hermes-moteur-arrete.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-mot-'));const U='http://127.0.0.1:8617';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8617','--app-dir','api'],{env:{...process.env,POSTE_CONFIG:path.resolve('tests/reglages-test.toml'),POSTE_CLE:tmp+'/cle',POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8617',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const fin=(c)=>{srv.kill();process.exit(c)};
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});const c=await b.newContext(devices['Pixel 7']);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
const S={arrete:true,pret:false,demarrages:0};
await c.route('**/api/hermes/**',r=>{const u=new URL(r.request().url()).pathname;const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
 const modele=()=>({actif:'rapide',pret:S.pret,arrete:S.arrete,demarrable:true,choix:[{id:'rapide',nom:'Rapide'}]});
 if(u.endsWith('/modele'))return j(modele());
 if(u.endsWith('/moteur/demarrer')){S.demarrages++;S.arrete=false;return j(modele())}
 return j([])});
await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');await p.goto(U+'/#hermes');
await p.waitForSelector('.etat-moteur:not([hidden])',{timeout:6000});
const t1=await p.textContent('.etat-moteur');if(!/arrêté/.test(t1)||/charge le modèle/.test(t1))err.push('bandeau : '+t1);
await p.screenshot({path:sortie+'/hermes-moteur-arrete.png'});
await p.click('.etat-moteur button:has-text("Démarrer le moteur")');
await p.waitForFunction(()=>/charge le modèle/.test(document.querySelector('.etat-moteur').textContent),null,{timeout:8000}).catch(()=>err.push('pas de suivi du chargement'));
if(S.demarrages!==1)err.push('démarrages : '+S.demarrages);
S.pret=true;await p.waitForSelector('.etat-moteur[hidden]',{state:'attached',timeout:10000}).catch(async()=>err.push('bandeau resté : '+await p.evaluate(()=>{const e=document.querySelector('.etat-moteur');return e.hidden+' '+e.textContent})));
console.log(err.length?err:'ok');await b.close();fin(err.length?1:0)})().catch(e=>{console.error(e);fin(1)});
