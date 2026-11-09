// Captures du README, sur une installation jetable remplie de données fictives.
// Mails, Hermes et Serveur sont simulés : aucune donnée de la machine n'apparaît sur les images.
//   PLAYWRIGHT=<playwright-core> CHROME=<chromium> node tests/captures-readme.cjs docs/captures
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const {chromium,devices}=require(process.env.PLAYWRIGHT);
const sortie=path.resolve(process.argv[2]||'docs/captures');fs.mkdirSync(sortie,{recursive:true});
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-cap-'));const U='http://127.0.0.1:8609';
fs.writeFileSync(tmp+'/poste.toml',['[serveur.disques]','"Système" = "/"','[modules]','hermes = true','[profil]','prenom = "Camille"',''].join('\n'));
const jour=(n)=>{const d=new Date(Date.now()+n*864e5);return d.toISOString().slice(0,10)};
const t=Date.now()/1000;

// Agenda branché (lien iCal) servi en local.
const ics=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//demo//FR',...[[1,'Anniversaire de Léa'],[3,'Vacances scolaires']].flatMap(([n,x],i)=>['BEGIN:VEVENT',`UID:d${i}`,`DTSTART;VALUE=DATE:${jour(n).replace(/-/g,'')}`,`SUMMARY:${x}`,'END:VEVENT']),'END:VCALENDAR'].join('\r\n');
const WIKI=`<!doctype html><meta charset="utf-8"><title>Wiki</title><style>body{margin:0;font:15px/1.6 system-ui,sans-serif;background:#f7f5f0;color:#2b2925}
header{background:#2f5d50;color:#fff;padding:14px 28px;font-weight:600;font-size:17px}main{display:flex;gap:28px;padding:24px 28px}
aside{width:200px}aside a{display:block;color:#2f5d50;padding:4px 0;text-decoration:none}article{background:#fff;border:1px solid #e3dfd6;border-radius:8px;padding:22px 30px;flex:1;max-width:760px}
h1{margin-top:0;font-size:24px}code{background:#f0ede6;padding:1px 5px;border-radius:4px}</style>
<header>Wiki de la maison</header><main><aside><a href="#">Accueil</a><a href="#">Réseau et Wi-Fi</a><a href="#">Chaudière</a><a href="#">Recettes</a><a href="#">Contacts utiles</a></aside>
<article><h1>Réseau et Wi-Fi</h1><p>Le routeur est dans l'entrée, derrière le meuble à chaussures. En cas de coupure, le débrancher 30 secondes.</p>
<h2>Réseaux</h2><ul><li><b>Maison</b> : ordinateurs et téléphones</li><li><b>Invités</b> : isolé du reste, mot de passe sur le frigo</li><li><b>Objets</b> : imprimante, caméra, thermostat</li></ul>
<h2>Adresses</h2><p>Imprimante : <code>192.168.1.20</code> · NAS : <code>192.168.1.10</code></p></article></main>`;
const faux=http.createServer((q,r)=>{if(q.url.startsWith('/wiki')){r.writeHead(200,{'content-type':'text/html; charset=utf-8'});return r.end(WIKI)}r.writeHead(200,{'content-type':'text/calendar'});r.end(ics)}).listen(8606);

// Mails fictifs.
const GENS=[['Paul Martin','paul.martin@exemple.fr','Devis pour la rénovation de la cuisine',true],['Banque Exemple','alertes@banque.exemple','Paiement refusé sur votre carte',false],
 ['Léa Bernard','lea.bernard@exemple.org','Photos du week-end',false],['Mairie','contact@mairie.exemple','Inscription à la cantine : documents à fournir',true],
 ['Librairie du Coin','bonjour@librairie.exemple','Votre commande est prête',true],['Association Sportive','club@sport.exemple','Planning des entraînements de novembre',true],
 ['Hugo Petit','hugo.petit@exemple.fr','Re: Réunion de jeudi',true],['Assurance Habitation','service@assurance.exemple','Votre attestation annuelle',true]];
const MAILS=GENS.map(([n,a,s,lu],i)=>({compte:'perso',uid:i+1,de:`${n} <${a}>`,sujet:s,ts:t-(i*5400+600),lu,alertes:[]}));
const LETTRE={de:'Paul Martin <paul.martin@exemple.fr>',a:'camille@exemple.fr',sujet:'Devis pour la rénovation de la cuisine',ts:t-600,message_id:'<1@exemple>',
 texte:"Bonjour Camille,\n\nComme convenu, voici le devis pour la rénovation de la cuisine : dépose de l'ancien plan de travail, pose du nouveau, reprise de la plomberie.\n\nLe chantier pourrait commencer le lundi 23 si le devis me revient signé avant vendredi.\n\nBonne journée,\nPaul",
 analyse:{niveau:'sain',score:0,raisons:[]},alertes:[],expediteur:'paul.martin@exemple.fr',lien_fournisseur:null,a_html:false,images_distantes:false,pieces_jointes:['devis-cuisine.pdf']};
const POINT={urgent:true,titre:"Une urgence : la banque a refusé un paiement par carte.",aujourdhui:"Huit mails aujourd'hui, deux encore non lus : la banque et Léa.",semaine:"Semaine chargée côté maison : Paul attend le devis signé avant vendredi, la mairie demande des papiers pour la cantine.",
 urgences:[{compte:'perso',uid:2,de:'Banque Exemple',sujet:'Paiement refusé sur votre carte',note:'Paiement de 42 € refusé, à régulariser aujourd’hui',lu:false}],
 importants:[{compte:'perso',uid:1,de:'Paul Martin',sujet:'Devis pour la rénovation de la cuisine',note:'Devis à renvoyer signé avant vendredi',lu:true},{compte:'perso',uid:4,de:'Mairie',sujet:'Inscription à la cantine',note:'Justificatif de domicile à fournir',lu:true}],
 bonnes:[{compte:'perso',uid:5,de:'Librairie du Coin',sujet:'Votre commande est prête',note:'Commande à retirer en boutique',lu:true}],mauvaises:[]};
const CHIFFRES={jour:{total:8,non_lus:2,importants:3,importants_non_lus:0},semaine:{total:46,non_lus:9,importants:7,importants_non_lus:1}};

// Serveur fictif.
const SERVEUR={charge:1.8,coeurs:16,memoire:{total_go:32,utilise_go:11.6},gpu:{charge:12,memoire_go:3.1,memoire_totale_go:12,temperature:41},
 disques:[{nom:'Système',libre_go:312,total_go:476},{nom:'Données',libre_go:1450,total_go:3726}],
 services:[{id:'ollama',nom:'Moteur IA',etat:'active'},{id:'ntfy',nom:'Notifications',etat:'active'},{id:'collabora',nom:'Bureautique',etat:'active'}]};

// Hermes fictif.
const CONV=[{id:'c1',titre:'Organiser la semaine',date:t-900,epinglee:true,run:null,attente:false},{id:'c2',titre:'Résumé du devis cuisine',date:t-86400,epinglee:false,run:null,attente:false},
 {id:'c3',titre:'Idées de sortie samedi',date:t-3*86400,epinglee:false,run:null,attente:false}];
const MSG=[{role:'user',texte:'Qu’est-ce que j’ai cette semaine, et qu’est-ce qui presse ?'},
 {role:'assistant',texte:"Voici ta semaine :\n\n| Jour | Rendez-vous |\n|---|---|\n| Aujourd’hui | Point équipe 9 h 30, dentiste 16 h |\n| Demain | Rendez-vous banque 10 h |\n| Après-demain | Appel fournisseur 14 h, cinéma 19 h |\n\n**Ce qui presse**\n\n1. Régulariser le paiement refusé par la banque (mail de ce matin).\n2. Renvoyer à Paul le devis signé avant vendredi.\n3. Payer la facture d’électricité, échéance aujourd’hui.\n\nVeux-tu que je crée une tâche pour le devis ?"}];

process.on('uncaughtException',e=>{console.error(e);fin(1)});
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8609','--app-dir','api'],{env:{...process.env,POSTE_CONFIG:tmp+'/poste.toml',POSTE_CLE:tmp+'/cle',POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8609',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const fin=(c)=>{srv.kill();faux.close();process.exit(c)};
const json=(r,o)=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});

async function simuler(ctx){
 await ctx.route(/\/api\/serveur$/,r=>json(r,SERVEUR));
 // Accueil : vraie réponse (agenda, tâches), mais serveur, mails et point fictifs.
 await ctx.route(/\/api\/accueil$/,async r=>{const v=await (await r.fetch()).json();
  json(r,{...v,serveur:SERVEUR,mails:MAILS.filter(m=>!m.lu).map(({compte,uid,de,sujet,ts})=>({compte,uid,de,sujet,ts})),
   point:{taille:'moyen',point:POINT,genere_le:t-1200,chiffres:CHIFFRES}})});
 await ctx.route('**/api/mails**',r=>{const u=new URL(r.request().url());
  if(u.pathname==='/api/mails/point')return json(r,{point:POINT,genere_le:t-1200,a_jour:true,chiffres:CHIFFRES,en_cours:false});
  if(u.pathname.endsWith('/comptes'))return json(r,[{id:'perso',adresse:'camille@exemple.fr'}]);
  if(u.pathname==='/api/mails')return json(r,MAILS);
  if(u.pathname==='/api/mails/bloques')return json(r,[]);
  if(/\/api\/mails\/perso\/\d+$/.test(u.pathname)){const m=MAILS[+u.pathname.split('/').pop()-1];return json(r,{...LETTRE,de:m.de,sujet:m.sujet,ts:m.ts})}
  return r.continue()});
 await ctx.route(/\/api\/hermes\/modele$/,r=>json(r,{actif:'rapide',pret:true,arrete:false,demarrable:true,vision:false,choix:[{id:'rapide',nom:'Rapide',vision:false},{id:'vision',nom:'Vision',vision:true}]}));
 await ctx.route(/\/api\/hermes\/habitudes$/,r=>json(r,[]));
 await ctx.route(/\/api\/hermes\/conversations(\?.*)?$/,r=>json(r,CONV));
 await ctx.route(/\/api\/hermes\/conversations\/c\d$/,r=>json(r,MSG));
}

(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});
const pc=await b.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1.5});await simuler(pc);const p=await pc.newPage();
await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-demo');await p.click('.seuil button');await p.waitForSelector('nav');
const api=(m,u,c)=>p.evaluate(([m,u,c])=>fetch(u,{method:m,headers:{'content-type':'application/json'},body:c?JSON.stringify(c):undefined}).then(r=>r.json()),[m,u,c]);
const auj=jour(0);
for(const [h,x,l] of [['09:30','Point équipe','Visio'],['12:30','Déjeuner avec Paul','Le Comptoir'],['16:00','Dentiste','Cabinet du Parc'],['18:30','Escalade','Salle Bloc']])await api('POST','/api/agenda',{titre:x,debut:`${auj}T${h}`,lieu:l});
for(const [n,h,x] of [[1,'10:00','Rendez-vous banque'],[2,'14:00','Appel fournisseur'],[2,'19:00','Cinéma'],[4,'08:30','Train pour Lyon']])await api('POST','/api/agenda',{titre:x,debut:`${jour(n)}T${h}`});
for(const [x,e,pr] of [['Renvoyer le devis signé',auj,1],['Payer la facture d\'électricité',auj,0],['Réserver le restaurant',jour(2),0],['Trier les photos de vacances',null,0],['Changer les pneus',jour(6),0]])await api('POST','/api/taches',{titre:x,echeance:e,priorite:pr});
await api('POST','/api/connecteurs/agendas',{nom:'Famille',type:'ics',url:'http://127.0.0.1:8606/famille.ics'});
for(const d of ['Maison','Travail','Photos'])await api('POST','/api/espace/dossier',{chemin:d});
for(const [c,x] of [['Liste de courses.md','# Courses\n\n- Pain\n- Tomates\n- Café\n'],['Maison/Travaux cuisine.md','# Travaux cuisine\n\nDevis de Paul à signer.\n'],['Travail/Compte rendu réunion.md','# Réunion du lundi\n\nPoints abordés…\n'],['Idées cadeaux.md','# Idées\n\n- Livre\n- Places de concert\n']])await api('PUT','/api/espace/fichier',{chemin:c,contenu:x});
const espace=tmp+'/espace';const pdf='%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n';
for(const [c,x] of [['Factures/Facture électricité octobre.pdf',pdf],['Factures/Facture internet octobre.pdf',pdf],['Budget 2026.xlsx','x'.repeat(18432)],['Présentation association.pptx','x'.repeat(1245184)],['Lettre au propriétaire.docx','x'.repeat(24576)],['Plan du jardin.drawio','<mxfile/>'+' '.repeat(9000)],['Photos/Vacances/.garde',''],['Maison/Notice chaudière.pdf',pdf]]){
 fs.mkdirSync(path.dirname(path.join(espace,c)),{recursive:true});if(!c.endsWith('.garde'))fs.writeFileSync(path.join(espace,c),x)}
await api('POST','/api/sites',{nom:'Wiki',adresse:'http://127.0.0.1:8606/wiki'});
await p.evaluate(()=>localStorage.setItem('poste-prenom','Camille'));
const prendre=async(page,nom,hash,attente,avant)=>{await page.goto(U+'/#'+hash);await page.waitForSelector(attente);if(avant)await avant(page);await page.waitForTimeout(800);await page.screenshot({path:`${sortie}/${nom}.png`});console.log('ok',nom)};

await prendre(p,'accueil-pc','accueil','.salut');
await prendre(p,'mails-pc','mails/perso/1','.volet-lecture h1');
await p.evaluate(()=>localStorage.setItem('poste-agenda-vue','semaine'));await prendre(p,'agenda-pc','agenda','.ag-semaine');
await prendre(p,'fichiers-pc','fichiers','.fx-el');
await prendre(p,'hermes-pc','hermes','.saisie',async pg=>{if(!await pg.locator('.conversations').isVisible())await pg.click('.ouvrir-volet');await pg.click('.conversations >> text=Organiser la semaine');await pg.waitForSelector('table')});
await prendre(p,'serveur-pc','serveur','main h1');
await prendre(p,'reglages-pc','reglages','.br-zone section',async pg=>{await pg.evaluate(()=>document.querySelector('.br-zone').scrollIntoView())});
await p.reload();await p.waitForSelector('nav a[aria-label="Wiki"]');
await prendre(p,'site-pc','site-1','.site-cadre',async pg=>{await pg.frameLocator('.site-cadre').locator('article').waitFor()});

const tel=await b.newContext({...devices['Pixel 7'],storageState:await pc.storageState()});await simuler(tel);const m=await tel.newPage();
await prendre(m,'accueil-telephone','accueil','.salut');
await prendre(m,'point-telephone','mails','.point-titre.urgent');
await prendre(m,'taches-telephone','taches','.ajout-tache');
await prendre(m,'hermes-telephone','hermes','.saisie',async pg=>{if(!await pg.locator('.conversations').isVisible())await pg.click('.ouvrir-volet');await pg.click('.conversations >> text=Organiser la semaine');await pg.waitForSelector('table')});
await b.close();fin(0)})().catch(e=>{console.error(e);fin(1)});
