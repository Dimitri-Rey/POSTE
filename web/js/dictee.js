// Dictée en direct : le micro part vers le serveur, qui renvoie le texte pendant qu'on parle. Rien ne sort de la machine.

const DUREE_MAX_S = 300;

export const dicteePossible = () =>
  Boolean(navigator.mediaDevices?.getUserMedia) && "AudioWorkletNode" in window && "WebSocket" in window;

const duree = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// rappels : texte(texte complet dicté), etat(message), erreur(message), fin(), niveau(volume 0 à 1, facultatif).
// À appeler dans le geste de l'utilisateur : le contexte audio démarrerait sinon en pause.
export async function dicter({ texte, etat, erreur, fin, niveau = null }) {
  const contexte = new AudioContext();
  let flux;
  try {
    flux = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    contexte.close();
    erreur("Micro refusé. Autorise-le dans les réglages, et installe la dernière APK sur le téléphone.");
    fin();
    return { arreter() {} };
  }

  const phrases = [];
  let enCours = "";
  let termine = false;
  let enErreur = false;
  let morceaux = 0;
  let chrono = 0;
  let source = null;
  let capteur = null;
  let mesure = 0;
  const attente = [];
  const montrer = () => texte([...phrases, enCours].filter(Boolean).join(" "));

  const couperMicro = () => {
    clearInterval(chrono);
    clearInterval(mesure);
    flux.getTracks().forEach((piste) => piste.stop());
    source?.disconnect();
    capteur?.disconnect();
    if (contexte.state !== "closed") contexte.close();
  };

  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/dictee`);
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => attente.splice(0).forEach((m) => ws.send(m)));
  ws.addEventListener("message", ({ data }) => {
    const m = JSON.parse(data);
    if (m.type === "partiel") {
      enCours = m.texte;
      montrer();
    } else if (m.type === "final") {
      phrases.push(m.texte);
      enCours = "";
      montrer();
    } else if (m.type === "erreur") {
      enErreur = true;
      erreur(m.texte);
    } else if (m.type === "fin") {
      ws.close();
    }
  });
  ws.addEventListener("close", () => {
    couperMicro();
    // Coupure en pleine phrase : on garde ce qui était déjà affiché.
    if (enCours) {
      phrases.push(enCours);
      enCours = "";
      montrer();
    }
    if (!termine && !enErreur) erreur("Dictée interrompue : serveur injoignable.");
    fin();
  });

  const arreter = () => {
    if (termine) return;
    termine = true;
    couperMicro();
    if (ws.readyState === WebSocket.OPEN) {
      etat("Dernière phrase…");
      ws.send("fin");
    } else {
      ws.close();
    }
  };

  try {
    await contexte.audioWorklet.addModule("/js/capteur-audio.js");
  } catch {
    enErreur = true;
    erreur("Ce navigateur ne sait pas diffuser le micro.");
    ws.close();
    return { arreter() {} };
  }
  capteur = new AudioWorkletNode(contexte, "capteur-audio");
  capteur.port.onmessage = ({ data }) => {
    morceaux += 1;
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
    else if (ws.readyState === WebSocket.CONNECTING) attente.push(data);
  };
  source = contexte.createMediaStreamSource(flux);
  source.connect(capteur);
  capteur.connect(contexte.destination); // Sortie muette : garde le nœud actif dans le graphe audio.
  if (niveau) {
    const analyseur = contexte.createAnalyser();
    analyseur.fftSize = 1024;
    source.connect(analyseur);
    const echantillons = new Float32Array(analyseur.fftSize);
    mesure = setInterval(() => {
      analyseur.getFloatTimeDomainData(echantillons);
      let somme = 0;
      for (const x of echantillons) somme += x * x;
      niveau(Math.sqrt(somme / echantillons.length));
    }, 50);
  }
  contexte.resume();

  const debut = Date.now();
  etat("Je t'écoute… 0:00");
  chrono = setInterval(() => {
    const s = Math.floor((Date.now() - debut) / 1000);
    if (s >= DUREE_MAX_S) arreter();
    else if (s >= 3 && morceaux === 0) etat("Le micro ne transmet aucun son : arrête et réessaie.");
    else etat(`Je t'écoute… ${duree(s)}`);
  }, 500);
  return { arreter };
}
