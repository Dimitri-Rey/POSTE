// Lecteur léger dans Hermes : image, PDF, texte, document joint ; fermé d'un clic à l'extérieur. Usage : node tests/hermes-lecteur.cjs <image.png> [captures]
const {chromium,devices}=require(process.env.PLAYWRIGHT);const {spawn}=require('child_process');const fs=require('fs'),os=require('os');
const P='http://127.0.0.1:8575';const tmp=fs.mkdtempSync(os.tmpdir()+'/hl');const png=fs.readFileSync(process.argv[2]);const sortie=process.argv[3]||tmp;
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8575','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8575',POSTE_ORIGINES:P,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const json=(r,o)=>r.fulfill({contentType:'application/json',body:JSON.stringify(o)});const H='0123456789abcdef0123456789abcdef';
const REPONSE=`Voici le schéma :\n\n![Schéma réseau](/api/fichiers/${H}/schema.png)\n\nLe [rapport](/api/fichiers/${H}/rapport.pdf), les [notes](/api/fichiers/${H}/notes.txt) et le [tableau](/api/fichiers/${H}/budget.xlsx).`;
(async()=>{for(let i=0;i<60;i++){if(await fetch(P+'/api/auth/etat').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,250))}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 await c.route(/\/api\/hermes\/modele$/,r=>json(r,{actif:'vision',pret:true,arrete:false,demarrable:true,vision:true,choix:[{id:'vision',nom:'Vision',vision:true}]}));
 await c.route(/\/api\/hermes\/habitudes$/,r=>json(r,[]));
 await c.route(/\/api\/hermes\/conversations(\?.*)?$/,r=>json(r,[{id:'c1',titre:'Schéma',date:Date.now()/1000,epinglee:false,run:null,attente:false}]));
 await c.route(/\/api\/hermes\/conversations\/c1$/,r=>json(r,[{role:'user',texte:`Fais un schéma\n\n[Documents joints, à lire avec poste_lire_document]\n- ${H} : devis.pdf`},{role:'assistant',texte:REPONSE}]));
 await c.route(/\/api\/documents\/[0-9a-f]+\/texte$/,r=>json(r,{nom:'devis.pdf',texte:'DEVIS N° 42\nMontant : 1 200 €',total:30,debut:0,suite:null}));
 await c.route(/\/api\/fichiers\/.*/,r=>{const u=r.request().url();
  if(u.endsWith('.png'))return r.fulfill({contentType:'image/png',body:png});
  if(u.endsWith('.txt'))return r.fulfill({contentType:'text/plain; charset=utf-8',body:'Notes de réunion\n- point 1'});
  return r.fulfill({contentType:'application/pdf',headers:{'content-disposition':'inline'},body:'%PDF-1.4\n%%EOF'})});
 await p.goto(P);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.evaluate(()=>sessionStorage.setItem('hermes-conversation','c1'));await p.goto(P+'/#hermes');await p.waitForSelector('.image-creee');
 const ouvert=()=>p.locator('dialog.lecteur[open]').count();
 const dehors=async()=>{const v=p.viewportSize();await p.mouse.click(4,v.height/2);await p.waitForTimeout(200)};
 // Image : aperçu, zoom au clic, fermeture d'un clic à l'extérieur.
 await p.click('.image-creee');await p.waitForSelector('dialog.lecteur[open] img');
 if(!(await p.textContent('.lecteur-nom')).includes('schema.png'))err.push('nom');
 if(!(await p.locator('.lecteur a[download]').count()))err.push('pas de téléchargement');
 await p.screenshot({path:`${sortie}/lecteur-image-${nom}.png`});
 await p.click('.lecteur-corps img');if(!(await p.locator('.lecteur-corps.zoom').count()))err.push('zoom');
 await dehors();if(await ouvert())err.push('clic extérieur ne ferme pas');
 // Fichiers créés (PDF, texte, tableur) : le lien et la carte ouvrent le panneau d'aperçu (tests/hermes-livrables.cjs pour le détail).
 const panneau=()=>p.locator('.panneau-apercu').isVisible();
 if((await p.locator('.livrable').count())!==3)err.push('cartes '+await p.locator('.livrable').count());
 await p.click('a.fichier-cree:has-text("rapport")');await p.waitForSelector('.panneau-apercu .apercu-titre');
 if(!(await p.textContent('.apercu-titre')).includes('rapport · PDF'))err.push('pdf');
 await p.keyboard.press('Escape');await p.waitForTimeout(150);if(await panneau())err.push('Échap');
 await p.click('a.fichier-cree:has-text("notes")');await p.waitForSelector('.apercu-source');
 if(!(await p.textContent('.apercu-source')).includes('Notes de réunion'))err.push('texte');
 await p.click('.panneau-apercu button[aria-label="Fermer l\'aperçu"]');if(await panneau())err.push('×');
 if(!(await p.getAttribute('a.fichier-cree:has-text("tableau")','download')))err.push('tableur sans téléchargement');
 // Document joint : son texte lu.
 await p.click('.joint.ouvrable');await p.waitForSelector('.lecteur-texte');
 if(!(await p.textContent('.lecteur-texte')).includes('DEVIS N° 42'))err.push('document joint');
 await p.screenshot({path:`${sortie}/lecteur-document-${nom}.png`});
 // Touche Retour de l'appli : ferme l'aperçu, reste dans la conversation.
 if(await p.evaluate(()=>window.posteRetour())!=='fait'||await ouvert())err.push('retour');
 if(!(await p.evaluate(()=>location.hash)).startsWith('#hermes'))err.push('quitté la conversation');
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();process.exitCode=tot?1:0})().catch(e=>{console.log('ÉCHEC',String(e).slice(0,500));process.exitCode=1}).finally(()=>{srv.kill();setTimeout(()=>process.exit(),200)});
