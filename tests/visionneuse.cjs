// Visionneuse d'images, vrai serveur : node tests/visionneuse.cjs <dossier-captures>
const {spawn,execFileSync}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-vis-'));
const U='http://127.0.0.1:8595';
for(const [n,c] of [['a','#c0392b'],['b','#2980b9'],['c','#27ae60']])execFileSync('magick',['-size','640x400',`xc:${c}`,`${tmp}/${n}.png`]);
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8595','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8595',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const [nom,ctx] of [['pc',{viewport:{width:1280,height:800}}],['mobile',devices['Pixel 7']]]){
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 if(nom==='pc')for(const f of ['a','b','c']){const s=await p.evaluate(async([f,b64])=>{const a=Uint8Array.from(atob(b64),x=>x.charCodeAt(0));return (await fetch('/api/espace/envoyer?nom='+f+'.png',{method:'POST',body:a})).status},[f,fs.readFileSync(`${tmp}/${f}.png`).toString('base64')]);if(s!==200)err.push('envoi '+f)}
 await p.goto(U+'/#fichiers');await p.waitForSelector('.fx-el[data-chemin="b.png"]');await p.click('.fx-el[data-chemin="b.png"] .fx-nom');
 await p.waitForSelector('dialog.fx-visionneuse img.fx-image-vue');await p.waitForFunction(()=>document.querySelector('.fx-image-vue').naturalWidth===640);
 const etat=()=>p.evaluate(()=>({n:document.querySelector('.fx-vis-compteur').textContent,t:document.querySelector('.fx-vis-titre').textContent,tr:document.querySelector('.fx-image-vue').style.transform}));
 if((await etat()).n!=='2 / 3')err.push('compteur '+(await etat()).n);
 if(await p.locator('.fx-miniature').count()!==3)err.push('galerie');
 await p.click('button[aria-label="Image suivante"]');if((await etat()).t!=='c.png')err.push('suivante');
 await p.click('button[aria-label="Image suivante"]');if((await etat()).t!=='a.png')err.push('boucle');
 if(nom==='pc'){await p.keyboard.press('ArrowLeft');if((await etat()).t!=='c.png')err.push('flèche')}
 else{const bx=await p.locator('.fx-scene').boundingBox();await p.mouse.move(bx.x+bx.width*0.8,bx.y+bx.height/2);await p.mouse.down();await p.mouse.move(bx.x+bx.width*0.2,bx.y+bx.height/2,{steps:5});await p.mouse.up();if((await etat()).t!=='b.png')err.push('balayage: '+(await etat()).t)}
 await p.click('button[aria-label="Zoomer"]');await p.click('button[aria-label="Tourner à droite"]');
 const tr=(await etat()).tr;if(!tr.includes('scale(1.25)')||!tr.includes('rotate(90deg)'))err.push('zoom/rotation: '+tr);
 await p.waitForTimeout(400);await p.screenshot({path:`${sortie}/visionneuse-${nom}.png`});
 await p.click('button[aria-label="Taille ajustée"]');if(!(await etat()).tr.includes('scale(1)'))err.push('ajuster');
 await p.click('.fx-miniature >> nth=0');if((await etat()).t!=='a.png')err.push('miniature');
 await p.click('button[aria-label="Diaporama"]');await p.waitForTimeout(4300);if((await etat()).t!=='b.png')err.push('diaporama: '+(await etat()).t);
 await p.click('button[aria-label="Arrêter le diaporama"]');await p.waitForTimeout(4300);if((await etat()).t!=='b.png')err.push('arrêt diaporama');
 await p.click('dialog button:has-text("Fermer")');await p.waitForSelector('dialog.fx-visionneuse',{state:'detached'});
 console.log(nom,err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
