// Parcours de l historique Hermes, réponses simulées : node tests/historique.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-'));
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8599','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8599',POSTE_ORIGINES:'http://127.0.0.1:8599',POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0'},stdio:'ignore'});
const U='http://127.0.0.1:8599',now=Date.now()/1000;
const mk=()=>[{id:'p',titre:'Préparation devis Durand',date:now-90000*9,epinglee:true},{id:'a',titre:'Créer un fichier test dans /tmp',date:now-600,epinglee:false},{id:'b',titre:'Obtenir la météo actuelle',date:now-3600,epinglee:false},{id:'c',titre:'Relance clients en retard et un titre très long pour vérifier la coupure propre',date:now-90000,epinglee:false},{id:'d',titre:'Facture de novembre',date:now-86400*4,epinglee:false},{id:'e',titre:'Vieux sujet',date:now-86400*50,epinglee:false}];
function assert(c,m,err){if(!c)err.push(m)}
(async()=>{let ok=false;for(let i=0;i<40&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['mobile',devices['Pixel 7']],['pc',{viewport:{width:1280,height:800}}]]){
 const c=await b.newContext(ctx);const p=await c.newPage();if(nom==='mobile'){const cdp=await c.newCDPSession(p);await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:40,bottom:20,left:0,right:0}})}const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 let L=mk();const patchs=[],dels=[];let attente=false;
 await c.route('**/api/hermes/**',async r=>{const u=new URL(r.request().url()).pathname,q=new URL(r.request().url()).search,m=r.request().method();const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
  if(u.endsWith('/conversations/recherche'))return j(q.includes('novembre')?[{id:'d',titre:'Facture de novembre',date:now-86400*4,extrait:'…la facture de novembre est prête…'}]:[]);
  if(u.endsWith('/conversations'))return j(L);
  let x=u.match(/conversations\/(\w+)$/);if(x){if(m==='PATCH'){const d=r.request().postDataJSON();patchs.push(d);const s=L.find(e=>e.id===x[1]);if(d.titre)s.titre=d.titre;if('epinglee' in d)s.epinglee=d.epinglee;return j({ok:true})}
   if(m==='DELETE'){dels.push(x[1]);L=L.filter(e=>e.id!==x[1]);return j({ok:true})}
   return j([{role:'user',texte:'Question de '+x[1]},{role:'assistant',texte:'Réponse dans la conversation '+x[1]}])}
  if(u.endsWith('/modele'))return j({actif:'precis',pret:true,choix:[{id:'precis',nom:'Précis'},{id:'rapide',nom:'Rapide'}]});
  if(u.endsWith('/habitudes'))return j(['git status']);
  if(u.endsWith('/executions/r9'))return j({statut:'waiting_for_approval',sortie:null,approbation:{request_id:'q1',description:'Exécuter : git push',habitude:null}});
  if(u.endsWith('/flux'))return r.fulfill({status:200,contentType:'text/event-stream',body:': veille\n\n'});
  return j({})});
 await p.goto(U);await p.waitForSelector('.seuil input');await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.goto(U+'/#hermes');await p.waitForSelector('.fil .bulle');
 assert((await p.textContent('.titre-conv')).includes('Créer un fichier'),'ouvre pas la plus récente non épinglée',err);
 assert((await p.textContent('.fil')).includes('conversation a'),'messages a absents',err);
 if(nom==='mobile'){const h=await p.evaluate(()=>document.querySelector('.ouvrir-volet').getBoundingClientRect().top);assert(h>=40,'en-tête sous la barre d état : '+h,err);console.log('haut du bouton',h)}await p.screenshot({path:`${sortie}/${nom}-1-reprise.png`});
 const mob=nom==='mobile';const ouvre=async()=>{if(mob)await p.click('.ouvrir-volet')};
 await ouvre();await p.waitForSelector('.conv');assert(await p.evaluate(()=>document.querySelector('.conversations').offsetWidth>=document.querySelector('.volet').clientWidth-40),'liste coupée',err);await p.screenshot({path:`${sortie}/${nom}-2-historique.png`});
 const grp=await p.$$eval('.conversations h2',x=>x.map(e=>e.textContent));assert(grp.join()==="Épinglées,Aujourd'hui,Hier,7 derniers jours,Plus ancien"||grp[0]==='Épinglées','groupes '+grp,err);console.log(nom,grp.join(' | '));
 await p.fill('.volet input[type=search]','novembre');await p.waitForSelector('.extrait');await p.screenshot({path:`${sortie}/${nom}-3-recherche.png`});
 await p.click('.conv');await p.waitForFunction(()=>document.querySelector('.fil').textContent.includes('conversation d'));
 assert(await p.evaluate(()=>!document.querySelector('.volet.ouvert')),'volet reste ouvert',err);
 // quitter et revenir : on reste sur d
 await p.goto(U+'/#mails');await p.waitForTimeout(300);await p.goto(U+'/#hermes');await p.waitForFunction(()=>document.querySelector('.fil')?.textContent.includes('conversation d'));
 // renommer
 await p.click('.menu-conv summary');await p.screenshot({path:`${sortie}/${nom}-4-menu.png`});await p.click('.menu-liste button:has-text("Renommer")');await p.fill('.titre-conv input','Facture client');await p.keyboard.press('Enter');await p.waitForFunction(()=>document.querySelector('.titre-conv').textContent==='Facture client');
 // épingler
 await p.click('.menu-conv summary');await p.click('.menu-liste button:has-text("Épingler")');await p.waitForFunction(()=>[...document.querySelectorAll('.menu-liste button')].some(b=>b.textContent==='Désépingler'));
 assert(patchs.length===2,'patchs '+JSON.stringify(patchs),err);
 // suppression en 2 temps
 await p.click('.menu-conv summary');await p.click('.menu-liste button:has-text("Supprimer")');assert(dels.length===0,'supprimé sans confirmation',err);await p.screenshot({path:`${sortie}/${nom}-5-suppr.png`});
 await p.click('.menu-liste button:has-text("Confirmer")');await p.waitForFunction(()=>document.querySelector('.titre-conv').textContent==='Nouvelle conversation');assert(dels[0]==='d','del',err);await p.screenshot({path:`${sortie}/${nom}-6-nouvelle.png`});
 // confirmation en attente : notification touchée, app relancée
 L.find(e=>e.id==='b').run='r9';L.find(e=>e.id==='b').attente=true;
 const p2=await c.newPage();p2.on('pageerror',e=>err.push('js2:'+e.message));
 await p2.goto(U+'/#hermes');await p2.waitForSelector('.decision');assert((await p2.textContent('.titre-conv')).includes('météo'),'attente non prioritaire',err);
 assert((await p2.$$('.decision')).length===1,'carte en double',err);await p2.screenshot({path:`${sortie}/${nom}-7-confirmation.png`});
 const deb=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth);if(deb)err.push('débordement');
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(2)})
