// Micro à côté des champs, dictée réelle (voix espeak-ng, vrai moteur local) : node tests/micro.cjs <dossier-captures>
const {spawn}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-micro-'));const wav=tmp+'/voix48.wav';require('child_process').execSync(`espeak-ng -v fr -s 140 -w ${tmp}/voix.wav "Rappeler le comptable pour la facture de novembre" && ffmpeg -loglevel error -y -i ${tmp}/voix.wav -af apad=pad_dur=3 -ar 48000 -ac 1 ${wav}`);const U='http://127.0.0.1:8590';
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8590','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8590',POSTE_ORIGINES:U,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
(async()=>{let ok=false;for(let i=0;i<60&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+wav,'--autoplay-policy=no-user-gesture-required']});
const c=await b.newContext({...devices['Pixel 7'],permissions:['microphone']});const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push(e.message));
await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
const essai=async(page,champ,etiquette,avant)=>{await p.goto(U+'/#'+page);await p.waitForLoadState('networkidle');await p.waitForTimeout(800);await p.waitForSelector(champ);await p.fill(champ,avant);await p.click(`button.micro[aria-label="${etiquette}"]`);
 let v='';for(let i=0;i<60&&!/facture/i.test(v);i++){await p.waitForTimeout(250);v=await p.inputValue(champ)}
 await p.screenshot({path:`${sortie}/micro-${page}.png`});await p.click('button.micro.actif').catch(()=>{});await p.waitForFunction(()=>!document.querySelector('button.micro.actif'),{timeout:10000});
 v=await p.inputValue(champ);console.log(page,'→',JSON.stringify(v));if(!/facture/i.test(v)||!v.startsWith(avant))err.push(page+': '+v)};
await essai('accueil','.barre-hermes input','Dicter à Hermes','Note :');
await essai('taches','input[aria-label="Nouvelle tâche"]','Dicter','');
console.log(err.length?err:'ok');await b.close();srv.kill();process.exit(err.length?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(1)});
