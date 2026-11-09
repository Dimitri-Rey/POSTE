// La réponse de Hermes s'écrit au fil de l'eau (comme Claude), même quand le moteur l'envoie d'un bloc : texte qui grandit,
// curseur pendant l'écriture, texte complet et sans curseur à la fin. node tests/hermes-ecriture.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-ecr-'));const U='http://127.0.0.1:8619';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8619','--app-dir','api'],{env:{...process.env,POSTE_CONFIG:path.resolve('tests/reglages-test.toml'),POSTE_CLE:tmp+'/cle',POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8619',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const fin=(c)=>{srv.kill();process.exit(c)};
const MESURES={lecture:{tokens:12340,caches:9800,vitesse:2540},generation:{tokens:380,vitesse:42.2,secondes:9.1}};
const TEXTE=Array.from({length:14},(_,i)=>`Phrase numéro ${i+1} de la réponse, assez longue pour être lue.`).join(' ');
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});const c=await b.newContext(devices['Pixel 7']);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
let termine=false;
await c.route('**/api/hermes/**',r=>{const u=new URL(r.request().url()).pathname;const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
 if(u.endsWith('/modele'))return j({actif:'a',pret:true,arrete:false,demarrable:true,choix:[{id:'a',nom:'A'}]});
 if(u.endsWith('/envoyer'))return j({run_id:'r',conversation:'c1'});
 if(u.endsWith('/flux')){termine=true;return r.fulfill({status:200,contentType:'text/event-stream',body:`data: ${JSON.stringify({event:'message.delta',delta:TEXTE})}\n\ndata: ${JSON.stringify({event:'poste.mesures',...MESURES})}\n\ndata: ${JSON.stringify({event:'run.completed',output:TEXTE})}\n\n`})}
 if(u.endsWith('/executions/r'))return j({statut:termine?'completed':'running',sortie:termine?TEXTE:null});
 if(u.includes('/conversations'))return j(u.endsWith('/conversations')?[]:{messages:[]});
 return j([])});
await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
await p.goto(U+'/#hermes');await p.waitForSelector('.saisie textarea');await p.waitForLoadState('networkidle');await p.waitForTimeout(800);
await p.fill('.saisie textarea','Explique-moi');await p.click('.saisie button.envoyer-rond');
const longueurs=[];let curseur=false;
for(let i=0;i<30;i++){await p.waitForTimeout(80);const r=await p.evaluate(()=>{const b=[...document.querySelectorAll('.bulle.assistant')].pop();return b?[b.textContent.length,b.classList.contains('ecrit')]:[0,false]});longueurs.push(r[0]);curseur=curseur||r[1];if(i===6)await p.screenshot({path:`${sortie}/hermes-ecriture.png`})}
const etapes=new Set(longueurs.filter(l=>l>0&&l<TEXTE.length)).size;
if(etapes<5)err.push('pas d\'écriture progressive : '+longueurs.join(','));if(!curseur)err.push('pas de curseur');
await p.waitForFunction(t=>{const b=[...document.querySelectorAll('.bulle.assistant')].pop();return b&&b.textContent.length===t&&!b.classList.contains('ecrit')},TEXTE.length,{timeout:8000}).catch(()=>err.push('texte incomplet ou curseur resté'));
// Vitesses : lecture au-dessus de la question, génération sous la réponse, en petit.
const lignes=await p.evaluate(()=>{const l=document.querySelector('.mesure-ia.lecture');const g=document.querySelector('.mesure-ia.generation');return{lecture:l?.textContent,avantQuestion:l?.nextElementSibling?.classList.contains('user'),generation:g?.textContent,apresReponse:g?.previousElementSibling?.classList.contains('assistant')}});
if(!/12\u202f?340|12 340/.test(lignes.lecture||'')||!/2\u202f?540|2 540/.test(lignes.lecture||'')||!lignes.avantQuestion)err.push('lecture : '+JSON.stringify(lignes));
if(!/42,2 tok\/s/.test(lignes.generation||'')||!lignes.apresReponse)err.push('génération : '+JSON.stringify(lignes));
await p.screenshot({path:`${sortie}/hermes-mesures.png`});
console.log('mesures',JSON.stringify(lignes));
console.log('étapes visibles',etapes,'longueur finale',TEXTE.length);console.log(err.length?err:'ok');await b.close();fin(err.length?1:0)})().catch(e=>{console.error(e);fin(1)});
