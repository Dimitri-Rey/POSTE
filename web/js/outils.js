// Petits outils partagés : API, création de nœuds (jamais d'innerHTML avec des données).

export async function api(chemin, { methode = "GET", corps } = {}) {
  const reponse = await fetch(chemin, {
    method: methode,
    headers: corps === undefined ? {} : { "Content-Type": "application/json" },
    body: corps === undefined ? undefined : JSON.stringify(corps),
    credentials: "same-origin",
  });
  const donnees = await reponse.json().catch(() => ({}));
  if (reponse.status === 401 && !chemin.startsWith("/api/auth/")) {
    location.hash = "";
    location.reload();
  }
  if (!reponse.ok) {
    const detail = typeof donnees.detail === "string" ? donnees.detail : `Erreur ${reponse.status}`;
    throw new Error(detail);
  }
  return donnees;
}

// Modules actifs de l'installation (poste.toml), chargés au démarrage. Inconnu = actif, pour ne rien cacher à tort.
let MODULES = {};
export const poserModules = (m) => { MODULES = m || {}; };
export const moduleActif = (nom) => MODULES[nom] !== false;

export function el(balise, attributs = {}, ...enfants) {
  const noeud = document.createElement(balise);
  for (const [cle, valeur] of Object.entries(attributs)) {
    if (cle.startsWith("on")) noeud.addEventListener(cle.slice(2), valeur);
    else if (cle === "class") noeud.className = valeur;
    else if (valeur === true) noeud.setAttribute(cle, "");
    else if (valeur !== false && valeur != null) noeud.setAttribute(cle, valeur);
  }
  noeud.append(...enfants.flat().filter((e) => e != null));
  return noeud;
}

const memeJour = (a, b) => a.toDateString() === b.toDateString();

// Heure si c'est aujourd'hui, jour/mois sinon.
export function quand(ts) {
  const date = new Date(ts * 1000);
  return memeJour(date, new Date())
    ? date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

// États systemd en mots de tous les jours, avec la couleur de la pastille.
const ETATS = { active: ["En marche", "ok"], inactive: ["Arrêté", "attention"], failed: ["En panne", "panne"], activating: ["Démarrage", "attention"], deactivating: ["Arrêt en cours", "attention"], reloading: ["Rechargement", "attention"] };
export function pastilleService(etat) {
  const [texte, classe] = ETATS[etat] || [etat || "Inconnu", "neutre"];
  return el("span", { class: `pastille ${classe}` }, texte);
}

// Barre de remplissage : verte, ambre au-delà de 75 %, rouge au-delà de 90 %.
export function jauge(part) {
  const p = Math.max(0, Math.min(100, Math.round(part * 100)));
  const b = el("span", { class: `jauge${p >= 90 ? " critique" : p >= 75 ? " haute" : ""}`, role: "img", "aria-label": `${p} %` }, el("span", {}));
  b.firstChild.style.width = `${p}%`;
  return b;
}

// Fenêtre modale (même style que celles de Fichiers), retirée de la page à la fermeture.
// Sur téléphone, c'est une feuille qui monte du bas et se ferme en la glissant vers le bas.
export function fenetre(titre, ...contenu) {
  const d = el("dialog", { class: "fx-dialogue", onclose: () => d.remove() }, el("h2", {}, titre), ...contenu);
  document.body.append(d);
  d.showModal();
  glissable(d);
  return d;
}

const telephone = () => matchMedia("(max-width: 760px)").matches;

// Feuille : glisser vers le bas depuis le haut de la feuille (ou un appui en dehors) la ferme.
export function glissable(d) {
  d.addEventListener("click", (e) => { if (e.target === d && telephone()) d.close(); });
  let depart = null;
  d.addEventListener("pointerdown", (e) => {
    if (!telephone() || e.pointerType === "mouse") return;
    const haut = d.getBoundingClientRect().top;
    // Seule la poignée et le titre lancent le glissement : le reste de la feuille garde son défilement.
    if (e.clientY - haut > 56 || e.target.closest("input, textarea, select, button")) return;
    depart = e.clientY;
    d.style.transition = "none";
  });
  d.addEventListener("pointermove", (e) => {
    if (depart === null) return;
    d.style.transform = `translateY(${Math.max(0, e.clientY - depart)}px)`;
  });
  const fin = (e) => {
    if (depart === null) return;
    const ecart = e.clientY - depart;
    depart = null;
    d.style.transition = "";
    d.style.transform = "";
    if (ecart > 90) d.close();
  };
  d.addEventListener("pointerup", fin);
  d.addEventListener("pointercancel", fin);
}

// Touche Retour de l'appli Android : un écran peut d'abord fermer ce qu'il a ouvert (volet, sélection, panneau).
// Le dernier inscrit passe en premier ; il renvoie vrai s'il a fait quelque chose. Retiré quand son nœud quitte la page.
const retours = [];
export function surRetour(noeud, faire) { retours.push({ noeud, faire }); }
export function retourLocal() {
  for (let i = retours.length - 1; i >= 0; i -= 1) {
    if (!retours[i].noeud.isConnected) { retours.splice(i, 1); continue; }
    if (retours[i].faire()) return true;
  }
  return false;
}

// Message bref en bas de l'écran, avec une action facultative (« Annuler »).
export function toast(texte, action = null, faire = null) {
  document.querySelector(".toast")?.remove();
  const t = el("div", { class: "toast", role: "status" }, el("span", {}, texte),
    action ? el("button", { type: "button", onclick: () => { t.remove(); faire(); } }, action) : null);
  document.body.append(t);
  setTimeout(() => t.classList.add("sortie"), 3800);
  setTimeout(() => t.remove(), 4200);
  return t;
}

// Petite vibration au toucher, si l'appareil le permet (sans effet ailleurs).
export const vibrer = (ms = 12) => { try { navigator.vibrate?.(ms); } catch { /* sans vibreur */ } };

// Bouton d'action flottant (téléphone) : l'action principale de la page, à portée de pouce.
export const ICONES_FAB = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  micro: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  crayon: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
};
export function fab(icone, etiquette, faire, avecTexte = false) {
  const b = el("button", { class: `fab${avecTexte ? " etendu" : ""}`, type: "button", "aria-label": etiquette, title: etiquette, onclick: () => { vibrer(); faire(); } });
  b.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONES_FAB[icone]}</svg>`;
  if (avecTexte) b.append(el("span", {}, etiquette));
  return b;
}

export function vide(texte) {
  return el("p", { class: "vide" }, texte);
}
