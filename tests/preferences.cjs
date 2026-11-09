// Préférences des fichiers, vrai serveur : node tests/preferences.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-pref-'));
const U='http://127.0.0.1:8594';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8594','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8594',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});const err=[];
const c=await b.newContext({viewport:{width:1280,height:800}});const p=await c.newPage();p.on('pageerror',e=>err.push('js:'+e.message));
await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
await p.evaluate(()=>fetch('/api/espace/fichier',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({chemin:'n.md',contenu:'note'})}));
const ligne='.fx-el[data-chemin="n.md"]';
const prefs=async(nom,valeur)=>{await p.click('button[aria-label="Préférences"]');await p.waitForSelector('dialog select');if(nom)await p.selectOption(`dialog select[aria-label="${nom}"]`,valeur)};
await p.goto(U+'/#fichiers');await p.waitForSelector(ligne);
await prefs();await p.waitForFunction(()=>/fichier.* lu/.test(document.querySelector('dialog').textContent));await p.screenshot({path:`${sortie}/preferences.png`});await p.click('dialog button:has-text("Fermer")');
// Défaut : un clic ailleurs que sur le nom sélectionne
await p.click(`${ligne} .fx-date`);if(!(await p.locator(`${ligne}.choisi`).count()))err.push('défaut: pas de sélection');if(await p.locator('textarea.editeur').count())err.push('défaut: ouvert');
// Ligne : un clic sur la date ouvre
await prefs('Ouverture','ligne');await p.click('dialog button:has-text("Fermer")');await p.click(`${ligne} .fx-date`);await p.waitForSelector('textarea.editeur',{timeout:5000}).catch(()=>err.push('ligne: pas ouvert'));
// Double : un clic sur le nom sélectionne, le double-clic ouvre
await p.goto(U+'/#fichiers');await p.waitForSelector(ligne);await prefs('Ouverture','double');await p.click('dialog button:has-text("Fermer")');
await p.click(`${ligne} .fx-nom`);await p.waitForTimeout(400);if(await p.locator('textarea.editeur').count())err.push('double: ouvert au simple clic');if(!(await p.locator(`${ligne}.choisi`).count()))err.push('double: pas sélectionné');
await p.dblclick(`${ligne} .fx-nom`);await p.waitForSelector('textarea.editeur',{timeout:5000}).catch(()=>err.push('double: pas ouvert'));
// Affichage et recherche
await p.goto(U+'/#fichiers');await p.waitForSelector(ligne);await prefs('Affichage','vignettes');if(!(await p.locator('.fx-vignettes').count()))err.push('vignettes');
await p.selectOption('dialog select[aria-label="Recherche"]','contenu');await p.click('dialog button:has-text("Fermer")');if(!(await p.textContent('.fx-mode-recherche')).includes('Contenu'))err.push('mode recherche');
await p.reload();await p.waitForSelector('.fx-vignettes');
console.log('pc',err.length?err:'ok');await b.close();srv.kill();process.exit(err.length?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
