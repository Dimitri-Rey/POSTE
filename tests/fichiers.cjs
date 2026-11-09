// Fichiers et éditeur, vrai serveur, IA simulée : node tests/fichiers.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-'));
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8599','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8599',POSTE_ORIGINES:'http://127.0.0.1:8599',POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const U='http://127.0.0.1:8599';let tot=0;
(async()=>{let ok=false;for(let i=0;i<40&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});
for(const [nom,ctx] of [['mobile',devices['Pixel 7']],['pc',{viewport:{width:1280,height:800}}]]){
 const c=await b.newContext({...ctx,acceptDownloads:true});const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 const n=`note-${nom}`,d=`Rangé-${nom}`;
 await c.route('**/api/espace/ia/**',r=>{const u=r.request().url();const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
  if(u.endsWith('/suite'))return j({suite:'la suite proposée'});
  if(u.endsWith('/retoucher'))return j({texte:'Bonjour Paul, je viens demain.'});
  return j({resume:'Je range la note.',operations:[{action:'creer_dossier',chemin:d},{action:'deplacer',de:`${n}.md`,vers:`${d}/${n}.md`}]})});
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 const el=x=>`.fx-el[data-chemin="${x}"]`,attend=s=>p.waitForSelector(s),appel=(u,o)=>p.evaluate(([u,o])=>fetch(u,o).then(r=>r.json()),[u,o]);
 const menu=async(x,txt)=>{await p.click(`${el(x)} .fx-plus`);await p.click(`.fx-menu button:has-text("${txt}")`)};
 const coche=x=>p.click(`${el(x)} .fx-case`);
 await p.goto(U+'/#fichiers');await attend('button:has-text("Nouveau")');
 // Note, éditeur, IA : inchangés
 await p.click('button:has-text("Nouveau")');await p.click('.fx-nouveau button:has-text("Note")');await p.fill('input[aria-label="Nom du fichier"]',n);await p.click('dialog button:has-text("Créer")');await attend('textarea.editeur');
 await p.fill('textarea.editeur','Bonjoure Paul, je vien demain.');await attend('.suite-ia:not([hidden])');await attend('text=Enregistré');
 await p.press('textarea.editeur','Tab');const apresTab=await p.inputValue('textarea.editeur');if(!apresTab.endsWith('demain. la suite proposée'))err.push('Tab: '+apresTab);
 await p.fill('textarea.editeur','Bonjoure Paul, je vien demain.');await p.click('button:has-text("Corriger")');await attend('.difference ins');
 if(await p.inputValue('textarea.editeur')!=='Bonjoure Paul, je vien demain.')err.push('remplacé sans accord');
 await p.click('button:has-text("Accepter")');await p.waitForSelector('text=Enregistré',{timeout:5000});
 await p.click('text=Retour aux fichiers');await attend(el(`${n}.md`));
 const lu=await appel('/api/espace/fichier?chemin='+encodeURIComponent(`${n}.md`));if(lu.contenu!=='Bonjour Paul, je viens demain.')err.push('enregistré: '+lu.contenu);
 // Nouveau dossier : renommage sur place
 await p.click('button:has-text("Nouveau")');await p.click('.fx-nouveau button:has-text("Nouveau dossier")');await attend('.fx-renommer');await p.fill('.fx-renommer',d);await p.press('.fx-renommer','Enter');await attend(el(d));
 // Envoi multiple, image, tri, vignettes
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
 await p.setInputFiles('input[type=file]',[{name:`joint-${nom}.pdf`,mimeType:'application/pdf',buffer:Buffer.from('%PDF')},{name:`photo-${nom}.png`,mimeType:'image/png',buffer:png}]);await attend(el(`photo-${nom}.png`));
 await p.screenshot({path:`${sortie}/fichiers-${nom}-1-liste.png`});
 await p.click('button[aria-label="Changer d\'affichage"]');await attend('.fx-vignettes img.fx-vignette');await p.screenshot({path:`${sortie}/fichiers-${nom}-2-vignettes.png`});
 if(!await p.evaluate(()=>{const i=document.querySelector('.fx-vignette');return i.decode().then(()=>i.naturalWidth===1)}))err.push('vignette');
 await p.click('button[aria-label="Changer d\'affichage"]');await attend('.fx-liste');
 // Visionneuse
 await menu(`photo-${nom}.png`,'Ouvrir');await attend('dialog img.fx-image-vue');await p.click('dialog button:has-text("Fermer")');
 // Recherche sur tout l'espace
 await p.fill('.fx-recherche',`joint-${nom}`);await p.waitForFunction(()=>document.querySelectorAll('.fx-el').length===1);await p.fill('.fx-recherche','');await attend(el(d));
 // Sélection multiple puis déplacement par la fenêtre de choix
 await coche(`${n}.md`);await coche(`joint-${nom}.pdf`);await attend('.fx-actions:has-text("2 sélectionnés")');await p.screenshot({path:`${sortie}/fichiers-${nom}-3-selection.png`});
 await p.click('.fx-actions button:has-text("Déplacer")');await p.click(`dialog .fx-noeud:has-text("${d}")`);await p.screenshot({path:`${sortie}/fichiers-${nom}-4-destination.png`});await p.click('dialog button:has-text("Déplacer ici")');await p.waitForSelector(el(`${n}.md`),{state:'detached'});
 if(!(await appel('/api/espace/arbre')).some(e=>e.chemin===`${d}/${n}.md`))err.push('déplacement');
 // Copier vers, propriétés, renommer, corbeille, restauration
 await menu(`photo-${nom}.png`,'Copier vers');await p.click(`dialog .fx-noeud:has-text("${d}")`);await p.click('dialog button:has-text("Copier ici")');
 await p.waitForFunction(()=>true);await p.waitForTimeout(300);if(!(await appel('/api/espace/arbre')).some(e=>e.chemin===`${d}/photo-${nom}.png`))err.push('copie');if(!(await p.locator(el(`photo-${nom}.png`)).count()))err.push('original copié perdu');
 await menu(d,'Détails');await attend('.fx-details:has-text("3 éléments")');await p.screenshot({path:`${sortie}/fichiers-${nom}-7-details.png`});await p.click('.fx-details button[aria-label="Fermer"]');
 await p.click(`${el(`photo-${nom}.png`)} .fx-etoile`);await attend(`${el(`photo-${nom}.png`)} .fx-etoile.actif`);await p.goto(U+'/#fichiers/favoris');await attend(el(`photo-${nom}.png`));await p.goto(U+'/#fichiers/recents');await attend(el(`${d}/${n}.md`));await p.goto(U+'/#fichiers');await attend('.fx-fil:has-text("Tous les fichiers")');await attend(el(d));
 await menu(`photo-${nom}.png`,'Renommer');await p.fill('.fx-renommer',`image-${nom}.png`);await p.press('.fx-renommer','Enter');await attend(el(`image-${nom}.png`));if(!(await appel('/api/espace/favoris')).includes(`image-${nom}.png`))err.push('favori perdu au renommage');
 const dossierFile=el(d);if(nom==='mobile')await p.tap(dossierFile);else await p.click(`${dossierFile} .fx-nom`);await attend(el(`${d}/${n}.md`));
 const [dl]=await Promise.all([p.waitForEvent('download'),menu(`${d}/joint-${nom}.pdf`,'Télécharger')]);if(dl.suggestedFilename()!==`joint-${nom}.pdf`)err.push('téléchargement');
 await menu(`${d}/${n}.md`,'Mettre à la corbeille');await p.click('dialog button:has-text("Mettre à la corbeille")');await p.waitForSelector(el(`${d}/${n}.md`),{state:'detached'});
 await p.goto(U+'/#fichiers/corbeille');await attend('.fx-jete');await p.screenshot({path:`${sortie}/fichiers-${nom}-5-corbeille.png`});await p.click('.fx-jete button:has-text("Restaurer")');await attend('text=La corbeille est vide.');
 await p.goto(U+'/#fichiers');await attend(el(d));
 // Nouveau document : vierge, ou décrit pour Hermes
 await p.route('**/api/espace/bureau/session',r=>r.fulfill({status:503,contentType:'application/json',body:'{"detail":"test"}'}));
 await p.click('button:has-text("Nouveau")');await p.screenshot({path:`${sortie}/fichiers-${nom}-8-nouveau.png`});await p.click('.fx-nouveau button:has-text("Classeur Excel")');await p.fill('input[aria-label="Nom du fichier"]',`budget-${nom}`);await p.click('dialog button:has-text("Créer")');await p.waitForFunction(x=>location.hash.includes(x),`budget-${nom}.xlsx`);if(!(await appel('/api/espace/arbre')).some(e=>e.chemin===`budget-${nom}.xlsx`))err.push('excel vierge');
 await p.goto(U+'/#fichiers');await attend(el(d));
 let question=null;await p.route('**/api/hermes/envoyer',r=>{question=r.request().postDataJSON().texte;return r.fulfill({status:503,contentType:'application/json',body:'{"detail":"test"}'})});await p.route('**/api/hermes/modele*',r=>r.continue());
 await p.click('button:has-text("Nouveau")');await p.click('.fx-nouveau button:has-text("Présentation PowerPoint")');await p.fill('input[aria-label="Nom du fichier"]','offre');await p.fill('textarea[aria-label="Description pour l\'IA"]','trois diapos sur le budget');await p.click('dialog button:has-text("Créer")');await p.waitForFunction(()=>location.hash==='#hermes');for(let i=0;i<40&&!question;i++)await p.waitForTimeout(250);if(!question||!question.includes('trois diapos')||!question.includes('offre.pptx'))err.push('question hermes: '+question);
 await p.goto(U+'/#fichiers');await attend(el(d));
 // Une ligne de type Document garde une hauteur normale ; le double-clic ouvre (ailleurs que sur le nom)
 await p.evaluate(()=>fetch('/api/espace/nouveau',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chemin:'hauteur.docx'})}));await p.reload();await attend(el('hauteur.docx'));
 const haut=(await p.locator(el('hauteur.docx')).boundingBox()).height;if(haut>80)err.push('ligne géante: '+haut);
 const iconeH=(await p.locator(`${el('hauteur.docx')} .fx-icone`).boundingBox()).height;if(iconeH>40)err.push('icône géante: '+iconeH);
 if(nom==='mobile'){const v=await p.locator('nav .marque').isVisible();if(v)err.push('marque visible en bas')}
 if(nom==='pc'){await p.dblclick(`${el('hauteur.docx')} .fx-date`);await p.waitForFunction(()=>location.hash.includes('fichiers/o/'));await p.goto(U+'/#fichiers');await attend(el(d));await p.dblclick(`${el(d)} .fx-date`);await p.waitForFunction(x=>decodeURIComponent(location.hash).includes('/d/'+x),d,{timeout:8000});await p.goto(U+'/#fichiers');await attend(el(d));
  {const y0=(await p.locator(el(d)).boundingBox()).y;await p.click(`${el(d)} .fx-date`);await attend('.fx-actions:not([hidden])');const y1=(await p.locator(el(d)).boundingBox()).y;if(Math.abs(y1-y0)>1)err.push('la sélection décale la liste: '+y0+' -> '+y1);await p.keyboard.press('Escape');await p.waitForSelector('.fx-actions',{state:'hidden'})}
  await p.dblclick(`${el('hauteur.docx')} .fx-case`);await p.waitForTimeout(300);if(p.url().includes('/o/'))err.push('double-clic sur la case ouvre');}
 // Rangement IA dans sa fenêtre : rien sans accord
 await p.click('button:has-text("Nouveau")');await p.click('.fx-nouveau button:has-text("Ranger avec")');await p.fill('textarea[aria-label="Demande de rangement"]','range');await p.click('button:has-text("Proposer un rangement")');await attend('.plan li');await p.click('dialog button:has-text("Annuler")');await p.click('dialog button:has-text("Fermer")');
 if(nom==='pc'){
  // Clavier, couper-coller, glisser
  await p.click(`${el(`image-${nom}.png`)} .fx-date`);await p.keyboard.press('F2');await attend('.fx-renommer');await p.keyboard.press('Escape');await attend(el(`image-${nom}.png`));
  await p.click(`${el(`image-${nom}.png`)} .fx-date`);await p.keyboard.press('Control+c');await p.click(`${el(d)} .fx-nom`);await attend(el(`${d}/${n}.md`));await p.click('.fx-entete .fx-col-nom');await p.click(`${el(`${d}/${n}.md`)} .fx-date`);await p.keyboard.press('Control+v');await attend(el(`${d}/image-${nom}.png`));
  await p.goto(U+'/#fichiers');await attend(el(d));
  await p.click('button:has-text("Nouveau")');await p.click('.fx-nouveau button:has-text("Nouveau dossier")');await attend('.fx-renommer');await p.fill('.fx-renommer','Cible');await p.press('.fx-renommer','Enter');await attend(el('Cible'));
  await p.dragAndDrop(el(`image-${nom}.png`),el('Cible'));await p.waitForSelector(el(`image-${nom}.png`),{state:'detached'});if(!(await appel('/api/espace/arbre')).some(e=>e.chemin===`Cible/image-${nom}.png`))err.push('glisser');
  await p.click(`${el('Cible')} .fx-date`);await p.keyboard.press('Control+a');await attend('.fx-actions');await p.keyboard.press('Escape');
  await p.click(el('Cible'),{button:'right'});await attend('.fx-menu');await p.screenshot({path:`${sortie}/fichiers-${nom}-6-menu.png`});await p.keyboard.press('Escape');
 }
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(2)})
