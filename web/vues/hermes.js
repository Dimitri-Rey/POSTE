import { creerOnde } from "../js/onde.js";
import { dicter, dicteePossible } from "../js/dictee.js";
import { ouvrirLecteur } from "../js/lecteur.js";
import { choisirDansFichiers } from "../js/choix-fichiers.js";
import { rendreMarkdown } from "../js/markdown.js";
import { ajouterLivrables, construireApercu, poserHoteApercu } from "../js/apercu.js";
import { api, el, quand, toast, vide, surRetour } from "../js/outils.js";

let conversation = sessionStorage.getItem("hermes-conversation");
let fluxOuvert = null;

const MARQUE_DOCUMENTS = "[Documents joints, à lire avec poste_lire_document]";

// Vitesses du moteur pour une question : lecture (au-dessus de la question), génération (sous la réponse). En petit.
const nombre = (n) => Number(n).toLocaleString("fr-FR");
function ligneLecture(m) {
  const l = m?.lecture;
  if (!l?.tokens) return null;
  return el("div", { class: "mesure-ia lecture", title: "Ce que le moteur a lu pour répondre (ta question, la conversation et les outils)" },
    [`Lu ${nombre(l.tokens)} tokens`, l.caches ? `${nombre(l.caches)} en cache` : "", l.vitesse ? `${nombre(l.vitesse)} tok/s` : ""].filter(Boolean).join(" · "));
}
function ligneGeneration(m) {
  const g = m?.generation;
  if (!g?.tokens) return null;
  return el("div", { class: "mesure-ia generation", title: "Écriture de la réponse par le moteur" },
    [`${nombre(g.tokens)} tokens`, g.vitesse ? `${nombre(g.vitesse)} tok/s` : "", g.secondes ? `${nombre(g.secondes)} s` : ""].filter(Boolean).join(" · "));
}

// Historique : lecture au-dessus de chaque question mesurée, génération sous la dernière réponse de ce tour.
function messagesAvecMesures(messages) {
  const sortie = [];
  let enAttente = null;
  const poserGeneration = () => { if (enAttente) sortie.push(enAttente); enAttente = null; };
  for (const m of messages) {
    if (m.role === "user") {
      poserGeneration();
      const l = ligneLecture(m.mesures);
      if (l) sortie.push(l);
      enAttente = ligneGeneration(m.mesures);
    }
    sortie.push(bulle(m.role, m.texte));
  }
  poserGeneration();
  return sortie;
}

function bulle(role, texte) {
  if (role === "assistant") {
    const b = el("div", { class: "bulle assistant" }, rendreMarkdown(texte));
    ajouterLivrables(b);
    return b;
  }
  const coupe = texte.indexOf(MARQUE_DOCUMENTS);
  if (role !== "user" || coupe < 0) return el("div", { class: `bulle ${role}` }, texte);
  // Document joint : un clic montre le texte que Hermes en a lu, dans le lecteur léger.
  const joints = texte.slice(coupe).split("\n").slice(1).map((l) => l.match(/^- ([0-9a-f]{32}) : (.+)$/) || [null, null, l.replace(/^- /, "")]);
  return el("div", { class: "bulle user" }, texte.slice(0, coupe).trimEnd(),
    el("div", { class: "joints" }, joints.map(([, id, nom]) => (id
      ? el("button", { type: "button", class: "joint ouvrable", title: "Voir le texte lu", onclick: () => ouvrirLecteur({ adresse: `/api/documents/${id}/texte`, nom, genre: "texte" }) }, nom)
      : el("span", { class: "joint" }, nom)))));
}

function carteDecision(runId, a, fil) {
  // Se raccrocher à une exécution peut redonner une demande déjà affichée.
  if (a.request_id && fil.querySelector(`[data-demande="${CSS.escape(a.request_id)}"]`)) return;
  const carte = el("div", { class: "decision", role: "group", "aria-label": "Confirmation demandée", "data-demande": a.request_id, "data-affichee": Date.now() });
  const repondre = async (choix) => {
    carte.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    try {
      await api(`/api/hermes/executions/${runId}/decision`, {
        methode: "POST", corps: { choix, request_id: a.request_id },
      });
      carte.classList.add("repondue");
      carte.replaceChildren(el("span", { class: "doux petit" },
        { once: "Autorisé", always: `Toujours autorisé : ${a.habitude}`, deny: "Refusé" }[choix]));
    } catch (err) {
      carte.append(el("p", { class: "erreur" }, err.message));
    }
  };
  carte.append(
    el("p", { class: "explication" }, "Hermes prépare l'explication…"),
    el("p", { class: "action-exacte mono petit" }, a.description),
    el("div", { class: "boutons" },
      el("button", { class: "plein autoriser", onclick: () => repondre("once") }, "Autoriser"),
      a.habitude ? el("button", { onclick: () => repondre("always") }, `Toujours : ${a.habitude}`) : null,
      el("button", { class: "refuser", onclick: () => repondre("deny") }, "Refuser")),
    el("p", { class: "raccourcis doux petit" }, "Entrée : autoriser · Suppr ou Retour arrière : refuser"));
  fil.append(carte);
  fil.scrollTop = fil.scrollHeight;
}

// Une seule vérité, l'état de l'exécution : une demande apparaît partout, et disparaît dès qu'un appareil a répondu.
function synchroniserConfirmation(runId, approbation, fil, activite) {
  fil.querySelectorAll(".decision:not(.repondue)").forEach((carte) => {
    if (carte.dataset.demande === approbation?.request_id) return;
    carte.classList.add("repondue");
    carte.replaceChildren(el("span", { class: "doux petit" }, "Répondu sur un autre appareil"));
  });
  if (approbation) {
    activite.textContent = "En attente de ta confirmation";
    carteDecision(runId, approbation, fil);
    if (approbation.explication_prete) {
      const zone = fil.querySelector(`.decision[data-demande="${CSS.escape(approbation.request_id)}"] .explication`);
      if (zone) zone.textContent = approbation.explication || "Explication indisponible : regarde l'action exacte ci-dessous.";
    }
  }
}

function ecouter(runId, fil, surFin) {
  fluxOuvert?.close();
  let finie = false;
  const reponse = bulle("assistant", "");
  // Écriture au fil de l'eau, comme dans Claude : le texte reçu se déroule à un rythme régulier (rattrape vite un gros
  // morceau, ralentit en fin), avec un curseur tant que Hermes écrit. Le moteur local répond souvent d'un bloc.
  let brut = "";
  let montre = 0;
  let image = 0;
  let livrableOuvert = false;
  const lent = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const enBas = () => fil.scrollHeight - fil.scrollTop - fil.clientHeight < 140;
  const peindre = () => {
    const suivre = enBas();
    reponse.replaceChildren(...rendreMarkdown(brut.slice(0, montre)));
    reponse.classList.toggle("ecrit", !finie || montre < brut.length);
    ajouterLivrables(reponse);
    // Comme dans Claude : un fichier tout juste créé s'ouvre de lui-même à côté de la conversation (PC large seulement).
    if (finie && montre >= brut.length && !livrableOuvert) {
      livrableOuvert = true;
      const dernier = [...reponse.querySelectorAll(".livrable")].pop();
      if (dernier && matchMedia("(min-width: 1100px)").matches) dernier.querySelector(".livrable-ouvrir").click();
    }
    if (suivre) fil.scrollTop = fil.scrollHeight;
  };
  const derouler = () => {
    image = 0;
    const reste = brut.length - montre;
    if (reste <= 0) { peindre(); return; }
    // Au plus 12 caractères par image (~700/s) : un rythme de lecture ; un gros retard se rattrape quand même vite.
    montre += lent ? reste : Math.max(2, Math.min(Math.ceil(reste / 30), 12));
    peindre();
    image = requestAnimationFrame(derouler);
  };
  const ecrire = (texte) => {
    brut = texte;
    if (montre > brut.length) montre = 0; // texte final différent du flux : on repart du début
    if (!image) image = requestAnimationFrame(derouler);
  };
  const activite = el("p", { class: "doux petit activite" }, "Hermes réfléchit…");
  fil.append(reponse, activite);
  const flux = new EventSource(`/api/hermes/executions/${runId}/flux`);
  fluxOuvert = flux;
  let controle = 0;
  const fin = () => {
    if (finie) return;
    finie = true;
    clearInterval(controle);
    flux.close();
    activite.remove();
    if (!image) peindre(); // retire le curseur une fois tout affiché
    surFin();
  };
  // Hermes n'annonce pas toujours la fin (après un arrêt, notamment) : on vérifie aussi l'état réel, sans dépendre du flux.
  controle = setInterval(async () => {
    if (flux !== fluxOuvert) {
      clearInterval(controle);
      return;
    }
    const etat = await api(`/api/hermes/executions/${runId}`).catch(() => null);
    if (!etat || finie) return;
    synchroniserConfirmation(runId, etat.approbation, fil, activite);
    if (!["completed", "failed", "cancelled"].includes(etat.statut)) return;
    if (etat.sortie) ecrire(etat.sortie);
    if (etat.statut === "cancelled") fil.append(el("p", { class: "doux petit" }, "Arrêté. Tu peux continuer la conversation."));
    if (etat.statut === "failed") fil.append(el("p", { class: "erreur" }, etat.erreur || "Exécution interrompue."));
    fin();
    fil.scrollTop = fil.scrollHeight;
  }, 2000);
  flux.onmessage = ({ data }) => {
    const e = JSON.parse(data);
    if (e.event === "message.delta") {
      ecrire(brut + e.delta);
      activite.textContent = "";
    } else if (e.event === "poste.mesures") {
      const question = [...fil.querySelectorAll(".bulle.user")].pop();
      const lecture = ligneLecture(e);
      if (question && lecture && !question.previousElementSibling?.classList.contains("mesure-ia")) question.before(lecture);
      const generation = ligneGeneration(e);
      if (generation) reponse.after(generation);
    } else if (e.event === "tool.started") {
      activite.textContent = `${e.tool}${e.preview ? ` : ${e.preview}` : ""}`;
    } else if (e.event === "run.completed") {
      if (e.output) ecrire(e.output);
      fin();
    } else if (e.event === "run.cancelled") {
      fil.append(el("p", { class: "doux petit" }, "Arrêté. Tu peux continuer la conversation."));
      fin();
    } else if (e.event === "run.failed") {
      fil.append(el("p", { class: "erreur" }, /connection error/i.test(e.error || "")
        ? "Le moteur IA ne répond pas : il a peut-être redémarré. Hermes n'a pas pu finir, renvoie ton message quand il sera prêt."
        : e.error || "Exécution interrompue."));
      fin();
    }
    fil.scrollTop = fil.scrollHeight;
  };
  // Connexion coupée (téléphone en veille) : on récupère l'état réel de l'exécution.
  flux.onerror = async () => {
    flux.close();
    const etat = await api(`/api/hermes/executions/${runId}`).catch(() => null);
    if (etat?.sortie) ecrire(etat.sortie);
    if (etat) synchroniserConfirmation(runId, etat.approbation, fil, activite);
    if (!etat || ["completed", "failed", "cancelled"].includes(etat.statut)) fin();
    else setTimeout(() => flux === fluxOuvert && ecouter(runId, fil, surFin), 3000);
  };
}

async function blocReglages() {
  const [modele, habitudes] = await Promise.all([api("/api/hermes/modele"), api("/api/hermes/habitudes")]);
  const liste = el("div", {});
  const dessiner = (noms) => liste.replaceChildren(...(noms.length
    ? noms.map((nom) => el("div", { class: "ligne" },
      el("span", { class: "corps mono" }, nom),
      el("button", {
        class: "lien petit",
        onclick: async () => {
          await api(`/api/hermes/habitudes/${encodeURIComponent(nom)}`, { methode: "DELETE" });
          dessiner(noms.filter((x) => x !== nom));
        },
      }, "Retirer")))
    : [vide("Aucune pour l'instant.")]));
  dessiner(habitudes);
  const statut = el("p", { class: "doux petit" }, modele.pret ? "Prêt" : modele.arrete ? "Moteur arrêté" : "Chargement du moteur, quelques minutes…");
  // Tant que le moteur charge, on revérifie : la vue peut rester ouverte longtemps.
  const suivre = async () => {
    if (!statut.isConnected && statut.dataset.vu) return;
    statut.dataset.vu = "1";
    const etat = await api("/api/hermes/modele").catch(() => null);
    if (etat?.pret) statut.textContent = "Prêt";
    else setTimeout(suivre, 5000);
  };
  if (!modele.pret) setTimeout(suivre, 5000);
  const choix = el("select", {
    "aria-label": "Modèle",
    onchange: async () => {
      const ancien = modele.actif;
      if (!confirm("Changer de modèle recharge le moteur d'IA : Hermes et tout ce qui utilise ce moteur ne répondent pas pendant le rechargement (plusieurs minutes). Continuer ?")) {
        choix.value = ancien;
        return;
      }
      choix.disabled = true;
      statut.textContent = "Chargement du moteur, quelques minutes…";
      try {
        Object.assign(modele, await api("/api/hermes/modele", { methode: "POST", corps: { modele: choix.value } }));
        setTimeout(suivre, 5000);
      } catch (err) {
        statut.textContent = err.message;
        choix.value = ancien;
      }
      choix.disabled = false;
    },
  }, modele.choix.map((m) => el("option", { value: m.id, selected: m.id === modele.actif }, m.nom)));
  // Ce que le modèle choisi sait faire des images : le voir avant de basculer évite une attente pour rien.
  const aide = el("p", { class: "doux petit" });
  const dire = () => {
    const m = modele.choix.find((x) => x.id === choix.value);
    aide.textContent = m?.vision
      ? "Voit les images jointes (photo, capture, scan : une par message), même vitesse d'écriture."
      : "Texte seulement : une image jointe est lue par OCR (son texte, pas l'image).";
  };
  choix.addEventListener("change", dire);
  dire();
  return el("div", { class: "reglages" },
    el("section", {}, el("h2", {}, "Modèle"), choix, aide, statut),
    el("section", {}, el("h2", {}, "Habitudes"), liste));
}

const ICONE_MICRO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const ICONE_STOP = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/></svg>';

const ICONE_APPAREIL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
const ICONE_DOSSIER = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICONE_CRAYON = '<svg class="titre-crayon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/></svg>';
const ICONE_TROMBONE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.6 1.6 0 0 1-2.3-2.3l7.6-7.6"/></svg>';

const JOUR = 86400000;

// Tranches de l'historique, de la plus récente à la plus ancienne.
function tranche(ts) {
  const minuit = new Date().setHours(0, 0, 0, 0);
  const t = ts * 1000;
  if (t >= minuit) return "Aujourd'hui";
  if (t >= minuit - JOUR) return "Hier";
  if (t >= minuit - 7 * JOUR) return "7 derniers jours";
  if (t >= minuit - 30 * JOUR) return "30 derniers jours";
  return "Plus ancien";
}

function grouper(liste) {
  const groupes = new Map();
  for (const c of liste) {
    const nom = c.epinglee ? "Épinglées" : tranche(c.date);
    if (!groupes.has(nom)) groupes.set(nom, []);
    groupes.get(nom).push(c);
  }
  return ["Épinglées", "Aujourd'hui", "Hier", "7 derniers jours", "30 derniers jours", "Plus ancien"]
    .filter((nom) => groupes.has(nom)).map((nom) => [nom, groupes.get(nom)]);
}

export async function vueHermes(cible) {
  // Conversation demandée d'ailleurs (recherche globale) : elle s'ouvre à la place de la dernière.
  const demandee = sessionStorage.getItem("hermes-ouvrir");
  if (demandee) {
    sessionStorage.removeItem("hermes-ouvrir");
    conversation = demandee;
    sessionStorage.setItem("hermes-conversation", demandee);
  }
  const fil = el("div", { class: "fil", "aria-live": "polite" });
  // Aperçu d'un livrable à droite de la conversation (plein écran sur téléphone), comme dans Claude.
  const panneau = el("aside", { class: "panneau-apercu", "aria-label": "Aperçu du fichier", hidden: true });
  let racine = null;
  function marquerLivrable(adresse) {
    fil.querySelectorAll(".livrable").forEach((c) => c.classList.toggle("actif", c.dataset.adresse === adresse));
  }
  function fermerPanneau() {
    if (panneau.hidden) return;
    panneau.hidden = true;
    panneau.replaceChildren();
    racine?.classList.remove("avec-apercu", "apercu-plein");
    marquerLivrable(null);
  }
  function ouvrirPanneau(adresse) {
    if (!panneau.hidden && panneau.dataset.adresse === adresse) return;
    panneau.dataset.adresse = adresse;
    racine?.classList.remove("apercu-plein");
    panneau.replaceChildren(construireApercu(adresse, { fermer: fermerPanneau, agrandir: () => racine.classList.toggle("apercu-plein") }));
    panneau.hidden = false;
    racine?.classList.add("avec-apercu");
    marquerLivrable(adresse);
    panneau.querySelector(".apercu-outil, button")?.focus({ preventScroll: true });
  }
  panneau.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); fermerPanneau(); zone.focus(); } });
  // Une conversation s'ouvre sur ses derniers messages, et y reste tant qu'on ne remonte pas soi-même : la page peut
  // être remplie avant d'être affichée, et les images arrivent après le texte (elles repousseraient le bas).
  let collee = false;
  const descendre = () => { if (collee) fil.scrollTop = fil.scrollHeight; };
  const collerEnBas = () => { collee = true; descendre(); requestAnimationFrame(descendre); };
  new ResizeObserver(descendre).observe(fil);
  fil.addEventListener("load", descendre, true);
  fil.addEventListener("scroll", () => { collee = fil.scrollHeight - fil.scrollTop - fil.clientHeight < 140; }, { passive: true });
  const zone = el("textarea", { rows: 1, placeholder: "Écrire à Hermes…", "aria-label": "Message" });
  // Sur téléphone, une flèche ronde (le texte reste pour les lecteurs d'écran et sur PC) : la place va au message.
  const envoyer = el("button", { class: "plein envoyer-rond", "aria-label": "Envoyer" });
  envoyer.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  envoyer.append(el("span", { class: "texte-envoyer" }, "Envoyer"));
  const arreter = el("button", { type: "button", hidden: true }, "Arrêter");
  const micro = el("button", { type: "button", class: "micro", "aria-label": "Dicter", hidden: !dicteePossible() });
  const etatDictee = el("p", { class: "etat-dictee petit doux", role: "status", hidden: true });
  const fichier = el("input", { type: "file", multiple: true, hidden: true, "aria-hidden": "true", tabindex: "-1" });
  // Le trombone ouvre un petit menu : un fichier de l'appareil, ou un ou plusieurs fichiers de l'espace Fichiers.
  const joindre = el("button", { type: "button", class: "micro", "aria-label": "Joindre un document", "aria-haspopup": "menu", "aria-expanded": "false" });
  joindre.innerHTML = ICONE_TROMBONE;
  const article = (svg, texte, faire) => {
    const b = el("button", { type: "button", role: "menuitem", onclick: () => { fermerJoindre(); faire(); } });
    b.innerHTML = svg;
    b.append(el("span", {}, texte));
    return b;
  };
  const menuJoindre = el("div", { class: "menu-liste menu-joindre", role: "menu", "aria-label": "Joindre", hidden: true },
    article(ICONE_APPAREIL, "Depuis l'appareil", () => fichier.click()),
    article(ICONE_DOSSIER, "Depuis mes Fichiers", () => depuisFichiers()));
  function fermerJoindre() {
    menuJoindre.hidden = true;
    joindre.setAttribute("aria-expanded", "false");
  }
  joindre.onclick = () => {
    const ouvrir = menuJoindre.hidden;
    menuJoindre.hidden = !ouvrir;
    joindre.setAttribute("aria-expanded", String(ouvrir));
    if (ouvrir) menuJoindre.querySelector("button").focus();
  };
  menuJoindre.addEventListener("keydown", (e) => { if (e.key === "Escape") { fermerJoindre(); joindre.focus(); } });
  const horsMenu = (e) => {
    if (!menuJoindre.isConnected) { document.removeEventListener("pointerdown", horsMenu); return; }
    if (!menuJoindre.hidden && !menuJoindre.contains(e.target) && !joindre.contains(e.target)) fermerJoindre();
  };
  document.addEventListener("pointerdown", horsMenu);
  const zoneJoints = el("div", { class: "joints-saisie", hidden: true });
  let joints = [];
  const etatMoteur = el("p", { class: "etat-moteur petit", role: "status", hidden: true });
  let moteurPret = true;
  let voit = false;
  let dictee = null;
  let envoyerApresDictee = false;
  const listeConv = el("div", { class: "conversations", role: "navigation", "aria-label": "Historique des conversations" });
  const chercher = el("input", { type: "search", placeholder: "Chercher dans les conversations", "aria-label": "Chercher dans les conversations" });
  const titre = el("h1", { class: "titre-conv" }, "Nouvelle conversation");
  const actions = el("div", { class: "actions-conv" });
  // Choix du modèle dans la discussion, comme sur Claude : nom du modèle en haut, menu des trois au clic.
  const choixModele = el("details", { class: "choix-modele" });
  let etatModele = null;
  let bascule = false;
  function dessinerModele(m) {
    if (m) etatModele = m;
    if (!etatModele || choixModele.open) return;
    const actif = etatModele.choix.find((c) => c.id === etatModele.actif);
    const charge = bascule || (!etatModele.pret && !etatModele.arrete);
    choixModele.replaceChildren(
      el("summary", { "aria-label": `Modèle : ${actif?.nom ?? ""}. Changer de modèle` },
        el("span", { class: "choix-modele-nom" }, actif?.nom ?? "Modèle"),
        charge ? el("span", { class: "choix-modele-etat" }, "chargement…") : null),
      el("div", { class: "menu-liste choix-modele-menu", role: "menu" },
        etatModele.choix.map((c) => el("button", {
          type: "button", role: "menuitemradio", "aria-checked": String(c.id === etatModele.actif), disabled: bascule || enCours,
          onclick: () => changerModele(c),
        }, el("span", { class: "choix-modele-ligne" }, el("strong", {}, c.nom), c.id === etatModele.actif ? el("span", { class: "coche", "aria-hidden": "true" }, "✓") : null),
        el("span", { class: "doux petit" }, c.vision ? "Lit aussi les images jointes" : "Texte seulement (images par OCR)"))),
        el("p", { class: "doux petit choix-modele-note" }, "Changer recharge le moteur : quelques minutes sans réponse.")));
  }
  async function changerModele(c) {
    choixModele.open = false;
    if (c.id === etatModele.actif) return;
    if (!confirm(`Passer sur « ${c.nom} » ? Le moteur d'IA se recharge : Hermes et tout ce qui l'utilise ne répondent pas pendant le rechargement (plusieurs minutes).`)) return;
    bascule = true;
    dessinerModele();
    try {
      dessinerModele(await api("/api/hermes/modele", { methode: "POST", corps: { modele: c.id } }));
    } catch (err) {
      toast(err.message);
    }
    bascule = false;
    suivreMoteur();
  }
  choixModele.addEventListener("toggle", () => { if (!choixModele.open) dessinerModele(); });
  const fermerModele = (e) => {
    if (!choixModele.isConnected && choixModele.dataset.monte) { document.removeEventListener("click", fermerModele); return; }
    choixModele.dataset.monte = "1";
    if (choixModele.open && !choixModele.contains(e.target)) choixModele.open = false;
  };
  document.addEventListener("click", fermerModele);
  const reglages = el("div", {}, await blocReglages());
  let enCours = null;
  let liste = [];
  let ouverture = 0;
  let envoiEnCours = false;
  let dateVue = null;
  const ailleurs = el("button", { type: "button", class: "ailleurs petit", hidden: true });

  const courante = () => liste.find((c) => c.id === conversation);

  const occupe = (run) => {
    occupeSansRecharger(run);
    if (!run) {
      // Ma propre réponse vient de finir : inutile de recharger ce qui est déjà à l'écran.
      chargerConversations().then(() => { dateVue = courante()?.date ?? null; });
      blocReglages().then((nouveau) => reglages.replaceChildren(nouveau));
    }
  };
  arreter.addEventListener("click", async () => {
    arreter.disabled = true;
    arreter.textContent = "Arrêt…";
    await api(`/api/hermes/executions/${enCours}/arreter`, { methode: "POST" }).catch(() => {});
  });

  async function ouvrir(id) {
    const numero = ++ouverture;
    // L'exécution continue côté serveur : on s'y raccrochera en revenant.
    fluxOuvert?.close();
    fluxOuvert = null;
    occupeSansRecharger(null);
    conversation = id;
    if (id) sessionStorage.setItem("hermes-conversation", id);
    else sessionStorage.removeItem("hermes-conversation");
    volet.classList.remove("ouvert");
    dessinerEntete();
    if (panneau.dataset.conversation !== String(id)) fermerPanneau();
    panneau.dataset.conversation = String(id);
    fil.replaceChildren();
    if (!id) {
      fil.append(vide("Une nouvelle conversation. Hermes a accès à tes mails, ton agenda, tes tâches et tes fichiers."));
      return;
    }
    let messages;
    try {
      messages = await api(`/api/hermes/conversations/${encodeURIComponent(id)}`);
    } catch (err) {
      if (numero === ouverture) fil.append(el("p", { class: "erreur" }, err.message));
      return;
    }
    if (numero !== ouverture) return;
    fil.append(...messagesAvecMesures(messages));
    const c = courante();
    dateVue = c?.date ?? null;
    // La liste peut annoncer une exécution qui vient de finir : son résultat est déjà dans l'historique.
    const etat = c?.run ? await api(`/api/hermes/executions/${c.run}`).catch(() => null) : null;
    if (numero !== ouverture) return;
    if (c?.run && !["completed", "failed", "cancelled"].includes(etat?.statut)) {
      // La question n'est enregistrée qu'à la fin : pour un autre appareil, le serveur la garde en attendant.
      if (c.question && messages.findLast((m) => m.role === "user")?.texte !== c.question) fil.append(bulle("user", c.question));
      occupeSansRecharger(c.run);
      ecouter(c.run, fil, () => occupe(null));
    }
    collerEnBas();
  }

  function occupeSansRecharger(run) {
    enCours = run;
    envoyer.hidden = Boolean(run);
    arreter.hidden = !run;
    arreter.disabled = false;
    arreter.textContent = "Arrêter";
  }

  // Sélection de plusieurs conversations (bouton « Sélectionner », ou appui long sur téléphone) pour les supprimer.
  let choix = null;
  let resultats = null;
  let messageSelection = "";
  function basculerChoix(c) {
    if (c.run) return;
    if (choix.has(c.id)) choix.delete(c.id);
    else choix.add(c.id);
    dessinerListe();
  }
  function commencerSelection(c = null) {
    choix = new Set(c && !c.run ? [c.id] : []);
    messageSelection = "";
    dessinerListe();
  }
  function finirSelection() {
    choix = null;
    aConfirmer = false;
    messageSelection = "";
    dessinerListe();
  }

  function ligne(c, extrait) {
    let appuiLong = null;
    let viaAppuiLong = false;
    const enChoix = Boolean(choix);
    const coche = enChoix && choix.has(c.id);
    return el("button", {
      class: `conv${!enChoix && c.id === conversation ? " actif" : ""}${coche ? " choisie" : ""}${enChoix ? " en-choix" : ""}`,
      "aria-current": !enChoix && c.id === conversation ? "true" : null,
      "aria-pressed": enChoix ? String(coche) : null,
      disabled: enChoix && Boolean(c.run),
      onpointerdown: (e) => {
        if (enChoix || e.pointerType === "mouse") return;
        viaAppuiLong = false;
        appuiLong = setTimeout(() => { viaAppuiLong = true; navigator.vibrate?.(15); commencerSelection(c); }, 550);
      },
      onpointerup: () => clearTimeout(appuiLong),
      onpointercancel: () => clearTimeout(appuiLong),
      onpointerleave: () => clearTimeout(appuiLong),
      oncontextmenu: (e) => { if (viaAppuiLong || appuiLong) e.preventDefault(); },
      onclick: async () => {
        if (viaAppuiLong) { viaAppuiLong = false; return; }
        if (choix) { basculerChoix(c); return; }
        await ouvrir(c.id);
        dessinerListe();
      },
    },
    enChoix ? el("span", { class: "case-conv", "aria-hidden": "true" }) : null,
    el("span", { class: "conv-tete" },
      el("span", { class: "titre" }, c.titre),
      el("span", { class: "doux mono petit" }, quand(c.date))),
    c.attente ? el("span", { class: "etat-conv ambre" }, "À confirmer")
      : c.run ? el("span", { class: "etat-conv doux" }, "En cours") : null,
    extrait ? el("span", { class: "doux petit extrait" }, extrait) : null);
  }

  function dessinerListe() {
    if (choix) for (const id of [...choix]) if (!liste.some((c) => c.id === id && !c.run)) choix.delete(id);
    dessinerSelection();
    if (resultats) {
      listeConv.replaceChildren(...(resultats.length ? resultats.map((c) => ligne(c, c.extrait)) : [vide(`Rien pour « ${chercher.value.trim()} ».`)]));
      return;
    }
    if (!liste.length) {
      listeConv.replaceChildren(vide("Aucune conversation pour l'instant."));
      return;
    }
    listeConv.replaceChildren(...grouper(liste).flatMap(([nom, membres]) => [
      el("h2", {}, nom), ...membres.map((c) => ligne(c))]));
  }

  const barreSelection = el("div", { class: "barre-selection", hidden: true });
  const boutonSelection = el("button", { type: "button", class: "lien petit", onclick: () => commencerSelection() }, "Sélectionner");
  let aConfirmer = false;
  const ICONE_CORBEILLE = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
  const ICONE_FERMER = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const icone = (svg, attributs, texte) => { const b = el("button", { type: "button", ...attributs }); b.innerHTML = svg; if (texte) b.append(el("span", {}, texte)); return b; };

  async function supprimerChoisies() {
    const ids = [...choix];
    barreSelection.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    let refusees = 0;
    for (const id of ids) {
      try {
        await api(`/api/hermes/conversations/${encodeURIComponent(id)}`, { methode: "DELETE" });
        liste = liste.filter((c) => c.id !== id);
        if (resultats) resultats = resultats.filter((c) => c.id !== id);
      } catch {
        refusees += 1;
      }
    }
    const faites = ids.length - refusees;
    aConfirmer = false;
    choix = refusees ? new Set(ids.filter((id) => liste.some((c) => c.id === id))) : null;
    messageSelection = refusees ? `${faites} supprimée${faites > 1 ? "s" : ""}, ${refusees} refusée${refusees > 1 ? "s" : ""} : Hermes y travaille peut-être encore.` : "";
    if (conversation && ids.includes(conversation) && !liste.some((c) => c.id === conversation)) await ouvrir(null);
    dessinerListe();
    await chargerConversations();
  }

  // Barre discrète d'une ligne : nombre choisi, Tout, Supprimer ; la confirmation prend sa place, sans fenêtre.
  function dessinerSelection() {
    boutonSelection.hidden = Boolean(choix);
    barreSelection.hidden = !choix;
    if (!choix) { aConfirmer = false; return; }
    const visibles = (resultats || liste).filter((c) => !c.run && liste.some((x) => x.id === c.id));
    const tout = visibles.length > 0 && visibles.every((c) => choix.has(c.id));
    const n = choix.size;
    if (!n) aConfirmer = false;
    const ligneBarre = aConfirmer
      ? el("div", { class: "barre-selection-ligne" },
        el("span", { class: "barre-selection-texte question", role: "status" }, n > 1 ? `Supprimer ${n} conversations ?` : "Supprimer 1 conversation ?"),
        el("button", { type: "button", class: "lien petit", onclick: () => { aConfirmer = false; dessinerSelection(); } }, "Annuler"),
        el("button", { type: "button", class: "lien petit danger fort", onclick: supprimerChoisies }, "Supprimer"))
      : el("div", { class: "barre-selection-ligne" },
        icone(ICONE_FERMER, { class: "icone-barre", "aria-label": "Quitter la sélection", title: "Quitter la sélection", onclick: finirSelection }),
        el("span", { class: "barre-selection-texte", role: "status" }, n ? `${n} sélectionnée${n > 1 ? "s" : ""}` : "Aucune sélection"),
        el("button", {
          type: "button", class: "lien petit", disabled: !visibles.length,
          onclick: () => { for (const c of visibles) if (tout) choix.delete(c.id); else choix.add(c.id); dessinerListe(); },
        }, tout ? "Aucune" : "Tout"),
        icone(ICONE_CORBEILLE, { class: "lien petit danger", disabled: !n, "aria-label": "Supprimer la sélection", onclick: () => { aConfirmer = true; dessinerSelection(); } }, "Supprimer"));
    barreSelection.replaceChildren(ligneBarre, ...(messageSelection ? [el("p", { class: "erreur petit" }, messageSelection)] : []));
  }

  async function chargerConversations() {
    const empreinte = () => liste.map((c) => `${c.id}${c.run ? "*" : ""}`).join();
    const avant = empreinte();
    liste = await api("/api/hermes/conversations").catch(() => liste);
    // En pleine sélection, on ne redessine que si la liste a changé (sinon « Confirmer » retomberait toutes les 3 s).
    if (!chercher.value.trim() && !(choix && empreinte() === avant)) dessinerListe();
    dessinerEntete();
  }

  // Le PC et le téléphone voient la même chose : demande lancée ailleurs, réponse arrivée, confirmation en attente.
  async function suivreAilleurs() {
    if (!fil.isConnected) return;
    if (!document.hidden && !envoiEnCours) {
      await chargerConversations();
      const c = courante();
      if (c?.run && c.run !== enCours) {
        await ouvrir(c.id);
      } else if (c && !c.run && !enCours) {
        if (dateVue === null) dateVue = c.date;
        else if (c.date !== dateVue) await ouvrir(c.id);
      }
      const autre = liste.find((x) => x.attente && x.id !== conversation) || liste.find((x) => x.run && x.id !== conversation);
      if (autre && !conversation && !zone.value.trim() && !fil.querySelector(".bulle")) {
        await ouvrir(autre.id);
        dessinerListe();
      } else {
        ailleurs.hidden = !autre;
        if (autre) {
          ailleurs.textContent = `${autre.attente ? "Hermes attend ta confirmation" : "Hermes travaille"} dans « ${autre.titre} » : ouvrir`;
          ailleurs.onclick = async () => { await ouvrir(autre.id); dessinerListe(); };
        }
      }
    }
    setTimeout(suivreAilleurs, 3000);
  }

  let attenteRecherche;
  chercher.addEventListener("input", () => {
    clearTimeout(attenteRecherche);
    const q = chercher.value.trim();
    if (q.length < 2) {
      resultats = null;
      dessinerListe();
      return;
    }
    attenteRecherche = setTimeout(async () => {
      const trouvees = await api(`/api/hermes/conversations/recherche?q=${encodeURIComponent(q)}`).catch(() => []);
      if (chercher.value.trim() !== q) return;
      resultats = trouvees;
      dessinerListe();
    }, 250);
  });

  function renommer() {
    const c = courante();
    if (!c) return;
    const champ = el("input", { value: c.titre, maxlength: 120, "aria-label": "Titre de la conversation" });
    let fini = false;
    const valider = async (garder) => {
      if (fini) return;
      fini = true;
      const nouveau = champ.value.trim();
      if (garder && nouveau && nouveau !== c.titre) {
        await api(`/api/hermes/conversations/${c.id}`, { methode: "PATCH", corps: { titre: nouveau } })
          .then(() => { c.titre = nouveau; })
          .catch((err) => fil.append(el("p", { class: "erreur" }, err.message)));
      }
      titre.closest(".tete-conv")?.classList.remove("renomme");
      titre.replaceChildren();
      dessinerEntete();
      if (!chercher.value.trim()) dessinerListe();
    };
    champ.addEventListener("keydown", (e) => {
      if (e.key === "Enter") valider(true);
      if (e.key === "Escape") valider(false);
    });
    champ.addEventListener("blur", () => valider(true));
    titre.replaceChildren(champ);
    actions.replaceChildren();
    // Le champ prend tout l'en-tête le temps du renommage (sur téléphone surtout).
    titre.closest(".tete-conv")?.classList.add("renomme");
    champ.select();
  }

  function dessinerEntete() {
    const c = courante();
    // Un menu ouvert ou un renommage en cours ne doit pas être refermé par la mise à jour automatique.
    if (titre.querySelector("input") || actions.querySelector("details[open]")) return;
    titre.textContent = c ? "" : conversation ? "Conversation" : "Nouvelle conversation";
    // Un clic sur le titre le renomme sur place (aussi dans le menu « ⋯ »).
    if (c) {
      const bouton = el("button", { type: "button", class: "titre-bouton", title: "Renommer", "aria-label": `Renommer « ${c.titre} »`, onclick: renommer },
        el("span", { class: "titre-texte" }, c.titre));
      bouton.insertAdjacentHTML("beforeend", ICONE_CRAYON);
      titre.append(bouton);
    }
    if (!c) {
      actions.replaceChildren();
      return;
    }
    const supprimer = el("button", {
      onclick: async () => {
        if (!supprimer.dataset.confirme) {
          supprimer.dataset.confirme = "1";
          supprimer.textContent = "Confirmer la suppression";
          supprimer.classList.add("alerte");
          return;
        }
        try {
          await api(`/api/hermes/conversations/${c.id}`, { methode: "DELETE" });
          menu.open = false;
          liste = liste.filter((x) => x !== c);
          await ouvrir(null);
          await chargerConversations();
        } catch (err) {
          menu.open = false;
          fil.append(el("p", { class: "erreur" }, err.message));
        }
      },
    }, "Supprimer");
    const menu = el("details", { class: "menu-conv" },
      el("summary", { "aria-label": "Actions sur la conversation" }, "⋯"),
      el("div", { class: "menu-liste" },
        el("button", { onclick: () => { menu.open = false; renommer(); } }, "Renommer"),
        el("button", {
          onclick: async () => {
            menu.open = false;
            await api(`/api/hermes/conversations/${c.id}`, { methode: "PATCH", corps: { epinglee: !c.epinglee } })
              .catch((err) => fil.append(el("p", { class: "erreur" }, err.message)));
            await chargerConversations();
          },
        }, c.epinglee ? "Désépingler" : "Épingler"),
        supprimer));
    actions.replaceChildren(menu);
  }

  async function poser(texte, documents = [], image = null) {
    fil.querySelector(":scope > .vide")?.remove();
    const montre = (documents.length
      ? `${texte}\n\n${MARQUE_DOCUMENTS}\n${documents.map((d) => `- ${d.id} : ${d.nom}`).join("\n")}` : texte)
      + (image ? `\n\n[Image : ${image.nom}]` : "");
    fil.append(bulle("user", montre));
    fil.scrollTop = fil.scrollHeight;
    envoiEnCours = true;
    try {
      const r = await api("/api/hermes/envoyer", { methode: "POST", corps: { texte, conversation, documents, image: image?.donnees ?? null } });
      conversation = r.conversation;
      sessionStorage.setItem("hermes-conversation", conversation);
      occupe(r.run_id);
      ecouter(r.run_id, fil, () => occupe(null));
      await chargerConversations();
    } catch (err) {
      fil.lastChild?.remove();
      if (!zone.value) zone.value = texte;
      fil.append(el("p", { class: "erreur" }, err.message));
    } finally {
      envoiEnCours = false;
    }
  }

  // Bascule possible depuis un autre appareil : on revérifie, souvent tant que le moteur charge.
  async function suivreMoteur(premiere = false) {
    // Au premier passage, la vue n'est pas encore attachée à la page.
    if (!premiere && !fil.isConnected) return;
    const m = await api("/api/hermes/modele").catch(() => null);
    if (m) {
      moteurPret = m.pret;
      voit = Boolean(m.vision);
      dessinerModele(m);
      const nom = m.choix.find((c) => c.id === m.actif)?.nom ?? "";
      // Arrêté (rien ne chargera tout seul) ou en train de charger : deux messages, et un bouton dans le premier cas.
      if (m.arrete) {
        etatMoteur.replaceChildren(el("span", {}, "Le moteur IA est arrêté : Hermes ne peut pas répondre. "),
          m.demarrable ? el("button", { class: "lien ambre", type: "button", onclick: async (e) => {
            e.target.disabled = true;
            e.target.textContent = "Démarrage…";
            await api("/api/hermes/moteur/demarrer", { methode: "POST" }).catch((err) => { etatMoteur.textContent = err.message; });
            suivreMoteur();
          } }, "Démarrer le moteur") : null);
      } else {
        etatMoteur.textContent = `Le moteur IA charge le modèle ${nom}, quelques minutes. Hermes ne peut pas répondre pour l'instant.`;
      }
      etatMoteur.hidden = m.pret;
      envoyer.disabled = !m.pret;
    }
    setTimeout(() => suivreMoteur(), moteurPret ? 20000 : 4000);
  }

  const STATUT_JOINT = { lecture: "lecture…", pret: "", erreur: "illisible" };
  function dessinerJoints() {
    zoneJoints.hidden = !joints.length;
    zoneJoints.replaceChildren(...joints.map((j) => el("div", { class: `joint ${j.statut}` },
      el("span", { class: "joint-nom" }, j.nom),
      j.statut === "pret" && j.methode ? el("span", { class: "doux" }, j.methode) : null,
      j.statut !== "pret" ? el("span", { class: j.statut === "erreur" ? "alerte" : "doux" }, j.erreur || STATUT_JOINT[j.statut]) : null,
      el("button", {
        type: "button", class: "lien", "aria-label": `Retirer ${j.nom}`,
        onclick: () => {
          joints = joints.filter((x) => x !== j);
          if (j.id) api(`/api/documents/${j.id}`, { methode: "DELETE" }).catch(() => {});
          dessinerJoints();
        },
      }, "Retirer"))));
  }

  // Modèle qui voit : une photo part telle quelle (réduite à 1600 px) et l'IA la regarde vraiment, au lieu de l'OCR.
  // Une image par message (limite du moteur) : les suivantes passent par l'OCR comme avant.
  async function enJpeg(f) {
    const bitmap = await createImageBitmap(f);
    const echelle = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const toile = document.createElement("canvas");
    toile.width = Math.round(bitmap.width * echelle);
    toile.height = Math.round(bitmap.height * echelle);
    toile.getContext("2d").drawImage(bitmap, 0, 0, toile.width, toile.height);
    bitmap.close?.();
    return toile.toDataURL("image/jpeg", 0.88);
  }

  async function envoyerFichier(f) {
    if (voit && f.type.startsWith("image/") && !joints.some((x) => x.image)) {
      const image = { nom: f.name, statut: "lecture", methode: "Image vue par l'IA" };
      joints.push(image);
      dessinerJoints();
      try {
        image.image = await enJpeg(f);
        image.statut = "pret";
        dessinerJoints();
        return;
      } catch {
        // Format que le navigateur ne sait pas ouvrir (HEIC...) : on passe par l'OCR.
        joints = joints.filter((x) => x !== image);
      }
    }
    const j = { nom: f.name, statut: "lecture" };
    joints.push(j);
    dessinerJoints();
    try {
      const r = await fetch(`/api/documents?nom=${encodeURIComponent(f.name)}`, { method: "POST", body: f, credentials: "same-origin" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : "Envoi impossible");
      j.id = d.id;
      while (j.statut === "lecture" && joints.includes(j)) {
        await new Promise((fin) => { setTimeout(fin, 1200); });
        Object.assign(j, await api(`/api/documents/${j.id}`));
        dessinerJoints();
      }
    } catch (err) {
      j.statut = "erreur";
      j.erreur = err.message;
      dessinerJoints();
    }
  }
  // Un fichier de l'espace suit le même chemin qu'un fichier de l'appareil (lecture, OCR, ou image vue par l'IA).
  async function depuisFichiers() {
    for (const c of await choisirDansFichiers()) {
      try {
        const r = await fetch(`/api/espace/telecharger?chemin=${encodeURIComponent(c.chemin)}`, { credentials: "same-origin" });
        if (!r.ok) throw new Error(r.status === 404 ? "il n'existe plus" : `erreur ${r.status}`);
        const blob = await r.blob();
        envoyerFichier(new File([blob], c.nom, { type: blob.type === "application/octet-stream" ? "" : blob.type }));
      } catch (err) {
        toast(`« ${c.nom} » n'a pas pu être joint : ${err.message}`);
      }
    }
    zone.focus();
  }
  fichier.addEventListener("change", () => {
    [...fichier.files].forEach(envoyerFichier);
    fichier.value = "";
  });

  const dessinerMicro = (actif) => {
    micro.innerHTML = actif ? ICONE_STOP : ICONE_MICRO;
    micro.classList.toggle("actif", actif);
    micro.setAttribute("aria-label", actif ? "Arrêter la dictée" : "Dicter");
  };
  dessinerMicro(false);

  micro.addEventListener("click", async () => {
    if (micro.classList.contains("actif")) {
      dictee?.arreter();
      return;
    }
    // Le texte déjà tapé est gardé : la dictée s'écrit à sa suite.
    const avant = zone.value.trimEnd();
    dessinerMicro(true);
    etatDictee.className = "etat-dictee petit doux";
    etatDictee.textContent = "Connexion au micro…";
    etatDictee.hidden = false;
    // Comme dans Claude : une onde qui suit la voix, en haut de la barre d'écriture.
    const onde = creerOnde({ barres: 56 });
    formulaire.prepend(onde.element);
    formulaire.classList.add("dicte");
    let erreurVue = false;
    dictee = await dicter({
      niveau: onde.niveau,
      texte: (t) => {
        zone.value = [avant, t].filter(Boolean).join(" ");
        zone.scrollTop = zone.scrollHeight;
      },
      etat: (m) => {
        // Vue quittée : le micro ne doit jamais rester ouvert.
        if (!micro.isConnected) dictee?.arreter();
        if (!erreurVue) etatDictee.textContent = m;
      },
      erreur: (m) => {
        erreurVue = true;
        envoyerApresDictee = false;
        etatDictee.className = "etat-dictee petit erreur";
        etatDictee.textContent = m;
      },
      fin: () => {
        onde.arreter();
        formulaire.classList.remove("dicte");
        dictee = null;
        dessinerMicro(false);
        if (!erreurVue) etatDictee.hidden = true;
        if (envoyerApresDictee) {
          envoyerApresDictee = false;
          formulaire.requestSubmit();
        }
      },
    });
  });

  const formulaire = el("form", {
    class: "saisie",
    onsubmit: (e) => {
      e.preventDefault();
      // Pendant une dictée, Envoyer termine d'abord la dernière phrase.
      if (micro.classList.contains("actif")) {
        envoyerApresDictee = true;
        dictee?.arreter();
        return;
      }
      const prets = joints.filter((j) => j.statut === "pret");
      const imageJointe = prets.find((j) => j.image);
      const texte = zone.value.trim() || (imageJointe && prets.length === 1 ? "Décris cette image." : prets.length ? "Lis ce document." : "");
      if (!texte || enCours || !moteurPret) return;
      if (joints.some((j) => j.statut === "lecture")) {
        etatDictee.className = "etat-dictee petit doux";
        etatDictee.textContent = "Lecture du document en cours : envoie dès qu'elle est finie.";
        etatDictee.hidden = false;
        return;
      }
      etatDictee.hidden = true;
      zone.value = "";
      const documents = prets.filter((j) => !j.image).map((j) => ({ id: j.id, nom: j.nom }));
      joints = [];
      dessinerJoints();
      poser(texte, documents, imageJointe ? { nom: imageJointe.nom, donnees: imageJointe.image } : null);
    },
  }, fichier, joindre, menuJoindre, zone, micro, envoyer, arreter);
  zone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && matchMedia("(min-width: 761px)").matches) {
      e.preventDefault();
      formulaire.requestSubmit();
    }
  });

  const nouvelle = async () => {
    chercher.value = "";
    resultats = null;
    choix = null;
    await ouvrir(null);
    dessinerListe();
    zone.focus();
  };
  const volet = el("aside", { class: "volet" },
    el("div", { class: "volet-tete" },
      el("button", { class: "plein", onclick: nouvelle }, "Nouvelle conversation"),
      el("button", { class: "fermer-volet", "aria-label": "Fermer l'historique", onclick: () => volet.classList.remove("ouvert") }, "Fermer")),
    el("div", { class: "recherche-conv" }, chercher, boutonSelection),
    barreSelection,
    listeConv,
    el("details", { class: "reglages-zone" }, el("summary", {}, "Modèle et habitudes"), reglages));
  // Touche Retour (appli Android) : sortir de la sélection, puis fermer l'historique, avant de quitter Hermes.
  surRetour(volet, () => {
    if (!panneau.hidden) { fermerPanneau(); return true; }
    if (!menuJoindre.hidden) { fermerJoindre(); return true; }
    if (choixModele.open) { choixModele.open = false; return true; }
    if (choix) { finirSelection(); return true; }
    if (volet.classList.contains("ouvert")) { volet.classList.remove("ouvert"); return true; }
    return false;
  });
  // PC : replier la colonne de l'historique (recherche, nouvelle conversation) pour lire en grand ; retenu sur l'appareil.
  const basculeVolet = el("button", { type: "button", class: "basculer-volet" });
  basculeVolet.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M9 5v14"/></svg>';
  const poserVolet = (replie) => {
    racine.classList.toggle("volet-replie", replie);
    basculeVolet.setAttribute("aria-label", replie ? "Afficher l'historique" : "Masquer l'historique");
    basculeVolet.title = basculeVolet.getAttribute("aria-label");
    basculeVolet.setAttribute("aria-expanded", String(!replie));
  };
  basculeVolet.addEventListener("click", () => {
    const replie = !racine.classList.contains("volet-replie");
    localStorage.setItem("poste-hermes-volet", replie ? "replie" : "ouvert");
    poserVolet(replie);
  });
  const entete = el("header", { class: "tete-conv" },
    basculeVolet,
    el("button", { class: "ouvrir-volet", onclick: () => volet.classList.add("ouvert") }, "Historique"),
    titre, choixModele, actions,
    el("button", { class: "nouvelle-mobile", "aria-label": "Nouvelle conversation", onclick: nouvelle }, "+"));

  racine = el("div", { class: "hermes" }, volet,
    el("div", { class: "discussion" }, entete, etatMoteur, ailleurs, fil, etatDictee, zoneJoints, formulaire), panneau);
  poserHoteApercu(racine, ouvrirPanneau);
  poserVolet(localStorage.getItem("poste-hermes-volet") === "replie");
  cible.append(racine);

  // Sur PC, au clavier. Jamais pendant une saisie, ni à l'instant où la demande apparaît : on n'autorise pas sans avoir lu.
  const DELAI_LECTURE_MS = 700;
  const clavier = (e) => {
    if (!fil.isConnected) {
      document.removeEventListener("keydown", clavier);
      return;
    }
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !matchMedia("(min-width: 761px)").matches) return;
    const touche = { Enter: ".autoriser", Delete: ".refuser", Backspace: ".refuser" }[e.key];
    const cartes = fil.querySelectorAll(".decision:not(.repondue)");
    if (!touche || cartes.length !== 1) return;
    const cible = e.target;
    if ((cible.matches?.("textarea, input") && cible.value) || cible.closest?.("a, summary, select, .volet, .actions-conv")) return;
    if (cible.matches?.("button") && !cartes[0].contains(cible)) return;
    e.preventDefault();
    if (Date.now() - Number(cartes[0].dataset.affichee) >= DELAI_LECTURE_MS) cartes[0].querySelector(touche)?.click();
  };
  document.addEventListener("keydown", clavier);

  // Sur PC : déposer un fichier n'importe où dans la discussion.
  const discussion = cible.querySelector(".discussion");
  discussion.addEventListener("dragover", (e) => { e.preventDefault(); discussion.classList.add("depot"); });
  discussion.addEventListener("dragleave", (e) => { if (e.target === discussion) discussion.classList.remove("depot"); });
  discussion.addEventListener("drop", (e) => {
    e.preventDefault();
    discussion.classList.remove("depot");
    [...e.dataTransfer.files].forEach(envoyerFichier);
  });

  await chargerConversations();
  suivreMoteur(true);
  setTimeout(suivreAilleurs, 3000);
  const question = sessionStorage.getItem("hermes-question");
  if (question) {
    sessionStorage.removeItem("hermes-question");
    await ouvrir(null);
    poser(question);
  } else {
    // Une confirmation en attente passe d'abord (notification touchée), puis la conversation en cours, puis la dernière.
    const connue = liste.find((c) => c.id === conversation);
    await ouvrir((liste.find((c) => c.attente) || connue || liste.find((c) => !c.epinglee) || liste[0])?.id ?? null);
  }
  dessinerListe();
}
