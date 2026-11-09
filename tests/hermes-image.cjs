// Hermes avec un modèle qui voit : la photo part telle quelle (réduite), sinon l'OCR. Usage : node tests/hermes-image.cjs <image.png>
const {chromium,devices}=require(process.env.PLAYWRIGHT);const {spawn}=require('child_process');const fs=require('fs'),os=require('os');
const P='http://127.0.0.1:8580';const tmp=fs.mkdtempSync(os.tmpdir()+'/hi');const image=process.argv[2];
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8580','--app-dir','api'],{env:{...process.env,POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8580',POSTE_ORIGINES:P,POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0',POSTE_JETON_AGENT:tmp+'/a'},stdio:'ignore'});
const json=(r,o,s=200)=>r.fulfill({status:s,contentType:'application/json',body:JSON.stringify(o)});
(async()=>{for(let i=0;i<60;i++){if(await fetch(P+'/api/auth/etat').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,250))}
const b=await chromium.launch({executablePath:process.env.CHROME});let tot=0;
for(const vision of [true,false]){
 const c=await b.newContext(devices['Pixel 7']);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));const envois=[],documents=[];
 await c.route(/\/api\/hermes\/modele$/,r=>json(r,{actif:vision?'vision':'precis',pret:true,arrete:false,demarrable:true,vision,choix:[{id:'precis',nom:'Précis',vision:false},{id:'vision',nom:'Vision',vision:true}]}));
 await c.route(/\/api\/hermes\/habitudes$/,r=>json(r,[]));
 await c.route(/\/api\/hermes\/conversations(\?.*)?$/,r=>json(r,[]));
 await c.route(/\/api\/hermes\/envoyer$/,r=>{envois.push(JSON.parse(r.request().postData()));json(r,{run_id:'r1',conversation:'c1'})});
 await c.route(/\/api\/hermes\/executions\/r1(\/.*)?$/,r=>r.request().url().endsWith('/flux')?r.abort():json(r,{statut:'running',sortie:'',approbation:null}));
 await c.route(/\/api\/documents(\?.*|\/.*)?$/,r=>{documents.push(r.request().method());json(r,r.request().method()==='POST'?{id:'d1'}:{statut:'pret',methode:'OCR',nom:'formes.png'})});
 await p.goto(P);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 await p.goto(P+'/#hermes');await p.waitForSelector('.saisie');await p.waitForTimeout(500);
 await p.setInputFiles('.saisie input[type=file]',image);
 await p.waitForSelector('.joint.pret');
 const methode=await p.textContent('.joint');
 await p.click('.saisie button[aria-label="Envoyer"]');await p.waitForTimeout(600);
 const e=envois[0]||{};
 if(vision){
  if(!methode.includes("Image vue par l'IA"))err.push('méthode '+methode);
  if(!e.image?.startsWith('data:image/jpeg;base64,'))err.push('pas d\'image envoyée');
  if(e.texte!=='Décris cette image.'||e.documents?.length)err.push('envoi '+e.texte+' '+JSON.stringify(e.documents));
  if(documents.length)err.push('passé par l\'OCR');
  const taille=await p.evaluate(src=>new Promise(ok=>{const i=new Image();i.onload=()=>ok([i.width,i.height]);i.src=src}),e.image||'');
  if(taille[0]!==1600||taille[1]!==800)err.push('taille '+taille);
  if(!(await p.textContent('.fil')).includes('[Image : formes.png]'))err.push('bulle');
 }else{
  if(e.image)err.push('image envoyée à un modèle qui ne voit pas');
  if(!documents.includes('POST')||e.documents?.[0]?.id!=='d1')err.push('OCR absent');
 }
 console.log(vision?'vision':'sans vision',err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();process.exitCode=tot?1:0})().catch(e=>{console.log('ÉCHEC',String(e).slice(0,400));process.exitCode=1}).finally(()=>{srv.kill();setTimeout(()=>process.exit(),200)});
