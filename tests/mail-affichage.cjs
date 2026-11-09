// Affichage d'un mail HTML : le cadre doit vraiment se charger (CSP de la page comprise), rester isolé et ne rien couper.
// Le mail est produit par le vrai code de Poste (nettoyage, gabarit, politique du cadre). node tests/mail-affichage.cjs <dossier-captures>
const {spawn,execFileSync}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
const {chromium,devices}=require(process.env.PLAYWRIGHT);const sortie=process.argv[2];
const F=JSON.parse(execFileSync('.venv/bin/python',['-c',`
import json, sys
sys.path.insert(0, "api")
from poste.modules import mails
brut = ('<script>window.parent.PIRATE=1</script><table width="640" style="width:640px"><tr><td>'
        '<h1>Programme du trimestre</h1><p><a id="bon" href="https://ligue.example/programme">Voir le programme</a></p>'
        '<p><a id="ruse" href="https://mal.example/x">https://ligue.example/inscription</a></p>'
        '<img src="https://images.example/banniere.png" width="600" height="200" alt="">' + '<p>Ligne de texte.</p>' * 40 + '</td></tr></table>')
print(json.dumps({"brut": mails.GABARIT.format(mails._nettoyer(brut, {})), "csp": mails.politique_mail(False), "csp2": mails.politique_mail(True)}))
`],{env:{...process.env,POSTE_CONFIG:'/dev/null'}}).toString());
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'poste-'));
fs.writeFileSync(tmp+'/poste.toml','[collabora]\nadresse_publique = "https://collabora.exemple.test"\n');
const srv=spawn('.venv/bin/uvicorn',['poste.app:creer','--factory','--port','8612','--app-dir','api'],{env:{...process.env,POSTE_CONFIG:tmp+'/poste.toml',POSTE_CLE:tmp+'/cle',POSTE_JETON_AGENT:tmp+'/a',POSTE_BASE:tmp+'/t.db',POSTE_HOTES:'127.0.0.1:8612',POSTE_ORIGINES:'http://127.0.0.1:8612',POSTE_COOKIE_SECURE:'0',POSTE_TACHES_DE_FOND:'0'},stdio:'ignore'});
const U='http://127.0.0.1:8612';let tot=0;
(async()=>{let ok=false;for(let i=0;i<40&&!ok;i++){await new Promise(r=>setTimeout(r,250));ok=await fetch(U+'/api/auth/etat').then(r=>r.ok).catch(()=>false)}
const b=await chromium.launch({executablePath:process.env.CHROME});
for(const [nom,ctx] of [['mobile',devices['Pixel 7']],['pc',{viewport:{width:1280,height:800}}]])for(const suspect of [false,true]){
 const encoche=nom==='mobile'&&!suspect;
 const c=await b.newContext(ctx);const p=await c.newPage();const err=[];p.on('pageerror',e=>err.push('js:'+e.message));
 const externes=[];
 await c.route('**/api/mails/**',r=>{const u=new URL(r.request().url());const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});
  if(u.pathname.endsWith('/comptes'))return j([{id:'c',adresse:'a@b.fr'}]);
  if(u.pathname.endsWith('/html')){const img=u.search.includes('images=true');return r.fulfill({status:200,contentType:'text/html',headers:{'content-security-policy':img?F.csp2:F.csp,'x-frame-options':'SAMEORIGIN'},body:F.brut})}
  return j({de:'Ligue <contact@ligue.example>',a:'moi',sujet:'Programme du trimestre',ts:Date.now()/1000,message_id:'x',texte:'brut',alertes:suspect?['Nom de marque, domaine sans rapport']:[],analyse:suspect?{niveau:'dangereux',raisons:['Nom de marque, domaine sans rapport']}:{niveau:'sain',raisons:[]},expediteur:'contact@ligue.example',lien_fournisseur:null,a_html:true,images_distantes:true,pieces_jointes:[]})});
 await c.route(/images\.example/,r=>{externes.push(r.request().url());return r.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64')})});
 await p.addInitScript(()=>{window.__ouverts=[];window.open=(u)=>{window.__ouverts.push(u)}});
 await p.goto(U);await p.fill('.seuil input','mot-de-passe-de-test');await p.click('.seuil button');await p.waitForSelector('nav');
 const bloques=[];p.on('console',m=>{if(/Content Security Policy|frame-src/i.test(m.text()))bloques.push(m.text())});
 await p.goto(U+'/#mails/c/1');await p.waitForSelector('.cadre-mail');
 try{await p.waitForFunction(()=>document.querySelector('.cadre-mail').contentDocument?.querySelector('#bon'),null,{timeout:8000})}catch{console.log(nom,'CADRE NON CHARGÉ',bloques.join(' | ').slice(0,300));tot++;await c.close();continue}await p.waitForTimeout(400);
 const m=await p.evaluate(()=>{const f=document.querySelector('.cadre-mail');const d=f.contentDocument;return{pirate:window.PIRATE,zoom:d.body.style.zoom,h:f.clientHeight,sh:d.documentElement.scrollHeight,sw:d.documentElement.scrollWidth,w:f.clientWidth,deb:document.documentElement.scrollWidth>innerWidth}});
 console.log(nom,suspect?'suspect':'normal',JSON.stringify(m));
 if(m.pirate)err.push('SCRIPT EXÉCUTÉ');if(m.sw>m.w+1)err.push('trop large');if(m.h<m.sh-1)err.push('coupé');if(m.deb)err.push('page déborde');
 if(externes.length)err.push('requête externe sans demande '+externes);
 await p.screenshot({path:`${sortie}/mail-${nom}-${suspect?'suspect':'normal'}.png`,fullPage:true});
 if(encoche){const cdp=await c.newCDPSession(p);await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:40,bottom:20}}).catch(e=>console.log('pas d\'émulation d\'encoche',e.message));
  await p.waitForTimeout(300);await p.evaluate(()=>document.querySelector('main').scrollTo(0,0));await p.screenshot({path:`${sortie}/mail-encoche-haut.png`});
  await p.evaluate(()=>document.querySelector('main').scrollTo(0,350));await p.waitForTimeout(300);await p.screenshot({path:`${sortie}/mail-encoche-defile.png`});
  const g=await p.evaluate(()=>{const b=document.querySelector('.barre-lecteur').getBoundingClientRect();const o=document.querySelector('.objet-mail').getBoundingClientRect();return{barre:[Math.round(b.top),Math.round(b.bottom)],objet:[Math.round(o.top),Math.round(o.bottom)]}});
  console.log('encoche',JSON.stringify(g));await p.evaluate(()=>document.querySelector('main').scrollTo(0,0))}
 const fr=p.frameLocator('.cadre-mail');
 await fr.locator('#bon').click();
 if(suspect){const o=await p.evaluate(()=>window.__ouverts.length);if(o)err.push('lien ouvert sur suspect');if(!(await p.textContent('.mail-html .alerte')).includes('ligue.example'))err.push('destination non montrée');if(await p.$('.barre-images button'))err.push('bouton images sur suspect')}
 else{const o=await p.evaluate(()=>window.__ouverts);if(o[0]!=='https://ligue.example/programme')err.push('lien '+o);
  let vu='';p.once('dialog',d=>{vu=d.message();d.dismiss()});await fr.locator('#ruse').click();await p.waitForTimeout(150);if(!vu.includes('mal.example'))err.push('ruse non signalée');if((await p.evaluate(()=>window.__ouverts.length))!==1)err.push('ruse ouverte');
  await p.click('.barre-images button');await p.waitForTimeout(700);if(!externes.some(u=>u.includes('images.example')))err.push('images non chargées');await p.screenshot({path:`${sortie}/mail-${nom}-images.png`,fullPage:true})}
 console.log(' ',err.length?err:'ok');tot+=err.length;await c.close()}
await b.close();srv.kill();process.exit(tot?1:0)})().catch(e=>{console.error(e);srv.kill();process.exit(2)})
