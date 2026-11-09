// Dictée dans Hermes avec une vraie voix (espeak-ng) et le vrai moteur de dictée : l'onde apparaît en haut de la barre,
// suit la voix, puis disparaît ; le texte arrive dans le champ. node tests/hermes-onde.cjs <dossier-captures>
const {spawn,execSync}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-onde-'));const wav=tmp+'/voix48.wav';
execSync(`espeak-ng -v fr -s 140 -w ${tmp}/voix.wav "Prépare-moi le résumé de la réunion de demain matin" && ffmpeg -loglevel error -y -i ${tmp}/voix.wav -af apad=pad_dur=3 -ar 48000 -ac 1 ${wav}`);
const U='http://127.0.0.1:8618';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8618','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_CLE:tmp+'/cle',POSTE_HOTES:'127.0.0.1:8618',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const fin=(c)=>{srv.kill();process.exit(c)};
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+wav,'--autoplay-policy=no-user-gesture-required']});
const c=await b.newContext({...devices['Pixel 7'],permissions:['microphone']});const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
// Hermes simulé (aucune vraie conversation touchée) ; la dictée, elle, est réelle.
await c.route('**/api/hermes/**',r=>{const u=new URL(r.request().url()).pathname;const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
 if(u.endsWith('/modele'))return j({actif:'a',pret:true,arrete:false,demarrable:true,choix:[{id:'a',nom:'A'}]});return j([])});
await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
await p.goto(U+'/#hermes');await p.waitForSelector('.saisie textarea');await p.waitForLoadState('networkidle');await p.waitForTimeout(1500);
await p.click('.saisie .micro[aria-label="Dicter"]');
try{await p.waitForSelector('.saisie .onde',{timeout:5000})}catch{err.push('pas d\'onde : '+await p.evaluate(()=>[document.querySelector('.saisie .micro')?.className,document.querySelector('.etat-dictee')?.textContent].join(' / ')))}
let max=0,parle=false;for(let i=0;i<30;i++){await p.waitForTimeout(100);const r=await p.evaluate(()=>{const o=document.querySelector('.saisie .onde');if(!o)return[0,false];return[Math.max(...[...o.children].map(i=>Number((i.style.transform.match(/scaleY\(([\d.]+)/)||[0,0])[1]))),o.classList.contains('parle')]});max=Math.max(max,r[0]);parle=parle||r[1];if(i===15)await p.screenshot({path:`${sortie}/hermes-onde.png`})}
if(max<0.3)err.push('onde immobile : '+max.toFixed(2));if(!parle)err.push('voix jamais détectée');
const largeur=await p.evaluate(()=>{const o=document.querySelector('.saisie .onde');const s=document.querySelector('.saisie');return o?Math.round(o.getBoundingClientRect().width/s.getBoundingClientRect().width*100):0});if(largeur<80)err.push('onde pas en pleine largeur : '+largeur+'%');
await p.waitForFunction(()=>/r[ée]union/i.test(document.querySelector('.saisie textarea').value),null,{timeout:15000}).catch(()=>err.push('texte non dicté'));
await p.click('.saisie .micro.actif');await p.waitForSelector('.saisie .onde',{state:'detached',timeout:8000}).catch(()=>err.push('onde restée'));
console.log('onde max',max.toFixed(2),'texte :',await p.inputValue('.saisie textarea'));
// Accueil, « Dis-le à Hermes » : barre compacte en bas qui lance la dictée ; l'onde est dessous, en pleine largeur, sans écraser le champ.
await p.goto(U+'/#accueil');await p.waitForSelector('.salut');await p.waitForLoadState('networkidle');await p.waitForTimeout(800);
await p.click('.fab');await p.waitForSelector('dialog.dis-le .dis-le-barre.dicte > .onde',{timeout:6000}).catch(()=>err.push('pas d\'onde dans « Dis-le à Hermes »'));await p.waitForTimeout(1200);
const g=await p.evaluate(()=>{const c=document.querySelector('dialog .dis-le-barre');const hd=document.querySelector('dialog.dis-le').getBoundingClientRect();const o=c?.querySelector('.onde')?.getBoundingClientRect();const t=c?.querySelector('textarea, input')?.getBoundingClientRect();const r=c?.getBoundingClientRect();return o&&t?{onde:Math.round(o.width/r.width*100),champ:Math.round(t.width/r.width*100),sous:o.top>=t.bottom-1,hauteur:Math.round(hd.height),basEcran:Math.round(innerHeight-hd.bottom)}:null});
console.log('fenêtre',JSON.stringify(g));if(!g||g.onde<80||g.champ<50||!g.sous||g.hauteur>130||g.basEcran>60)err.push('onde mal placée dans la fenêtre : '+JSON.stringify(g));
await p.screenshot({path:`${sortie}/dis-le-onde.png`});await p.click('dialog .micro.actif').catch(()=>{});console.log(err.length?err:'ok');await b.close();fin(err.length?1:0)})().catch(e=>{console.error(e);fin(1)});
