// Réponse IA, réponses simulées : node tests/mail-reponse-ia.cjs <dossier-captures>
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
  if(m!=='GET'){posts.push(u.pathname+' '+(r.request().postData()||''));return j(u.pathname.endsWith('/reponse-ia')?{corps:'Bonjour Paul,\n\nOui, à 15 h.\n\nCamille'}:{depose_dans:'Drafts',compte:'moi@gmail.com'})}
  if(u.pathname==='/api/mails')return j([]);
  return j({de:'Paul <paul@x.fr>',a:'moi',sujet:'Point chantier',ts:Date.now()/1000,message_id:'<id@x>',texte:'On se voit à 14 h ?',analyse:{niveau:'sain',score:0,raisons:[]},alertes:[],expediteur:'paul@x.fr',lien_fournisseur:null,a_html:false,images_distantes:false,pieces_jointes:[]})});
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.goto(U+'/#mails/gmail/5');await p.click('button:has-text("Réponse IA")');await p.screenshot({path:`${sortie}/ia-${nom}-1.png`});
 await p.fill('textarea[aria-label="Thème de la réponse"]','oui mais à 15 h');await p.click('button:has-text("Générer la réponse")');await p.waitForSelector('button:has-text("Déposer en brouillon")');await p.screenshot({path:`${sortie}/ia-${nom}-2.png`,fullPage:true});
 if(posts.length!==1||!posts[0].includes('/gmail/5/reponse-ia'))err.push('génération '+posts);
 if(await p.inputValue('textarea[aria-label="Message"]')!=='Bonjour Paul,\n\nOui, à 15 h.\n\nCamille')err.push('texte absent');
 if(await p.inputValue('input[aria-label="Destinataire"]')!=='paul@x.fr')err.push('destinataire');
 await p.fill('textarea[aria-label="Message"]','Texte relu');await p.click('button:has-text("Déposer en brouillon")');await p.waitForSelector('text=Brouillon déposé');
 const d=JSON.parse(posts[1].split(' ').slice(1).join(' '));if(d.corps!=='Texte relu'||d.en_reponse_a!=='<id@x>'||d.sujet!=='Re: Point chantier')err.push('dépôt '+posts[1]);
 if(posts.length!==2)err.push('posts '+posts.length);
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(2)})
