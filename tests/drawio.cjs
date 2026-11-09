// draw.io de bout en bout (vrai serveur, vrai draw.io sur :9982) : node tests/drawio.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-drawio-'));
const U='http://127.0.0.1:8593',D=process.env.DRAWIO||'http://127.0.0.1:9982';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8593','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8593',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a',POSTE_DRAWIO_PUBLIC:D},stdio:'ignore'});
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]].filter(x=>!process.env.SEUL||x[0]===process.env.SEUL)){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));p.on('console',m=>{if(/Content.Security|Refused/.test(m.text()))err.push('csp:'+m.text().slice(0,160))});
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 const lire=()=>p.evaluate(x=>fetch('/api/espace/fichier?chemin='+x).then(r=>r.json()).then(j=>j.contenu),`schema-${nom}.drawio`);
 await p.goto(U+'/#fichiers');await p.click('button:has-text("Nouveau")');await p.click('.fx-nouveau button:has-text("Diagramme")');await p.fill('input[aria-label="Nom du fichier"]',`schema-${nom}`);await p.click('dialog button:has-text("Créer")');
 await p.waitForFunction(x=>decodeURIComponent(location.hash).includes('/g/'+x),`schema-${nom}.drawio`);
 const f=p.frameLocator('iframe.fx-cadre');await f.locator('.geDiagramContainer').waitFor({timeout:60000});await p.waitForTimeout(2500);
 if(!(await lire()).includes('<mxfile'))err.push('modèle vide absent');
 // Une forme de la bibliothèque : draw.io l'ajoute au centre, Poste enregistre tout seul.
 await p.screenshot({path:`${sortie}/drawio-${nom}-avant.png`});if(nom==='mobile'){await f.locator('.geDiagramContainer').dblclick({position:{x:150,y:200}});await p.waitForTimeout(800);await p.screenshot({path:`${sortie}/drawio-${nom}-formes.png`})}if(nom==='mobile'){const fr=p.frames().find(x=>x.url().includes(new URL(D).host));const r=await fr.evaluate(()=>{for(const e of document.querySelectorAll('a.geItem[aria-label="Rectangle"]')){const b=e.getBoundingClientRect();if(b.width&&document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.closest('a')===e)return{x:b.x+b.width/2,y:b.y+b.height/2}}return null});const cb=await p.locator('iframe.fx-cadre').boundingBox();if(!r)err.push('choix des formes');else await p.mouse.click(cb.x+r.x,cb.y+r.y)}else{const forme=f.locator('.geSidebarContainer a.geItem').first();await forme.waitFor({timeout:20000});await forme.click()}
 let xml='';for(let i=0;i<40&&!/vertex|<diagram[^>]*>[^<]/.test(xml);i++){await p.waitForTimeout(500);xml=await lire()}
 if(!/vertex|<diagram[^>]*>[^<]/.test(xml))err.push('pas enregistré: '+xml.slice(0,200));
 if(!(await p.textContent('.fx-tete-doc')).includes('Enregistré'))err.push('état');
 await p.screenshot({path:`${sortie}/drawio-${nom}.png`});
 // Rouvert : le diagramme revient avec sa forme
 await p.reload();await f.locator('.geDiagramContainer').waitFor({timeout:60000});await p.waitForTimeout(2500);
 const formes=await f.locator('.geDiagramContainer svg g g[data-cell-id], .geDiagramContainer svg rect, .geDiagramContainer svg ellipse, .geDiagramContainer svg path').count();if(!formes)err.push('rouvert vide');
 // L'icône et l'ouverture depuis la liste
 await p.goto(U+'/#fichiers');await p.click(`.fx-el[data-chemin="schema-${nom}.drawio"] .fx-nom`);await p.waitForSelector('iframe.fx-cadre');
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
