// Clavier sur une confirmation, réponses simulées : node tests/confirmation-clavier.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');const {chromium}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-'));const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8599','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8599',POSTE_ORIGINES:'http://127.0.0.1:8599',POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0'},stdio:'ignore'});const U='http://127.0.0.1:8599';
(async()=>{let ok=false;for(let i=0;i<40&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});const c=await b.newContext({viewport:{width:1280,height:800}});const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push(e.message));
let n=0,choix=[],attente=true,pret=false;const ouvrir=()=>({request_id:'q'+n,description:'Exécuter : git push',habitude:null,explication:pret?'Pourquoi : envoyer ton travail.\nCe que ça fait : modifie le dépôt distant.':null,explication_prete:pret});
await c.route('**/api/hermes/**',r=>{const u=new URL(r.request().url()).pathname;const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
 if(u.endsWith('/modele'))return j({actif:'x',pret:true,choix:[]});if(u.endsWith('/flux'))return;
 if(u.endsWith('/conversations'))return j([{id:'a',titre:'Essai',date:1,epinglee:false,run:'r',attente:attente}]);
 if(u.endsWith('/conversations/a'))return j([{role:'user',texte:'Pousse mon code'}]);
 if(u.endsWith('/decision')){choix.push(r.request().postDataJSON().choix);attente=false;return j({})}
 if(u.endsWith('/executions/r'))return j({statut:'running',sortie:null,approbation:attente?ouvrir():null});return j([])});
await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');await p.goto(U+'/#hermes');await p.waitForSelector('.decision');
await p.keyboard.press('Enter');await p.waitForTimeout(100);if(choix.length)err.push('Entrée immédiate acceptée');
await p.waitForTimeout(900);await p.click('.saisie textarea');await p.keyboard.type('mon texte');await p.keyboard.press('Enter');await p.keyboard.press('Backspace');await p.waitForTimeout(150);if(choix.length)err.push('touches pendant la saisie: '+choix);
if(await p.inputValue('.saisie textarea')!=='mon text')err.push('retour arrière volé: '+await p.inputValue('.saisie textarea'));
pret=true;await p.waitForFunction(()=>document.querySelector('.explication').textContent.includes('Pourquoi'),null,{timeout:6000}).catch(()=>err.push('explication absente'));
if(!(await p.textContent('.action-exacte')).includes('git push'))err.push('action masquée');await p.screenshot({path:sortie+'/clavier.png'});
await p.fill('.saisie textarea','');await p.keyboard.press('Enter');await p.waitForFunction(()=>document.querySelector('.decision.repondue')).catch(()=>err.push('Entrée sans effet'));if(choix[0]!=='once')err.push('choix '+choix);
console.log(err.length?err:'ok');
// Puis Suppr et Retour arrière sur de nouvelles demandes.
for(const [t,att] of [['Delete','deny'],['Backspace','deny']]){n++;attente=true;choix=[];await p.reload();await p.waitForSelector('.decision:not(.repondue)');await p.waitForTimeout(800);await p.keyboard.press(t);await p.waitForTimeout(250);if(choix[0]!==att)err.push(t+' -> '+choix)}
console.log(err.length?err:'ok');await b.close();srv.kill();process.exit(err.length?1:0)})().catch(e=>{console.error(e.message);srv.kill();process.exit(2)})
