// Réglages → Sauvegardes : ajouter un endroit, planning et rotation, sauvegarder, historique, récupérer. node tests/sauvegardes.cjs [captures]
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-sv-'));const sortie=process.argv[2]||tmp;const U='http://127.0.0.1:8585';
fs.mkdirSync(tmp+'/donnees/espace',{recursive:true});fs.writeFileSync(tmp+'/donnees/espace/devis.md','# Devis');
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8585','--app-dir','api'],{env:{...process.env,POSTE_CONFIG:path.resolve('tests/reglages-test.toml'),POSTE_CLE:tmp+'/cle',POSTE_BASE:tmp+'/donnees/t.db',POSTE_HOTES:'127.0.0.1:8585',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;let premier=true;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:860}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 const disque=fs.mkdtempSync(path.join(os.tmpdir(),'poste-disque-'));
 await p.goto(U);if(premier){await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button')}else{await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button')}
 await p.waitForSelector('nav');await p.goto(U+'/#reglages');await p.waitForSelector('.sv-zone');
 await p.click('button:has-text("+ Ajouter un endroit")');await p.click('dialog .br-fournisseur:has-text("Disque ou dossier du serveur")');const f=p.locator('dialog .sv-formulaire');await f.waitFor();
 // Refus clair d'un mauvais dossier
 await f.locator('label:has-text("Dossier") input').fill('/existe/pas');await f.locator('button:has-text("Ajouter")').click();
 await p.waitForSelector('dialog .br-message.erreur');if(!/n'existe pas/.test(await p.textContent('dialog .br-message')))err.push('message dossier');
 await f.locator('label:has-text("Nom") input').fill('Clé USB '+nom);await f.locator('label:has-text("Dossier") input').fill(disque);
 await f.locator('input[type=time]').fill('02:30');
 for(const j of ['Mardi','Jeudi','Samedi'])await f.locator(`.sv-jours button[aria-label="${j}"]`).click();  // retire 3 jours
 await f.locator('select[aria-label="Sauvegarde complète"]').selectOption('mois');await f.locator('select[aria-label="Jour de la complète"]').selectOption('1');
 await f.locator('input[aria-label="Nombre gardé"]').fill('6');
 const phrase=await f.locator('.sv-resume').textContent();
 if(phrase!=='Lundi, mercredi, vendredi, dimanche à 02:30 · complète le 1 du mois, incrémentielle sinon · environ 6 mois d\'historique.')err.push('résumé: '+phrase);
 await p.screenshot({path:`${sortie}/sauvegarde-formulaire-${nom}.png`});
 await f.locator('button:has-text("Ajouter")').click();await p.waitForSelector('dialog',{state:'detached'});
 const carte=p.locator('.sv-carte',{hasText:'Clé USB '+nom});await carte.waitFor();
 if(!/Aucune sauvegarde/.test(await carte.textContent()))err.push('état initial');
 if(!/Prochaine : .* · complète/.test(await carte.textContent()))err.push('prochaine: '+await carte.locator('.sv-etat').textContent());
 if(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))err.push('déborde en largeur');
 await carte.locator('button:has-text("Sauvegarder maintenant")').click();
 await carte.locator('.pastille.ok').waitFor({timeout:20000}).catch(()=>err.push('jamais finie'));
 if(!/Dernière à l'instant · complète/.test(await carte.textContent()))err.push('carte: '+await carte.locator('.sv-etat').textContent());
 await carte.locator('button:has-text("Sauvegarder maintenant")').click();await p.waitForTimeout(300);
 await p.waitForFunction(n=>[...document.querySelectorAll('.sv-carte')].find(x=>x.textContent.includes(n))?.textContent.includes('incrémentielle ·'),'Clé USB '+nom,{timeout:20000}).catch(()=>err.push('pas d\'incrémentielle'));
 await p.screenshot({path:`${sortie}/sauvegarde-carte-${nom}.png`});
 await carte.locator('button:has-text("Historique (2)")').click();await p.waitForSelector('dialog .sv-archive');
 const types=await p.$$eval('dialog .sv-archive .etiquette',l=>l.map(x=>x.textContent));if(types.join()!=='Incrémentielle,Complète')err.push('historique '+types);
 await p.screenshot({path:`${sortie}/sauvegarde-historique-${nom}.png`});
 await p.locator('dialog .sv-archive').last().locator('button:has-text("Récupérer")').click();
 await p.waitForSelector('.toast:has-text("Restaurations")');await p.click('.toast button:has-text("Ouvrir")');await p.waitForTimeout(800);
 if(!decodeURIComponent(await p.evaluate(()=>location.hash)).includes('Restaurations/Clé USB '+nom))err.push('ouvrir: '+await p.evaluate(()=>location.hash));
 if(!(await p.textContent('main')).includes('devis.md'))err.push('fichier récupéré absent');
 // Modifier puis retirer
 await p.goto(U+'/#reglages');await carte.locator('button:has-text("Modifier")').click();p.once('dialog',d=>d.accept());
 await p.locator('dialog button:has-text("Retirer")').click();await carte.waitFor({state:'detached'});
 if(!fs.readdirSync(disque+'/poste-sauvegardes').some(x=>x.endsWith('.tar.gz')))err.push('archives effacées au retrait');
 if(nom==='pc'){
  // Stockage distant (WebDAV façon kDrive), avec mot de passe et chiffrement, par un vrai serveur local.
  const dav=fs.mkdtempSync(path.join(os.tmpdir(),'poste-dav-'));const port=8586;
  const serv=spawn('rclone',['serve','webdav',dav,'--addr','127.0.0.1:'+port,'--user','moi@exemple.fr','--pass','mdp-kdrive'],{stdio:'ignore'});await p.waitForTimeout(1200);
  await p.click('button:has-text("+ Ajouter un endroit")');const grille=await p.$$eval('dialog .br-fournisseur',l=>l.map(x=>x.textContent));
  for(const n of ['Google Drive','kDrive (Infomaniak)','NAS Synology','Partage réseau Windows, Samba (AD, LDAP)','Stockage S3','OneDrive, SharePoint'])if(!grille.includes(n))err.push('manque '+n);
  await p.screenshot({path:`${sortie}/sauvegarde-choix-${nom}.png`});
  await p.click('dialog .br-fournisseur:has-text("kDrive")');const g=p.locator('dialog .sv-formulaire');await g.waitFor();
  await g.locator('input[aria-label="Adresse WebDAV"]').fill('http://127.0.0.1:'+port);await g.locator('input[aria-label="Identifiant (e-mail)"]').fill('moi@exemple.fr');
  if(await g.locator('input[aria-label^="Dossier dans le stockage"]').inputValue()!=='Sauvegardes')err.push('dossier par défaut absent');
  await g.locator('input[aria-label="Mot de passe"]').fill('mauvais');await g.locator('button:has-text("Tester et ajouter")').click();
  await p.waitForSelector('dialog .br-message.erreur:has-text("Identifiants refusés")',{timeout:30000}).catch(()=>err.push('pas de refus lisible'));
  await g.locator('input[aria-label="Mot de passe"]').fill('mdp-kdrive');await g.locator('input[aria-label^="Mot de passe de chiffrement"]').fill('phrase secrète');
  await p.screenshot({path:`${sortie}/sauvegarde-kdrive-${nom}.png`});
  await g.locator('button:has-text("Tester et ajouter")').click();await p.waitForSelector('dialog',{state:'detached',timeout:30000});
  const ck=p.locator('.sv-carte',{hasText:'kDrive (Infomaniak)'});await ck.waitFor();if(!(await ck.textContent()).includes('Chiffrées'))err.push('pas marqué chiffré');
  await ck.locator('button:has-text("Sauvegarder maintenant")').click();
  await ck.locator('.pastille.ok').waitFor({timeout:30000}).catch(async()=>err.push('kdrive: '+await ck.locator('.sv-etat').textContent()));
  const chezLui=[];const tout=(d)=>{for(const x of fs.readdirSync(d,{withFileTypes:true})){if(x.isDirectory())tout(path.join(d,x.name));else chezLui.push(x.name)}};tout(dav);
  if(!chezLui.length||chezLui.some(n=>n.includes('poste')))err.push('noms lisibles chez le fournisseur: '+chezLui);
  await p.screenshot({path:`${sortie}/sauvegarde-cartes-${nom}.png`,fullPage:true});
  // Modifier sans retaper le mot de passe : il est gardé
  await ck.locator('button:has-text("Modifier")').click();const m=p.locator('dialog .sv-formulaire');await m.waitFor();
  if(await m.locator('input[aria-label="Mot de passe"]').getAttribute('placeholder')!=='Enregistré : laisse vide pour le garder')err.push('secret non signalé');
  await m.locator('button:has-text("Tester et enregistrer")').click();await p.waitForSelector('dialog',{state:'detached',timeout:30000}).catch(()=>err.push('modif refusée'));
  serv.kill();}
 console.log(nom,err.length?err:'ok');tot+=err.length;premier=false;await c.close()}
console.log('captures',sortie);await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
