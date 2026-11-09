// Hermes : joindre depuis l'espace Fichiers (menu du trombone, dossiers, recherche, plusieurs fichiers, image vue par l'IA).
// Usage : node tests/hermes-fichiers.cjs [dossier-captures]
const {chromium,devices}=require(process.env.PLAYWRIGHT);const {spawn}=require('child_process');const fs=require('fs'),os=require('os'),path=require('path');
const P='http://127.0.0.1:8566';const tmp=fs.mkdtempSync(os.tmpdir()+'/hf');const sortie=process.argv[2]||tmp;
const esp=path.join(tmp,'espace');fs.mkdirSync(path.join(esp,'Factures','2026'),{recursive:true});fs.mkdirSync(path.join(esp,'Photos'));
fs.writeFileSync(path.join(esp,'Factures','2026','facture-octobre.txt'),'Facture octobre : 120 €');
fs.writeFileSync(path.join(esp,'Notes de réunion.txt'),'Réunion du lundi');
fs.copyFileSync('android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png',path.join(esp,'Photos','tableau.png'));
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8566','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8566',POSTE_ORIGINES:P,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const json=(r,o,s=200)=>r.fulfill({status:s,contentType:'application/json',body:JSON.stringify(o)});
(async()=>{for(let i=0;i<60;i++){if(await fetch(P+'/api/auth/etat').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,250))}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));const envois=[],recus={};let n=0;
 await c.route(/\/api\/hermes\/modele$/,r=>json(r,{actif:'vision',pret:true,arrete:false,demarrable:true,vision:true,choix:[{id:'vision',nom:'Vision',vision:true}]}));
 await c.route(/\/api\/hermes\/habitudes$/,r=>json(r,[]));
 await c.route(/\/api\/hermes\/conversations(\?.*)?$/,r=>json(r,[]));
 await c.route(/\/api\/hermes\/envoyer$/,r=>{envois.push(JSON.parse(r.request().postData()));json(r,{run_id:'r1',conversation:'c1'})});
 await c.route(/\/api\/hermes\/executions\/r1(\/.*)?$/,r=>r.request().url().endsWith('/flux')?r.abort():json(r,{statut:'running',sortie:'',approbation:null}));
 await c.route(/\/api\/documents(\?.*|\/.*)?$/,r=>{const q=r.request();if(q.method()==='POST'){const id='d'+(++n);recus[new URL(q.url()).searchParams.get('nom')]=q.postDataBuffer().toString();return json(r,{id})}
  json(r,{statut:'pret',methode:'Texte lu'})});
 await p.goto(P);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.goto(P+'/#hermes');await p.waitForSelector('.saisie');await p.waitForTimeout(400);
 // Le trombone ouvre le menu ; Échap et un clic ailleurs le ferment.
 const trombone=p.locator('.saisie button[aria-label="Joindre un document"]');
 await trombone.click();if(!(await p.locator('.menu-joindre').isVisible()))err.push('menu fermé');
 await p.screenshot({path:`${sortie}/joindre-menu-${nom}.png`});
 await p.keyboard.press('Escape');if(await p.locator('.menu-joindre').isVisible())err.push('Échap');
 await trombone.click();await p.mouse.click(5,300);if(await p.locator('.menu-joindre').isVisible())err.push('clic ailleurs');
 await trombone.click();await p.click('.menu-joindre button:has-text("Depuis mes Fichiers")');
 await p.waitForSelector('dialog.choix-fichiers .cf-element');
 const racine=await p.$$eval('.cf-nom',l=>l.map(x=>x.textContent).join('|'));
 if(racine!=='Factures|Photos|Notes de réunion.txt')err.push('racine '+racine);
 if(!(await p.locator('.cf-pied button:has-text("Joindre")').isDisabled()))err.push('Joindre actif sans choix');
 // Parcourir les dossiers, cocher, revenir par le fil d'Ariane.
 await p.click('.cf-element:has-text("Factures")');await p.click('.cf-element:has-text("2026")');
 if((await p.textContent('.cf-chemin')).replace(/\s/g,'')!=='Fichiers/Factures/2026')err.push('chemin '+await p.textContent('.cf-chemin'));
 await p.click('.cf-element:has-text("facture-octobre.txt")');
 if(await p.getAttribute('.cf-element:has-text("facture-octobre.txt")','aria-checked')!=='true')err.push('pas coché');
 await p.click('.cf-etape:has-text("Fichiers")');await p.click('.cf-element:has-text("Photos")');await p.click('.cf-element:has-text("tableau.png")');
 // Recherche par nom, sans accents ni majuscules.
 await p.fill('.cf-outils input','reunion');
 const trouves=await p.$$eval('.cf-element',l=>l.map(x=>x.innerText.replace(/\s+/g,' ')));
 if(trouves.length!==1||!trouves[0].includes('Notes de réunion.txt'))err.push('recherche '+trouves);
 await p.click('.cf-element:has-text("Notes de réunion.txt")');
 if((await p.textContent('.cf-compte'))!=='3 fichiers choisis')err.push('compte '+await p.textContent('.cf-compte'));
 await p.screenshot({path:`${sortie}/joindre-fichiers-${nom}.png`});
 await p.click('.cf-pied button:has-text("Joindre les 3")');
 await p.waitForFunction(()=>document.querySelectorAll('.joint.pret').length===3,null,{timeout:10000}).catch(()=>err.push('joints pas prêts'));
 const joints=await p.$$eval('.joint',l=>l.map(x=>x.innerText.replace(/\s+/g,' ')));
 if(!joints.some(j=>j.includes('tableau.png')&&j.includes("Image vue par l'IA")))err.push('image pas vue par l\'IA '+joints);
 if(recus['facture-octobre.txt']!=='Facture octobre : 120 €'||recus['Notes de réunion.txt']!=='Réunion du lundi')err.push('contenu '+JSON.stringify(recus));
 await p.fill('.saisie textarea','Résume ces fichiers');await p.click('.saisie button[aria-label="Envoyer"]');await p.waitForTimeout(600);
 const e=envois[0]||{};
 if(e.documents?.length!==2||!e.image?.startsWith('data:image/jpeg'))err.push('envoi '+JSON.stringify({d:e.documents,i:!!e.image}));
 // Le dossier visité est retenu ; la touche Retour (Échap) ferme la fenêtre sans rien joindre.
 await trombone.click();await p.click('.menu-joindre button:has-text("Depuis mes Fichiers")');await p.waitForSelector('.cf-element');
 if(!(await p.textContent('.cf-chemin')).includes('Photos'))err.push('dossier pas retenu');
 await p.keyboard.press('Escape');await p.waitForTimeout(200);
 if(await p.locator('dialog.choix-fichiers').count())err.push('fenêtre pas fermée');
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();process.exitCode=tot?1:0})().catch(e=>{console.log('ÉCHEC',String(e).slice(0,400));process.exitCode=1}).finally(()=>{srv.kill();setTimeout(()=>process.exit(),200)});
