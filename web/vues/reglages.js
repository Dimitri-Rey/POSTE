import { api, el, moduleActif } from "../js/outils.js";
import { blocStrava } from "./serveur.js";
import { appliquerTaille, PREF_TAILLE, TAILLES } from "../js/apparence.js";
import { PREF_PRENOM } from "./accueil.js";
import { blocAlertes, blocPointMails, blocsBranchements } from "./branchements.js";
import { blocSauvegardes } from "./sauvegardes.js";

// Réglages de Poste : apparence, branchements (boîtes, agendas, IA, dictée, notifications, modules), Android, session.
export async function vueReglages(cible) {
  const [etat, strava] = await Promise.all([api("/api/auth/etat"), moduleActif("sport") ? api("/api/sport/etat").catch(() => null) : null]);
  const ligne = (titre, aide, champ) => el("div", { class: "reglage" },
    el("div", {}, el("strong", {}, titre), aide ? el("p", { class: "doux petit" }, aide) : null), champ);
  const taille = el("select", { "aria-label": "Taille du texte", onchange: (e) => { localStorage.setItem(PREF_TAILLE, e.target.value); appliquerTaille(); } },
    Object.entries(TAILLES).map(([v, [texte]]) => el("option", { value: v, selected: v === (localStorage.getItem(PREF_TAILLE) || "normale") }, texte)));
  const sortir = el("button", {
    onclick: async () => {
      await api("/api/auth/deconnexion", { methode: "POST" });
      location.hash = "";
      location.reload();
    },
  }, "Se déconnecter");
  const branchements = el("div");
  const alertes = el("div");
  const pointMails = el("div");
  const sauvegardes = el("div");
  let attentePrenom = null;
  cible.append(el("div", { class: "page reglages-page" },
    el("div", { class: "tete" }, el("h1", {}, "Réglages")),
    el("section", {}, el("h2", {}, "Apparence"), el("div", { class: "liste-carte" },
      ligne("Prénom", "Pour la salutation de l'accueil, et la signature des réponses rédigées par l'IA.", el("input", {
        "aria-label": "Prénom", value: localStorage.getItem(PREF_PRENOM) || "", placeholder: "Ton prénom", autocomplete: "given-name",
        oninput: (e) => {
          localStorage.setItem(PREF_PRENOM, e.target.value.trim());
          clearTimeout(attentePrenom);
          attentePrenom = setTimeout(() => api("/api/connecteurs/profil", { methode: "PUT", corps: { prenom: e.target.value.trim() } }).catch(() => {}), 600);
        },
      })),
      ligne("Taille du texte", "S'applique à cet appareil seulement.", taille))),
    alertes,
    pointMails,
    sauvegardes,
    branchements,
    !moduleActif("sport") ? null : el("section", {}, el("h2", {}, "Strava"), el("div", { class: "liste-carte bloc-libre" }, strava ? blocStrava(strava) : el("p", { class: "erreur" }, "Strava ne répond pas."))),
    el("section", {}, el("h2", {}, "Application Android"), el("div", { class: "liste-carte" },
      ligne("Poste pour Android", "L'application affiche cette même interface et se met à jour toute seule ; ne la réinstalle qu'après un changement de permissions.",
        el("a", { href: "/telecharger/poste.apk", class: "bouton-lien" }, "Télécharger l'APK")))),
    el("section", {}, el("h2", {}, "Session"), el("div", { class: "liste-carte" },
      ligne("Cet appareil", `Poste ${etat.version || ""}`, sortir)))));
  await Promise.all([blocAlertes(alertes), blocPointMails(pointMails), blocSauvegardes(sauvegardes), blocsBranchements(branchements)]);
}
