// Le point des mails en tête de la page Mails, réponses simulées : node tests/point-mails.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-pm-'));const U='http://127.0.0.1:8591';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8591','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8591',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const t=Date.now()/1000;
const MAILS=[1,2,3].map(i=>({compte:'gmail',uid:i,de:`Contact ${i} <c${i}@x.fr>`,sujet:`Sujet numéro ${i}`,ts:t-i*600,lu:i===2,alertes:[]}));
const CHIFFRES={jour:{total:3,non_lus:2,importants:1,importants_non_lus:0},semaine:{total:41,non_lus:20,importants:4,importants_non_lus:1}};
const POINT={urgent:true,titre:"Une urgence : la banque a refusé un paiement.",aujourdhui:"Trois mails aujourd'hui, deux encore non lus.",semaine:"Semaine calme, Paul attend ta réponse sur le devis.",
 urgences:[{compte:'gmail',uid:1,de:'Contact 1',sujet:'Sujet numéro 1',note:'Paiement de 40 € refusé, à régler aujourd’hui',lu:false}],
 importants:[{compte:'gmail',uid:3,de:'Contact 3 avec un nom vraiment très long pour voir',sujet:'Sujet numéro 3',note:'Attend ta réponse sur le devis du pare-feu',lu:false}],
 bonnes:[{compte:'gmail',uid:2,de:'Contact 2',sujet:'Sujet numéro 2',note:'Le devis est accepté',lu:true}],mauvaises:[]};
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1440,height:900}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 let fait=null,posts=0,echec=nom==='mobile';
 await c.route('**/api/mails**',async r=>{const u=new URL(r.request().url()),m=r.request().method();const j=(o,s=200)=>r.fulfill({status:s,contentType:'application/json',body:JSON.stringify(o)});
  if(u.pathname==='/api/mails/point'){
   if(m==='GET')return j(fait?{point:POINT,genere_le:fait,a_jour:true,chiffres:CHIFFRES,en_cours:false}:{point:null,genere_le:null,a_jour:false,chiffres:CHIFFRES,en_cours:false});
   posts++;await new Promise(x=>setTimeout(x,700));
   if(echec){echec=false;return j({detail:"Le moteur d'IA est arrêté : démarre-le depuis Hermes, puis actualise le point."},503)}
   fait=Date.now()/1000;return j({point:POINT,genere_le:fait,a_jour:true,chiffres:CHIFFRES,en_cours:false})}
  if(u.pathname.endsWith('/comptes'))return j([{id:'gmail',adresse:'moi@gmail.com'}]);
  if(u.pathname==='/api/mails/synchroniser')return j({lance:false});
  if(u.pathname==='/api/mails')return j(MAILS);
  if(u.pathname==='/api/mails/bloques')return j([]);
  const uid=u.pathname.split('/').pop();
  return j({de:`Contact ${uid} <c${uid}@x.fr>`,a:'moi',sujet:`Sujet numéro ${uid}`,ts:t,message_id:'<id@x>',texte:'Bonjour',analyse:{niveau:'sain',score:0,raisons:[]},alertes:[],expediteur:`c${uid}@x.fr`,lien_fournisseur:null,a_html:false,images_distantes:false,pieces_jointes:[]})});
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.goto(U+'/#mails');await p.waitForSelector('.point-mails');
 // Premier passage : aucun point encore, l'IA le prépare toute seule.
 await p.waitForSelector('.point-mails .point-titre:has-text("Lecture des mails")');
 if(!(await p.locator('.point-mails button:has-text("Préparation")').isDisabled()))err.push('bouton actif pendant la préparation');
 if(nom==='mobile'){
  await p.waitForSelector('.point-mails .erreur:has-text("moteur d\'IA est arrêté")');
  await p.click('.point-mails button:has-text("Actualiser")');
 }
 await p.waitForSelector('.point-titre.urgent:has-text("Une urgence")');
 const chiffres=await p.$$eval('.point-chiffre',l=>l.map(x=>x.innerText.replace(/\s+/g,' ').trim()).join(' | '));
 if(chiffres!=="Aujourd'hui 3 mails 2 non lus · 1 important | 7 derniers jours 41 mails 20 non lus · 4 importants")err.push('chiffres '+chiffres);
 const groupes=await p.$$eval('.point-liste .titre-groupe',l=>l.map(x=>x.firstChild.textContent));
 if(groupes.join('|')!=='Urgent|Important|Bonnes nouvelles')err.push('groupes '+groupes);
 if(await p.locator('.point-mail.non-lu .point-pastille').count()!==2)err.push('pastilles non lu');
 if(posts!==(nom==='mobile'?2:1))err.push('posts '+posts);
 await p.screenshot({path:`${sortie}/point-${nom}.png`,fullPage:nom==='mobile'});
 // Un élément du point ouvre le mail : dans le volet sur PC, en page sur téléphone.
 await p.click('.point-liste.urgences .point-mail');
 await p.waitForSelector(nom==='pc'?'.volet-lecture h1:has-text("Sujet numéro 1")':'.lecteur h1:has-text("Sujet numéro 1")');
 if(!(await p.evaluate(()=>location.hash)).endsWith('/gmail/1'))err.push('adresse');
 if(nom==='pc'&&!(await p.locator('.point-mails').count()))err.push('point disparu');
 // Replié, il le reste au retour ; à jour, il n'est pas refait.
 await p.goto(U+'/#accueil');await p.goto(U+'/#mails');await p.waitForSelector('.point-titre.urgent');
 await p.click('.point-mails summary');await p.reload();await p.waitForSelector('.point-titre.urgent');
 if(await p.locator('.point-mails[open]').count())err.push('pas resté replié');
 if(!(await p.locator('.point-mails summary .point-titre').isVisible()))err.push('titre caché replié');
 if(posts!==(nom==='mobile'?2:1))err.push('refait sans raison '+posts);
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
