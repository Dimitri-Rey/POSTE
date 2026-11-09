import { api, el, moduleActif, poserModules, retourLocal, toast } from "./outils.js";
import { ecranConnexion } from "./connexion.js";
import { vueAccueil } from "../vues/accueil.js";
import { vueServeur } from "../vues/serveur.js";
import { vueHermes } from "../vues/hermes.js";
import { vueMails } from "../vues/mails.js";
import { vueAgenda } from "../vues/agenda.js";
import { vueTaches } from "../vues/taches.js";
import { vueFichiers } from "../vues/fichiers.js";
import { vueReglages } from "../vues/reglages.js";
import { vueSite } from "../vues/sites.js";
import { appliquerTaille } from "./apparence.js";
import { ouvrirRecherche } from "./recherche-globale.js";
import { demarrerVeilleMails } from "./veille-mails.js";

appliquerTaille();

const VUES = {
  accueil: ["Accueil", vueAccueil],
  hermes: ["Hermes", vueHermes],
  mails: ["Mails", vueMails],
  agenda: ["Agenda", vueAgenda],
  taches: ["Tâches", vueTaches],
  fichiers: ["Fichiers", vueFichiers],
  serveur: ["Serveur", vueServeur],
  reglages: ["Réglages", vueReglages],
};
// Téléphone : quatre entrées dans la barre, le reste derrière « Plus ».
const PRINCIPALES = new Set(["accueil", "hermes", "mails", "agenda"]);

// Toujours des tracés écrits ici, jamais une donnée.
const ICONES = {
  accueil: '<path d="m4 11 8-7 8 7v9h-5v-6H9v6H4z"/>',
  hermes: '<path d="M4 5h16v11H9l-5 4z"/>',
  mails: '<rect x="3" y="5" width="18" height="14"/><path d="m3 6 9 7 9-7"/>',
  agenda: '<rect x="4" y="5" width="16" height="15"/><path d="M4 10h16M8 3v4m8-4v4"/>',
  taches: '<path d="m4 7 2 2 3-4M4 16l2 2 3-4M12 8h8M12 17h8"/>',
  fichiers: '<path d="M3 6h6l2 2.500h10V19H3z"/>',
  serveur: '<rect x="4" y="4" width="16" height="7"/><rect x="4" y="13" width="16" height="7"/><path d="M8 7.500h.01M8 16.500h.01"/>',
  reglages: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  recherche: '<circle cx="11" cy="11" r="6.500"/><path d="m16 16 4.500 4.500"/>',
  site: '<circle cx="12" cy="12" r="8.500"/><path d="M3.500 12h17M12 3.500c2.500 2.600 2.500 14.400 0 17M12 3.500c-2.500 2.600-2.500 14.400 0 17"/>',
  plus: '<circle cx="5.500" cy="12" r="1.200"/><circle cx="12" cy="12" r="1.200"/><circle cx="18.500" cy="12" r="1.200"/>',
};

function icone(id) {
  const i = el("span", { class: "nav-icone", "aria-hidden": "true" });
  i.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">${ICONES[id] || ICONES.site}</svg>`;
  return i;
}

const racine = document.getElementById("app");
let principal;
let liens = {};
let boutonPlus = null;
let feuille = null;
let dernierAffichage = 0;

// Appli Android : une notification arrivée pendant que Poste est à l'écran vient ici au lieu de la barre du téléphone.
// Rien si on regarde déjà l'écran concerné (la liste des mails ou la conversation se mettent à jour seules).
window.posteNotif = (titre, texte, lien) => {
  const ancre = String(lien || "").replace(/^\/?#/, "");
  const ici = (location.hash.slice(1).split("/")[0] || "accueil");
  if (ancre && ancre.split("/")[0] === ici) return;
  const resume = [titre, texte].filter(Boolean).join(" · ");
  toast(resume.length > 110 ? `${resume.slice(0, 108)}…` : resume, ancre ? "Voir" : null, () => { location.hash = ancre; });
};

// Appli Android : la touche Retour recule dans Poste au lieu de quitter. D'abord la feuille ou la fenêtre ouverte,
// puis l'écran précédent ; sur l'accueil, elle quitte. Le natif (MainActivity) demande ici quoi faire.
const sectionCourante = () => location.hash.slice(1).split("/")[0] || "accueil";
window.posteRetour = () => {
  const ouverts = document.querySelectorAll("dialog[open]");
  if (ouverts.length) { ouverts[ouverts.length - 1].close(); return "fait"; }
  if (feuille && !feuille.hasAttribute("hidden")) { feuille.setAttribute("hidden", ""); return "fait"; }
  if (retourLocal()) return "fait";
  return sectionCourante() === "accueil" ? "quitter" : "reculer";
};
// Plus d'écran précédent (ouvert depuis une notification) : on remonte d'un cran, jusqu'à l'accueil.
window.posteRemonter = () => {
  const morceaux = location.hash.slice(1).split("/").filter(Boolean);
  location.hash = morceaux.length > 1 ? morceaux[0] : "accueil";
  return true;
};

async function afficher() {
  // Une feuille ouverte appartient à l'écran qu'on quitte.
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  const nom = location.hash.slice(1).split("/")[0] || "accueil";
  const [, vue] = VUES[nom] || VUES.accueil;
  for (const [id, lien] of Object.entries(liens)) lien.classList.toggle("actif", id === nom);
  boutonPlus?.classList.toggle("actif", !PRINCIPALES.has(nom) && Boolean(VUES[nom]));
  feuille?.setAttribute("hidden", "");
  // Vue construite à part : seule la dernière navigation demandée s'affiche.
  const numero = ++dernierAffichage;
  // Réseau lent : le menu a déjà réagi ; au-delà d'un instant, une fine barre dit que la page arrive.
  const attente = setTimeout(() => { if (numero === dernierAffichage) document.body.classList.add("navigation-en-cours"); }, 150);
  const contenu = document.createDocumentFragment();
  try {
    await vue(contenu);
  } catch (err) {
    contenu.append(el("p", { class: "erreur", role: "alert" }, err.message));
  }
  if (numero !== dernierAffichage) return;
  clearTimeout(attente);
  document.body.classList.remove("navigation-en-cours");
  const poser = () => {
    principal.replaceChildren(contenu);
    principal.scrollTop = 0;
  };
  // Changement de section : courte transition ; même section (actualisation) : sans effet.
  const section = location.hash.slice(1).split("/")[0] || "accueil";
  if (document.startViewTransition && principal.dataset.section && principal.dataset.section !== section
    && !matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(poser);
  else poser();
  principal.dataset.section = section;
}

// Téléphone : tirer la page vers le bas depuis tout en haut l'actualise.
function tirerPourActualiser() {
  let depart = null;
  let indicateur = null;
  const ICONE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>';
  principal.addEventListener("touchstart", (e) => {
    const ignore = principal.scrollTop > 0 || document.querySelector("dialog[open]") || principal.querySelector(".hermes, .fx-vue-document, textarea.editeur")
      || e.target.closest("input, textarea, select, iframe, .ag-semaine, .fx-scene");
    depart = ignore ? null : e.touches[0].clientY;
  }, { passive: true });
  principal.addEventListener("touchmove", (e) => {
    if (depart === null) return;
    const ecart = e.touches[0].clientY - depart;
    if (ecart < 10) return;
    if (!indicateur) {
      indicateur = el("div", { class: "tirer", "aria-hidden": "true" });
      indicateur.innerHTML = ICONE;
      document.body.append(indicateur);
    }
    const p = Math.min(ecart, 120);
    indicateur.style.transform = `translateY(${p * .6}px) rotate(${p * 3}deg)`;
    indicateur.style.opacity = String(Math.min(1, p / 80));
  }, { passive: true });
  principal.addEventListener("touchend", async (e) => {
    if (depart === null || !indicateur) { depart = null; return; }
    const ecart = e.changedTouches[0].clientY - depart;
    depart = null;
    const i = indicateur;
    indicateur = null;
    if (ecart < 80) { i.remove(); return; }
    i.classList.add("tourne");
    await afficher();
    i.remove();
  });
}

function charpente() {
  liens = Object.fromEntries(Object.entries(VUES).map(([id, [titre]]) =>
    [id, el("a", { href: `#${id}`, "aria-label": titre, class: PRINCIPALES.has(id) ? "" : "secondaire" }, icone(id), el("span", { class: "nav-texte", "aria-hidden": "true" }, titre))]));
  principal = el("main");
  // « Plus » (téléphone) : une feuille avec les autres sections, fermée par un appui ailleurs ou une navigation.
  feuille = el("div", { class: "feuille", hidden: true, onclick: (e) => { if (e.target === feuille) feuille.setAttribute("hidden", ""); } },
    el("div", { class: "feuille-corps", role: "menu", "aria-label": "Autres sections" },
      Object.entries(VUES).filter(([id]) => !PRINCIPALES.has(id)).map(([id, [titre]]) =>
        el("a", { href: `#${id}`, role: "menuitem", onclick: () => feuille.setAttribute("hidden", "") }, icone(id), titre))));
  const rechercher = () => ouvrirRecherche(Object.entries(VUES).map(([id, [titre]]) => [id, titre]));
  const boutonRecherche = el("button", { class: "nav-recherche", "aria-label": "Rechercher partout (Ctrl+K)", onclick: rechercher },
    icone("recherche"), el("span", { class: "nav-texte", "aria-hidden": "true" }, "Rechercher", el("kbd", {}, "Ctrl K")));
  feuille.firstChild.prepend(el("a", { href: "#", role: "menuitem", onclick: (e) => { e.preventDefault(); feuille.setAttribute("hidden", ""); rechercher(); } }, icone("recherche"), "Rechercher"));
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      rechercher();
    }
  });
  window.posteRechercher = rechercher;
  boutonPlus = el("button", {
    class: "nav-plus", "aria-label": "Plus de sections", "aria-haspopup": "menu",
    onclick: () => feuille.toggleAttribute("hidden"),
  }, icone("plus"), el("span", { class: "nav-texte" }, "Plus"));
  // PC : une barre d'icônes, toujours étroite ; le nom de chaque section glisse à côté de l'icône survolée.
  const cadre = el("div", { class: "cadre menu-rail" });
  cadre.append(
    el("nav", { "aria-label": "Sections" },
      el("a", { class: "marque", href: "#accueil", "aria-label": "Poste, accueil" }, el("span", { class: "monogramme", "aria-hidden": "true" }, "P"),
        el("span", { class: "nav-texte", "aria-hidden": "true" }, "Poste")), boutonRecherche,
      Object.entries(liens).filter(([id]) => id !== "reglages").map(([, lien]) => lien),
      el("div", { class: "bas" }, liens.reglages), boutonPlus),
    principal, feuille);
  racine.replaceChildren(cadre);
  tirerPourActualiser();
  // En descendant, le bouton flottant se réduit à sa pastille pour laisser voir le contenu ; il revient en remontant.
  let dernier = 0;
  principal.addEventListener("scroll", () => {
    const y = principal.scrollTop;
    if (Math.abs(y - dernier) < 6) return;
    principal.classList.toggle("descend", y > dernier && y > 40);
    dernier = y;
  }, { passive: true });
  window.addEventListener("hashchange", afficher);
  afficher();
}

// Sites intégrés (Réglages) : une entrée de menu chacun, avant Serveur et Réglages.
function ajouterSites(sites) {
  if (!sites.length) return;
  const avant = Object.entries(VUES);
  const coupe = avant.findIndex(([id]) => id === "serveur" || id === "reglages");
  const entrees = sites.map((s) => [`site-${s.id}`, [s.nom, vueSite(s)]]);
  for (const id of Object.keys(VUES)) delete VUES[id];
  Object.assign(VUES, Object.fromEntries([...avant.slice(0, coupe), ...entrees, ...avant.slice(coupe)]));
}

async function demarrer() {
  const etat = await api("/api/auth/etat");
  if (etat.connecte) {
    poserModules(await api("/api/modules").catch(() => ({})));
    // Sections d'un module coupé : retirées du menu (Accueil, Fichiers et Réglages restent toujours).
    for (const id of Object.keys(VUES)) if (["hermes", "mails", "agenda", "taches", "serveur"].includes(id) && !moduleActif(id)) delete VUES[id];
    for (const id of [...PRINCIPALES]) if (!VUES[id]) PRINCIPALES.delete(id);
    ajouterSites(await api("/api/sites").catch(() => []));
    charpente();
    if (VUES.mails) demarrerVeilleMails();
  }
  else racine.replaceChildren(ecranConnexion(etat.initialise, () => location.reload()));
}

demarrer();

// Android garde l'application ouverte des jours entiers : sans ceci, le téléphone reste sur l'ancienne interface.
let versionChargee = null;
async function versionServeur() {
  return (await api("/api/auth/etat").catch(() => ({}))).version ?? null;
}
async function verifierVersion() {
  const version = await versionServeur();
  if (!version) return;
  versionChargee ??= version;
  if (version === versionChargee) return;
  // Jamais pendant une saisie ou une dictée : on attendra le prochain retour sur l'application.
  const saisie = [...document.querySelectorAll("textarea, input:not([type=search])")].some((c) => c.value.trim());
  if (!saisie && !document.querySelector(".micro.actif")) location.reload();
}
verifierVersion();
document.addEventListener("visibilitychange", () => { if (!document.hidden) verifierVersion(); });
window.addEventListener("hashchange", verifierVersion);
