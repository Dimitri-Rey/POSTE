// Recherche à trois modes (vue, noms, contenu), vrai serveur : node tests/recherche.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-rech-'));
const U='http://127.0.0.1:8597';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8597','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8597',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 if(nom==='pc')for(const [f,t] of [['Clients/devis-dupont.md','Devis pour la société Dupont : installation du pare-feu, 1 200 €.'],['Clients/notes.md','Rappeler <b>Martin</b> pour le pare-feu.'],['budget.md','Budget annuel sans rapport.'],['devis-modele.txt','Modèle vierge.']])
  await p.evaluate(([f,t])=>fetch('/api/espace/fichier',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({chemin:f,contenu:t})}),[f,t]);
 const choisir=async m=>{await p.click('.fx-mode-recherche');await p.click(`.fx-menu button:has-text("${m}")`)};
 const lignes=()=>p.$$eval('.fx-el',l=>l.map(x=>x.dataset.chemin).sort().join('|'));
 await p.goto(U+'/#fichiers/d/Clients');await p.waitForSelector('.fx-el');
 // Dans la vue : seulement le dossier ouvert
 await choisir('Dans la vue');await p.fill('.fx-recherche','devis');await p.waitForTimeout(300);
 if(await lignes()!=='Clients/devis-dupont.md')err.push('vue: '+await lignes());
 // Noms : tout l'espace
 await choisir('Noms de fichiers');await p.waitForTimeout(300);
 if(await lignes()!=='Clients/devis-dupont.md|devis-modele.txt')err.push('noms: '+await lignes());
 // Contenu : extraits surlignés, sans accent, balises affichées telles quelles
 await choisir('Contenu');await p.fill('.fx-recherche','pare feu');await p.waitForSelector('.fx-resultat');
 const res=await p.$$eval('.fx-resultat',l=>l.map(x=>x.dataset.chemin).sort().join('|'));
 if(res!=='Clients/devis-dupont.md|Clients/notes.md')err.push('contenu: '+res);
 const marques=await p.$$eval('.fx-resultat mark',l=>l.map(x=>x.textContent));if(!marques.includes('pare')||!marques.includes('feu'))err.push('surlignage: '+marques);
 if(await p.$('.fx-resultat b'))err.push('balise interprétée');
 if(!(await p.textContent('.fx-statut')).includes('2 fichiers'))err.push('statut: '+await p.textContent('.fx-statut'));
 await p.screenshot({path:`${sortie}/recherche-${nom}-contenu.png`});
 await p.fill('.fx-recherche','zzzintrouvable');await p.waitForSelector('text=Aucun fichier ne contient');
 // Le mode est retenu et un résultat s'ouvre
 await p.reload();await p.waitForSelector('.fx-mode-recherche');if(!(await p.textContent('.fx-mode-recherche')).includes('Contenu'))err.push('mode non retenu');
 await p.fill('.fx-recherche','dupont');await p.click('.fx-resultat');await p.waitForSelector('textarea.editeur');
 if(nom==='pc'){await p.goto(U+'/#fichiers');await p.waitForSelector('.fx-el');await p.locator('.fx-el .fx-date').first().click();await p.keyboard.press('/');if(!await p.evaluate(()=>document.activeElement?.classList.contains('fx-recherche')))err.push('raccourci /')}
 await p.goto(U+'/#fichiers');await choisir('Noms de fichiers');
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
