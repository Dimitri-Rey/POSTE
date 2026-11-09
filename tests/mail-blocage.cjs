// Verdict et décision Oui/Non, réponses simulées : node tests/mail-blocage.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-'));
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8599','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8599',POSTE_ORIGINES:'http://127.0.0.1:8599',POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0'},stdio:'ignore'});
const U='http://127.0.0.1:8599';let tot=0;
(async()=>{let ok=false;for(let i=0;i<40&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});
for(const [nom,ctx] of [['mobile',devices['Pixel 7']],['pc',{viewport:{width:1280,height:800}}]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));const posts=[];
 await c.route('**/api/mails**',r=>{const u=new URL(r.request().url()),m=r.request().method();const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
  if(u.pathname==='/api/mails/point')return j({point:null,genere_le:Date.now()/1000,a_jour:true,chiffres:{jour:{total:0,non_lus:0,importants:0,importants_non_lus:0},semaine:{total:0,non_lus:0,importants:0,importants_non_lus:0}},en_cours:false});
  if(u.pathname.endsWith('/comptes'))return j([{id:'gmail',adresse:'moi@gmail.com'}]);
  if(u.pathname==='/api/mails/synchroniser')return j({lance:false});
  if(m!=='GET'){posts.push(m+' '+u.pathname+' '+(r.request().postData()||''));return j({motif:'x',sur_serveur:true,range_en_spam:true,ok:true})}
  if(u.pathname.endsWith('/bloques'))return j([{motif:'x@mal.example',cree_le:1,sur_serveur:1}]);
  if(u.pathname==='/api/mails')return j([]);
  return j({de:'Impots <noreply@amende.top>',a:'moi',sujet:'Contravention en attente',ts:Date.now()/1000,message_id:'x',texte:'Payez sous 24h',analyse:{niveau:'dangereux',score:8,raisons:["l'expéditeur échoue au contrôle DMARC : son adresse peut être falsifiée","se présente comme « Impots » mais écrit depuis amende.top"]},alertes:['x'],expediteur:'noreply@amende.top',lien_fournisseur:{nom:'Gmail',url:'https://mail.google.com/x'},a_html:false,images_distantes:false,pieces_jointes:[]})});
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.goto(U+'/#mails/gmail/5');await p.waitForSelector('.alerte-mail');await p.screenshot({path:`${sortie}/spam-${nom}-1.png`});
 if(await p.locator('.reponses-mail').count())err.push('réponses proposées sur un mail dangereux');
 await p.click('button[aria-label="Plus d\'actions"]');await p.waitForSelector('dialog .actions-mail');
 await p.click('button:has-text("Bloquer l\'expéditeur")');if(posts.length)err.push('envoyé sans Oui');await p.screenshot({path:`${sortie}/spam-${nom}-2.png`});
 await p.click('.actions-mail button:has-text("Non")');if(posts.length)err.push('Non a agi');
 await p.click('button:has-text("Bloquer tout amende.top")');await p.click('.actions-mail button:has-text("Oui")');await p.waitForSelector('a:has-text("Bloquer aussi dans Gmail")');await p.screenshot({path:`${sortie}/spam-${nom}-3.png`});
 if(!posts[0]?.includes('*@amende.top'))err.push('motif '+posts[0]);if(posts.length!==1)err.push('posts '+posts.length);
 await p.goto(U+'/#mails');await p.waitForSelector('.bloques');await p.click('.bloques summary');await p.waitForSelector('.bloques button');await p.click('.bloques button');await p.waitForTimeout(200);if(!posts.some(x=>x.startsWith('DELETE')))err.push('déblocage');
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(2)})
