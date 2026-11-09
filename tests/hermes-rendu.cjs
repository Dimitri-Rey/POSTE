// Rendu Markdown, bouton Copier et glisser-déposer : node tests/hermes-rendu.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-'));
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8599','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8599',POSTE_ORIGINES:'http://127.0.0.1:8599',POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0'},stdio:'ignore'});
const U='http://127.0.0.1:8599';let tot=0;
const REP=['## Script','Voici — **le** code `a — b` et [un lien](https://exemple.fr) :','```bash','echo "<b>bonjour</b>" && rm -i x','  indent $HOME','```','','- point un','- point deux','','| Nom | Km |','|---|---|','| Footing | 10 |','','<img src=x onerror="window.PIRATE=1"> [mauvais](javascript:window.PIRATE=2)'].join('\n');
(async()=>{let ok=false;for(let i=0;i<40&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});
for(const [nom,ctx] of [['mobile',devices['Pixel 7']],['pc',{viewport:{width:1280,height:800}}]]){
 const c=await b.newContext({...ctx,permissions:['clipboard-read','clipboard-write']});const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));let envoi=null;
 await c.route('**/api/hermes/**',r=>{const u=new URL(r.request().url()).pathname;const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
  if(u.endsWith('/modele'))return j({actif:'x',pret:true,choix:[]});
  if(u.endsWith('/conversations'))return j([{id:'a',titre:'Essai',date:Date.now()/1000,epinglee:false}]);
  if(u.endsWith('/conversations/a'))return j([{role:'user',texte:'Donne un script\n\n[Documents joints, à lire avec poste_lire_document]\n- '+'a'.repeat(32)+' : plan.pdf'},{role:'assistant',texte:REP}]);
  if(u.endsWith('/envoyer')){envoi=r.request().postDataJSON();return j({run_id:'r',conversation:'a'})}
  if(u.endsWith('/flux'))return r.fulfill({status:200,contentType:'text/event-stream',body:'data: {"event":"run.completed","output":"ok"}\n\n'});
  return j([])});
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');await p.goto(U+'/#hermes');await p.waitForSelector('.bloc-code');
 await p.screenshot({path:`${sortie}/rendu-${nom}.png`});
 // La barre d'écriture reste collée en bas de l'écran (au-dessus du menu sur téléphone), même avec une courte conversation.
 const bas=await p.evaluate(()=>{const s=document.querySelector('.saisie').getBoundingClientRect();const n=document.querySelector('nav').getBoundingClientRect();return{saisie:Math.round(s.bottom),limite:Math.round(innerWidth<=760?n.top:innerHeight)}});
 if(bas.limite-bas.saisie>40)err.push(`barre d'écriture pas en bas : ${bas.saisie} au lieu de ~${bas.limite}`);
 if(await p.evaluate(()=>window.PIRATE))err.push('HTML exécuté');if(await p.$('.bulle img'))err.push('img créée');if(await p.$('.bulle a[href^="javascript"]'))err.push('lien javascript');
 if(!await p.$('.bulle table td')||!await p.$('.bulle li')||!await p.$('.bulle strong'))err.push('mise en forme');
 await p.click('.copier');await p.waitForFunction(()=>document.querySelector('.copier').textContent==='Copié');
 const presse=await p.evaluate(()=>navigator.clipboard.readText());if(presse!=='echo "<b>bonjour</b>" && rm -i x\n  indent $HOME')err.push('copie: '+presse);
 const para=await p.textContent('.bulle.assistant p');if(!para.startsWith('Voici, le')||!para.includes('a — b'))err.push('tiret: '+para);if(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth))err.push('débordement');
 if(!(await p.textContent('.bulle.user .joint')).includes('plan.pdf'))err.push('joint historique');if((await p.textContent('.bulle.user')).includes('aaaaaaaa'))err.push('id visible');
 // Glisser-déposer : un vrai événement drop avec un vrai fichier, jusqu'au vrai serveur.
 await p.evaluate(()=>{const d=new DataTransfer();d.items.add(new File(['Facture 4217 pour Hermes'],'facture.txt',{type:'text/plain'}));
  const z=document.querySelector('.discussion');z.dispatchEvent(new DragEvent('dragover',{dataTransfer:d,bubbles:true,cancelable:true}));z.dispatchEvent(new DragEvent('drop',{dataTransfer:d,bubbles:true,cancelable:true}))});
 await p.waitForFunction(()=>document.querySelector('.joints-saisie .joint')?.textContent.includes('texte'),{timeout:8000});await p.screenshot({path:`${sortie}/depot-${nom}.png`});
 await p.fill('.saisie textarea','Résume');await p.click('button.plein:has-text("Envoyer")');await p.waitForFunction(()=>document.querySelector('.joints-saisie').hidden);await p.waitForTimeout(200);
 if(envoi?.documents?.[0]?.nom!=='facture.txt'||!/^[0-9a-f]{32}$/.test(envoi.documents[0].id)||envoi.texte!=='Résume')err.push('envoi '+JSON.stringify(envoi));
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(2)})
