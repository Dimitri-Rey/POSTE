// Éditeurs de bout en bout (vrai serveur, vrai Collabora de test sur :9981) : node tests/editeurs.cjs <dossier-captures>
const {spawn,execFileSync}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const P='http://127.0.0.1:8599',C='http://127.0.0.1:9981';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-ed-'));
const py=path.resolve('.venv/bin/python');
execFileSync(py,['-c',`import docx,pymupdf,sys
d=docx.Document();d.add_paragraph('Texte de depart');d.save('${tmp}/a.docx')
import openpyxl;w=openpyxl.Workbook();w.active['A1']='Cellule';w.save('${tmp}/t.xlsx')
p=pymupdf.open();g=p.new_page();g.insert_text((60,100),'Bonjour PDF',fontsize=30);p.new_page();p.save('${tmp}/f.pdf')`]);
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8599','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8599',POSTE_ORIGINES:P,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a',POSTE_COLLABORA_PUBLIC:C,POSTE_COLLABORA_INTERNE:C,POSTE_WOPI_INTERNE:P},stdio:'ignore'});
const fin=c=>{srv.kill();try{execFileSync('podman',['rm','-f','poste-collabora-test'],{stdio:'ignore'})}catch{};process.exit(c)};
execFileSync('podman',['run','-d','--replace','--name','poste-collabora-test','--network=pasta:-T,8599','-p','127.0.0.1:9981:9980','-e','aliasgroup1='+P,'-e','server_name=127.0.0.1:9981','-e','DONT_GEN_SSL_CERT=1','-e',`extra_params=--o:ssl.enable=false --o:ssl.termination=false --o:net.proto=IPv4 --o:welcome.enable=false --o:net.frame_ancestors=${P} --o:mount_jail_tree=false`,'docker.io/collabora/code:latest'],{stdio:'ignore'});
const att=async(f,ms,m)=>{const t=Date.now();for(;;){const v=await f().catch(()=>null);if(v)return v;if(Date.now()-t>ms)throw new Error('délai: '+m);await new Promise(r=>setTimeout(r,500))}};
(async()=>{await att(()=>fetch(P+'/api/auth/etat').then(r=>r.ok),15000,'poste');await att(()=>fetch(C+'/hosting/discovery').then(r=>r.ok),90000,'collabora');
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]].filter(x=>!process.env.SEUL||x[0]===process.env.SEUL)){
 const c=await b.newContext({...ctx,acceptDownloads:true});const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));p.on('console',m=>{if(/Content.Security|Refused/.test(m.text()))err.push('csp:'+m.text().slice(0,180))});
 await p.goto(P);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 const api=(u,o)=>p.evaluate(([u,o])=>fetch(u,o).then(async r=>({s:r.status,t:await r.text()})),[u,o]);
 const dep=async f=>{const r=await p.evaluate(async([f,b])=>{const a=Uint8Array.from(atob(b),c=>c.charCodeAt(0));return (await fetch('/api/espace/envoyer?nom='+f,{method:'POST',body:a})).status},[f,fs.readFileSync(path.join(tmp,f)).toString('base64')]);if(r!==200)err.push('envoi '+f)};
 const n=`${nom}.docx`;fs.copyFileSync(path.join(tmp,'a.docx'),path.join(tmp,n));await dep(n);await dep('f.pdf');
 const lire=async f=>JSON.parse((await api('/api/espace/lire?chemin='+f)).t).texte||'';
 if(nom==='pc'){await p.click('.nav-bascule');if((await p.locator('nav').boundingBox()).width>60)err.push('menu non réduit');await p.reload();await p.waitForSelector('.menu-reduit');await p.evaluate(()=>fetch('/api/espace/fichier',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({chemin:'large.md',contenu:'x'})}));await p.goto(P+'/#fichiers/f/large.md');await p.waitForSelector('textarea.editeur');const l=(await p.locator('textarea.editeur').boundingBox()).width;await p.screenshot({path:`${sortie}/pc-editeur-large.png`});if(l<1100)err.push('éditeur étroit: '+l);await p.click('.nav-bascule');await p.evaluate(()=>fetch('/api/espace/element?chemin=large.md',{method:'DELETE'}))}
 // PDF
 await p.goto(P+'/#fichiers/p/f.pdf');await p.waitForFunction(()=>{const c=document.querySelector('.fx-page');if(!c||!c.width)return false;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;for(let i=0;i<d.length;i+=4)if(d[i]<128&&d[i+3]>128)return true;return false},null,{timeout:30000});await p.screenshot({path:`${sortie}/${nom}-pdf.png`});
 if(await p.locator('.fx-page').count()!==2)err.push('pages pdf');
 // Milkdown
 await p.evaluate(()=>fetch('/api/espace/fichier',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({chemin:'n.md',contenu:'# Titre\n\nUn paragraphe'})}));
 await p.goto(P+'/#fichiers/f/n.md');await p.click('button:has-text("Visuel")');await p.waitForSelector('.editeur-visuel h1');await p.click('.editeur-visuel p');await p.keyboard.press('End');await p.keyboard.type(' ajouté ici');await p.waitForSelector('text=Enregistré',{timeout:8000});await p.waitForTimeout(1600);await p.screenshot({path:`${sortie}/${nom}-visuel.png`});
 const m=JSON.parse((await api('/api/espace/fichier?chemin=n.md')).t).contenu;if(!m.includes('Un paragraphe ajouté ici')||!m.includes('# Titre'))err.push('milkdown: '+m);
 await p.click('button:has-text("Source")');if(!(await p.inputValue('textarea.editeur')).includes('ajouté ici'))err.push('source');
 await p.evaluate(()=>fetch('/api/espace/element?chemin=n.md',{method:'DELETE'}));
 // Nouveau classeur Excel vierge ouvert dans Collabora
 await p.goto(P+'/#fichiers');await p.click('button:has-text("Nouveau")');await p.click('.fx-nouveau button:has-text("Classeur Excel")');await p.fill('input[aria-label="Nom du fichier"]',`classeur-${nom}`);await p.click('dialog button:has-text("Créer")');await p.waitForSelector('iframe.fx-cadre');await p.frameLocator('iframe.fx-cadre').locator('canvas').first().waitFor({timeout:60000});await p.waitForTimeout(6000);await p.screenshot({path:`${sortie}/${nom}-excel.png`});
 // Collabora : on écrit vraiment dans le document
 await p.goto(P+'/#fichiers');await p.click(`.fx-el[data-chemin="${n}"] .fx-nom`);await p.waitForSelector('iframe.fx-cadre');
 const f=p.frameLocator('iframe.fx-cadre');await f.locator('#document-canvas, canvas').first().waitFor({timeout:90000});await p.waitForTimeout(12000);await p.screenshot({path:`${sortie}/${nom}-collabora.png`});
 // La fenêtre de nouveautés de Collabora capte le clavier : on la ferme comme le ferait l'utilisateur.
 const accueil=p.frames().find(x=>x.url().includes('welcome.html'));
 if(accueil){for(const n of [1,2,3]){await accueil.locator(`#slide-${n}-button`).click({timeout:5000}).catch(()=>{});await p.waitForTimeout(900)}await p.waitForTimeout(1500)}
 const coeur=p.frames().find(x=>x.url().includes('cool.html'));await coeur.locator('text=Passer').first().click({timeout:6000}).catch(()=>{});await p.waitForTimeout(1500);
 if(nom==='mobile'){await coeur.locator('#mobile-edit-button').click({timeout:15000});await p.waitForTimeout(3000)}
 const boite=await p.locator('iframe.fx-cadre').boundingBox();await p.mouse.click(boite.x+boite.width/2,boite.y+boite.height/2);await p.waitForTimeout(800);await p.keyboard.type('ECRITDANSCOLLABORA',{delay:60});await p.waitForTimeout(3000);await p.screenshot({path:`${sortie}/${nom}-collabora2.png`});
 await p.goto(P+'/#fichiers');
 await att(async()=>(await lire(n)).includes('ECRITDANSCOLLABORA'),90000,'enregistrement collabora');
 const jetes=JSON.parse((await api('/api/espace/corbeille')).t);if(!jetes.some(j=>j.chemin===n))err.push('pas de sauvegarde: '+JSON.stringify(jetes.map(j=>j.chemin)));
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();fin(tot?1:0)})().catch(e=>{console.error(String(e).slice(0,600));fin(2)})
