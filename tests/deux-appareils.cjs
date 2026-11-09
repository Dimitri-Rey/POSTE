// PC et téléphone sur la même demande, avec le vrai Hermes et le vrai moteur : node tests/deux-appareils.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-'));const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8599','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8599',POSTE_ORIGINES:'http://127.0.0.1:8599',POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0'},stdio:'ignore'});const U='http://127.0.0.1:8599';
(async()=>{let ok=false;for(let i=0;i<40&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});const err=[];
const pc=await (await b.newContext({viewport:{width:1280,height:800}})).newPage();const tel=await (await b.newContext(devices['Pixel 7'])).newPage();for(const p of [pc,tel])p.on('pageerror',e=>err.push(e.message));
await pc.goto(U);await pc.fill('.seuil input','mot-de-passe-de-test');await pc.click('.seuil button');await pc.waitForSelector('nav');
await tel.goto(U);await tel.fill('.seuil input','mot-de-passe-de-test');await tel.click('.seuil button');await tel.waitForSelector('nav');
for(const p of [pc,tel]){await p.goto(U+'/#hermes');await p.waitForSelector('.saisie');await p.waitForTimeout(800);await p.click(p===pc?'.volet-tete .plein':'.nouvelle-mobile')}
const Q='Pas besoin de plan : lance seulement la commande git --version et donne le résultat.';
await pc.fill('.saisie textarea',Q);await pc.click('button.plein:has-text("Envoyer")');
// Le téléphone, resté sur une conversation vide, doit suivre tout seul.
await tel.waitForFunction(q=>document.querySelector('.fil').textContent.includes(q),Q,{timeout:12000}).catch(()=>err.push('question absente sur le téléphone'));
await pc.waitForSelector('.decision:not(.repondue)',{timeout:60000}).catch(()=>err.push('pas de confirmation sur le PC'));
await tel.waitForSelector('.decision:not(.repondue)',{timeout:12000}).catch(()=>err.push('pas de confirmation sur le téléphone'));
await tel.screenshot({path:sortie+'/tel-confirmation.png'});
// Réponse sur le téléphone : la carte du PC doit changer, puis les deux voient la fin.
await tel.click('.decision button:has-text("Autoriser")');
await pc.waitForFunction(()=>[...document.querySelectorAll('.decision')].some(c=>c.textContent.includes('autre appareil')),null,{timeout:10000}).catch(()=>err.push('carte PC non retirée'));
const finie=p=>p.waitForFunction(()=>!document.querySelector('.activite')&&document.querySelector('button.plein')&&!document.querySelector('.saisie button.plein').hidden&&document.querySelector('.bulle.assistant')?.textContent.length>3,null,{timeout:90000}).catch(()=>err.push('pas de fin sur un appareil'));
await Promise.all([finie(pc),finie(tel)]);
if(await pc.$('.decision:not(.repondue)'))err.push('nouvelle confirmation sur PC');
const txt=async p=>(await p.textContent('.fil'));const a=await txt(pc),c=await txt(tel);console.log('PC:',a.slice(0,160).replace(/\s+/g,' '));console.log('TEL:',c.slice(0,160).replace(/\s+/g,' '));
if(!/git version/i.test(a))err.push('résultat absent PC');if(!/git version/i.test(c))err.push('résultat absent tél');
await tel.screenshot({path:sortie+'/tel-fin.png'});
// Puis l'inverse : message du téléphone vu par le PC, sans bouger.
await tel.fill('.saisie textarea','Réponds juste : bien reçu.');await tel.click('button.plein:has-text("Envoyer")');
await pc.waitForFunction(()=>document.querySelector('.fil').textContent.includes('Réponds juste'),null,{timeout:12000}).catch(()=>err.push('message du téléphone absent du PC'));
await pc.waitForFunction(()=>[...document.querySelectorAll('.bulle.assistant')].at(-1)?.textContent.toLowerCase().includes('bien reçu'),null,{timeout:60000}).catch(()=>err.push('réponse absente du PC'));
const cid=await pc.evaluate(()=>sessionStorage.getItem('hermes-conversation'));fs.writeFileSync(sortie+'/conv-deux',cid||'');
console.log(err.length?err:'ok');await b.close();srv.kill();process.exit(err.length?1:0)})().catch(e=>{console.error(e.message);srv.kill();process.exit(2)})
