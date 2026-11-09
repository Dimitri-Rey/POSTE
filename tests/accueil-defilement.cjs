// Accueil bien rempli sur téléphone : on doit pouvoir descendre jusqu'en bas au doigt (vrais gestes tactiles),
// quel que soit l'endroit où le doigt se pose. node tests/accueil-defilement.cjs <dossier-captures>
// REEL=<dossier avec poste.toml et t.db> : mêmes gestes sur des données réelles (copie jetable).
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-acc-'));const U='http://127.0.0.1:8614';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8614','--app-dir','api'],{env:{...process.env,POSTE_CONFIG:process.env.REEL?process.env.REEL+'/poste.toml':path.resolve('tests/reglages-test.toml'),POSTE_CLE:tmp+'/cle',POSTE_BASE:process.env.REEL?process.env.REEL+'/t.db':tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8614',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const fin=(c)=>{srv.kill();process.exit(c)};
const t=Date.now()/1000;
const ACCUEIL={journal:Array.from({length:14},(_,i)=>({id:i,ts:t-i*600,source:['Mails','Hermes','Serveur'][i%3],titre:`Événement ${i}`,detail:'détail',lien:'#mails'})),
 rdv:[{id:1,titre:'Point',debut:new Date(Date.now()+36e5).toISOString().slice(0,16),lieu:'Visio'}],taches:[{id:1,titre:'Tâche du jour',echeance:new Date().toISOString().slice(0,10)}],
 mails:Array.from({length:8},(_,i)=>({compte:'gmail',uid:i,de:`Expéditeur ${i} <e${i}@exemple.fr>`,sujet:`Sujet important numéro ${i} assez long pour passer sur deux lignes`,ts:t-i*900})),
 serveur:{charge:3,coeurs:8,memoire:{total_go:32,utilise_go:8},gpu:null,disques:[{nom:'Système',libre_go:100,total_go:400}],services:[{id:'a',nom:'Service A',etat:'active'}]}};
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME,args:['--touch-events=enabled']});let tot=0;
for(const [nom,ctx,taille] of [['pixel7',devices['Pixel 7']],['petit',{...devices['Pixel 7'],viewport:{width:360,height:640}}],['grande',devices['Pixel 7'],'grande'],['tres',devices['Pixel 7'],'tres']]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 if(!process.env.REEL)await c.route('**/api/accueil',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(ACCUEIL)}));
 if(taille)await c.addInitScript(t=>localStorage.setItem('poste-taille-texte',t),taille);
 await p.goto(U);if(await p.locator('.seuil').count()){await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button')}await p.waitForSelector('.salut');await p.waitForTimeout(500);
 const cdp=await c.newCDPSession(p);
 const glisser=async(x,y1,y2)=>{await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:y1}]});
  for(let k=1;k<=12;k++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y1+(y2-y1)*k/12}]});await p.waitForTimeout(16)}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await p.waitForTimeout(600)};
 const pos=()=>p.evaluate(()=>{const m=document.querySelector('main');return{main:Math.round(m.scrollTop),doc:Math.round(document.scrollingElement.scrollTop),max:m.scrollHeight-m.clientHeight}});
 const h=ctx.viewport.height;
 // Régression : une étiquette « Hermes » du journal retirait les marges et le défilement de l'accueil.
 const marges=await p.evaluate(()=>{const s=getComputedStyle(document.querySelector('main'));return[parseFloat(s.paddingLeft),s.overflowY]});
 if(marges[0]<12||marges[1]!=='auto')err.push('marges ou défilement perdus : '+marges);
 for(const [quoi,x] of [['milieu',ctx.viewport.width/2],['bord',20]]){
  await p.evaluate(()=>document.querySelector('main').scrollTo(0,0));await p.waitForTimeout(200);
  const avant=await pos();for(let n=0;n<8;n++)await glisser(x,h*0.7,h*0.25);const apres=await pos();
  const sousDoigt=await p.evaluate(([x,y])=>{const e=document.elementFromPoint(x,y);return e?e.className||e.tagName:''},[x,h*0.7]);
  console.log(nom,quoi,JSON.stringify({avant,apres,sousDoigt}));
  if(apres.main+apres.doc<Math.min(apres.max,400))err.push(`${quoi} : bloqué à ${apres.main}/${apres.max}`);
 }
 const carte=await p.evaluate(()=>{const s=[...document.querySelectorAll('.carte h2')].find(h=>h.textContent.includes('Mails importants'));if(!s)return null;s.scrollIntoView();const r=s.closest('.carte').getBoundingClientRect();return{haut:Math.round(r.top),bas:Math.round(r.bottom),ecran:innerHeight}});
 console.log(nom,'carte mails',JSON.stringify(carte));
 await p.evaluate(()=>{const m=document.querySelector('main');m.scrollTo(0,m.scrollHeight)});await p.waitForTimeout(300);
 const recouvre=await p.evaluate(()=>{const nav=document.querySelector('nav').getBoundingClientRect();const fab=document.querySelector('.fab')?.getBoundingClientRect();const cartes=[...document.querySelectorAll('.carte')];const der=cartes.reduce((a,c)=>c.getBoundingClientRect().bottom>a.getBoundingClientRect().bottom?c:a);return{dernier:der.querySelector('h2')?.textContent,basDernier:Math.round(der.getBoundingClientRect().bottom),hautNav:Math.round(nav.top),hautFab:fab?Math.round(fab.top):null}});
 console.log(nom,'en bas',JSON.stringify(recouvre));if(recouvre.basDernier>recouvre.hautNav)err.push('dernière carte sous la barre');if(recouvre.hautFab&&recouvre.basDernier>recouvre.hautFab)err.push('dernière carte sous le bouton flottant');
 const reduit=await p.evaluate(()=>{const f=document.querySelector('.fab.etendu');return f?Math.round(f.getBoundingClientRect().width):null});if(reduit&&reduit>70)err.push('bouton pas réduit en descendant : '+reduit);
 await p.screenshot({path:`${sortie}/accueil-bas-${nom}.png`});
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();fin(tot?1:0)})().catch(e=>{console.error(e);fin(1)});
