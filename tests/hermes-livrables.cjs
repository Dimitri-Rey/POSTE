// Hermes : livrables comme dans Claude (cartes sous la réponse, aperçu à droite ou plein écran sur téléphone).
// Vrai serveur (vraie conversion Word → pages), conversation simulée. Usage : node tests/hermes-livrables.cjs [dossier-captures]
const {chromium,devices}=require(process.env.PLAYWRIGHT);const {spawn,execFileSync}=require('child_process');const fs=require('fs'),os=require('os'),path=require('path');
const P='http://127.0.0.1:8560';const tmp=fs.mkdtempSync(os.tmpdir()+'/hl');const sortie=process.argv[2]||tmp;
const F='0123456789abcdef0123456789abcdef',G='fedcba9876543210fedcba9876543210';
const dossier=path.join(tmp,'fichiers',F);fs.mkdirSync(dossier,{recursive:true});fs.mkdirSync(path.join(tmp,'fichiers',G));
fs.writeFileSync(path.join(tmp,'r.md'),'# Rapport mensuel\n\nTout va **bien**.\n\n| Mois | Total |\n|---|---|\n| Octobre | 120 |\n');
execFileSync('pandoc',[path.join(tmp,'r.md'),'-o',path.join(dossier,'Rapport-mensuel.docx')]);
fs.writeFileSync(path.join(dossier,'Exemple.md'),'# Exemple de fichier Markdown\n\nCeci est un fichier **banal**.\n\n- Premier\n- Deuxième\n');
fs.writeFileSync(path.join(tmp,'fichiers',G,'page.html'),'<h1 id="t">Bonjour</h1><script>parent.document.title="pirate"</script>');
fs.writeFileSync(path.join(tmp,'fichiers',G,'budget.csv'),'Poste;Montant\nLoyer;800\nCourses;300\n');
const L=n=>`/api/fichiers/${n.startsWith('page')||n.startsWith('budget')?G:F}/${n}`;
const MSG=[{role:'user',texte:'Fais-moi un rapport'},{role:'assistant',texte:`Voici le rapport : [Rapport-mensuel.docx](${L('Rapport-mensuel.docx')}).\n\nEt la version texte [Exemple.md](${L('Exemple.md')}), une page [page.html](${L('page.html')}) et le [budget](${L('budget.csv')}).`}];
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8560','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8560',POSTE_ORIGINES:P,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const json=(r,o)=>r.fulfill({contentType:'application/json',body:JSON.stringify(o)});
(async()=>{for(let i=0;i<60;i++){if(await fetch(P+'/api/auth/etat').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,250))}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1440,height:900},permissions:['clipboard-read','clipboard-write']}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 await c.route(/\/api\/hermes\/modele$/,r=>json(r,{actif:'vision',pret:true,arrete:false,demarrable:true,vision:true,choix:[{id:'vision',nom:'Vision',vision:true}]}));
 await c.route(/\/api\/hermes\/habitudes$/,r=>json(r,[]));
 await c.route(/\/api\/hermes\/conversations(\?.*)?$/,r=>json(r,[{id:'c1',titre:'Rapport',date:1000,epinglee:false,run:null,attente:false}]));
 await c.route(/\/api\/hermes\/conversations\/c1$/,r=>json(r,MSG));
 await p.goto(P);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.goto(P+'/#hermes');await p.waitForSelector('.livrable');
 // Une carte par fichier, dans l'ordre, avec son type.
 const cartes=await p.$$eval('.livrable',l=>l.map(x=>x.innerText.replace(/\s+/g,' ').trim()));
 const attendu=['Rapport-mensuel Document · DOCX','Exemple Document · MD','page Page web · HTML','budget Tableau · CSV'];
 if(cartes.join('|')!==attendu.join('|'))err.push('cartes '+cartes);
 if(await p.locator('.panneau-apercu').isVisible())err.push('panneau ouvert sans clic (historique)');
 await p.screenshot({path:`${sortie}/livrables-cartes-${nom}.png`});
 // Word : pages en images, faites par LibreOffice.
 await p.click('.livrable:has-text("Rapport-mensuel") .livrable-ouvrir');
 await p.waitForSelector('.panneau-apercu .apercu-page',{timeout:90000});
 await p.waitForFunction(()=>{const i=document.querySelector('.apercu-page');return i&&i.complete&&i.naturalWidth>0},null,{timeout:60000}).catch(()=>err.push('page Word pas affichée'));
 if(!(await p.textContent('.apercu-titre')).includes('Rapport-mensuel · DOCX'))err.push('titre '+await p.textContent('.apercu-titre'));
 if(await p.locator('.apercu-bascule').count())err.push('bascule code sur un Word');
 if(!(await p.locator('.livrable.actif:has-text("Rapport-mensuel")').count()))err.push('carte active');
 const r=await p.evaluate(()=>[document.querySelector('.discussion').getBoundingClientRect().width,document.querySelector('.panneau-apercu').getBoundingClientRect().width,innerWidth]);
 if(nom==='pc'&&(r[1]<500||r[0]<400))err.push('partage '+r);
 if(nom==='mobile'&&r[1]!==r[2])err.push('pas plein écran '+r);
 await p.screenshot({path:`${sortie}/livrables-word-${nom}.png`});
 // Markdown : aperçu mis en forme, puis code, et Copier.
 if(nom==='mobile'){await p.evaluate(()=>window.posteRetour());if(await p.locator('.panneau-apercu').isVisible())err.push('Retour ne ferme pas')}
 await p.click('.livrable:has-text("Exemple") .livrable-ouvrir');await p.waitForSelector('.apercu-doc h1');
 if((await p.textContent('.apercu-doc h1'))!=='Exemple de fichier Markdown')err.push('markdown');
 await p.screenshot({path:`${sortie}/livrables-md-${nom}.png`});
 await p.click('.apercu-bascule button[aria-label="Code"]');
 if(!(await p.textContent('.apercu-source')).startsWith('# Exemple'))err.push('vue code');
 if(nom==='pc'){
  await p.click('.apercu-copier');await p.waitForTimeout(200);
  if(!(await p.evaluate(()=>navigator.clipboard.readText())).includes('fichier **banal**'))err.push('copier');
  // Agrandir : l'aperçu prend toute la page ; Réduire revient au partage.
  await p.click('.apercu-agrandir');
  if(await p.locator('.discussion').isVisible())err.push('agrandir');
  await p.click('.apercu-agrandir');
  if(!(await p.locator('.discussion').isVisible()))err.push('réduire');
 }
 // HTML : montré dans un cadre fermé, son script ne touche pas Poste.
 if(nom==='mobile')await p.click('.apercu-outil[aria-label="Fermer l\'aperçu"]');
 await p.click('.livrable:has-text("page") .livrable-ouvrir');await p.waitForSelector('.apercu-page-web');await p.waitForTimeout(500);
 if((await p.title())==='pirate')err.push('script de la page exécuté');
 if((await p.getAttribute('.apercu-page-web','sandbox'))!=='')err.push('cadre ouvert');
 // CSV : un tableau.
 if(nom==='mobile')await p.click('.apercu-outil[aria-label="Fermer l\'aperçu"]');
 await p.click('.livrable:has-text("budget") .livrable-ouvrir');await p.waitForSelector('.apercu-tableau td');
 if((await p.$$eval('.apercu-tableau td',l=>l.map(x=>x.textContent).join(',')))!=='Loyer,800,Courses,300')err.push('csv');
 // Échap ferme ; le lien du texte ouvre aussi l'aperçu.
 await p.keyboard.press('Escape');if(await p.locator('.panneau-apercu').isVisible())err.push('Échap');
 await p.click('a.fichier-cree:has-text("Exemple.md")');await p.waitForSelector('.apercu-doc h1');
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();process.exitCode=tot?1:0})().catch(e=>{console.log('ÉCHEC',String(e).slice(0,500));process.exitCode=1}).finally(()=>{srv.kill();setTimeout(()=>process.exit(),200)});
