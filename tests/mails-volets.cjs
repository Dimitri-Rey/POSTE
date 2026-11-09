// Mails en deux volets sur grand écran, une seule colonne sur téléphone, réponses simulées : node tests/mails-volets.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-mv-'));const U='http://127.0.0.1:8589';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8589','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8589',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const t=Date.now()/1000;
const MAILS=[1,2,3,4].map(i=>({compte:'gmail',uid:i,de:`Contact ${i} <c${i}@x.fr>`,sujet:`Sujet numéro ${i}`,ts:t-i*3600,lu:i>2,alertes:[]}));
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1440,height:900}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));let listes=0;
 await c.route('**/api/mails**',r=>{const u=new URL(r.request().url());const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
  if(u.pathname==='/api/mails/point')return j({point:null,genere_le:Date.now()/1000,a_jour:true,chiffres:{jour:{total:0,non_lus:0,importants:0,importants_non_lus:0},semaine:{total:0,non_lus:0,importants:0,importants_non_lus:0}},en_cours:false});
  if(u.pathname.endsWith('/comptes'))return j([{id:'gmail',adresse:'moi@gmail.com'}]);
  if(u.pathname==='/api/mails'){listes++;return j(MAILS)}
  if(u.pathname==='/api/mails/bloques')return j([]);
  const uid=u.pathname.split('/').pop();
  return j({de:`Contact ${uid} <c${uid}@x.fr>`,a:'moi',sujet:`Sujet numéro ${uid}`,ts:t,message_id:'<id@x>',texte:`Bonjour Camille,\n\nCorps du mail ${uid}. Je te confirme le rendez-vous de jeudi pour l'audit du pare-feu ; je t'envoie le devis signé en pièce jointe.\n\nBonne journée,\nContact ${uid}`,analyse:{niveau:'sain',score:0,raisons:[]},alertes:[],expediteur:`c${uid}@x.fr`,lien_fournisseur:null,a_html:false,images_distantes:false,pieces_jointes:['devis-signe.pdf','plan-reseau.png']})});
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.goto(U+'/#mails');await p.waitForSelector('.mail');
 if(nom==='pc'){
  if(!(await p.locator('.volets-mails').count()))err.push('pas de volets');
  await p.click('.mail[data-cle="gmail/2"]');await p.waitForSelector('.volet-lecture h1:has-text("Sujet numéro 2")');
  if(!(await p.evaluate(()=>location.hash)).endsWith('/gmail/2'))err.push('adresse');
  if(listes!==1)err.push('liste rechargée '+listes);
  if(!(await p.locator('.mail.actif[data-cle="gmail/2"]').count()))err.push('marque active');
  if(await p.locator('.mail.non-lu[data-cle="gmail/2"]').count())err.push('toujours non lu');
  await p.click('.mail[data-cle="gmail/3"]');await p.waitForSelector('.volet-lecture h1:has-text("Sujet numéro 3")');
  await p.screenshot({path:`${sortie}/mails-pc.png`});
  await p.goBack();await p.waitForSelector('.volet-lecture h1:has-text("Sujet numéro 2")');
  await p.goto(U+'/#mails/gmail/4');await p.waitForSelector('.volet-lecture h1:has-text("Sujet numéro 4")');
 }else{
  if(await p.locator('.volets-mails').count())err.push('volets sur téléphone');
  await p.click('.mail[data-cle="gmail/2"]');await p.waitForSelector('h1:has-text("Sujet numéro 2")');await p.waitForSelector('a[aria-label="Retour aux mails"]');
  await p.screenshot({path:`${sortie}/mails-mobile.png`});
 }
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
