import { api, el, fenetre, vide } from "../js/outils.js";
import { analyser, jourIso } from "../js/dates.js";
import { boutonMicro } from "../js/micro.js";

const PREF_VUE = "poste-agenda-vue";
const jourLong = (iso) => new Date(`${iso.slice(0, 10)}T12:00`).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const majuscule = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const debutSemaine = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const plusJours = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const NOMS_JOURS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];

// Formulaire complet, dans une fenêtre : création (avec une date proposée) ou modification.
function formulaire(surFin, e = null, debutPropose = "") {
  const titre = el("input", { required: true, placeholder: "Titre", "aria-label": "Titre", value: e?.titre || "" });
  const debut = el("input", { required: true, type: "datetime-local", "aria-label": "Début", value: e?.debut || debutPropose });
  const fin = el("input", { type: "datetime-local", "aria-label": "Fin", value: e?.fin || "" });
  const lieu = el("input", { placeholder: "Lieu", "aria-label": "Lieu", value: e?.lieu || "" });
  const rappel = el("select", { "aria-label": "Rappel" },
    [[0, "Pas de rappel"], [15, "Rappel 15 min avant"], [60, "Rappel 1 h avant"], [1440, "Rappel la veille"]].map(([v, t]) =>
      el("option", { value: v, selected: (e?.rappel_minutes ?? 15) === v }, t)));
  const erreur = el("p", { class: "erreur" });
  const supprimer = e ? el("button", {
    type: "button", class: "lien alerte",
    onclick: async () => {
      if (!confirm(`Supprimer « ${e.titre} » ?`)) return;
      await api(`/api/agenda/${e.id}`, { methode: "DELETE" });
      d.close();
      surFin();
    },
  }, "Supprimer") : null;
  const d = fenetre(e ? "Modifier le rendez-vous" : "Nouveau rendez-vous", el("form", {
    class: "pile",
    onsubmit: async (ev) => {
      ev.preventDefault();
      const corps = { titre: titre.value.trim(), debut: debut.value, fin: fin.value || null, lieu: lieu.value.trim(), rappel_minutes: Number(rappel.value) };
      try {
        await api(e ? `/api/agenda/${e.id}` : "/api/agenda", { methode: e ? "PUT" : "POST", corps });
        d.close();
        surFin();
      } catch (err) {
        erreur.textContent = err.message;
      }
    },
  }, el("div", { class: "champ-micro" }, titre, boutonMicro(titre)), el("div", { class: "filtres" }, debut, fin), lieu, rappel, erreur,
  el("div", { class: "boutons" }, el("button", { class: "plein" }, e ? "Enregistrer" : "Ajouter"), el("button", { type: "button", onclick: () => d.close() }, "Annuler"), supprimer)));
  titre.focus();
}

// Événement d'un agenda branché (Google, iCloud…) : lecture seule, on le modifie dans son agenda d'origine.
function fiche(e) {
  const heure = e.journee ? "Toute la journée" : `${e.debut.slice(11, 16)}${e.fin && e.fin.slice(0, 10) === e.debut.slice(0, 10) ? ` – ${e.fin.slice(11, 16)}` : ""}`;
  const d = fenetre(e.titre,
    el("p", { class: "ag-fiche-quand" }, `${majuscule(jourLong(e.debut))} · ${heure}`),
    e.lieu ? el("p", { class: "doux" }, e.lieu) : null,
    e.notes ? el("p", { class: "ag-fiche-notes" }, e.notes) : null,
    el("p", { class: "doux petit" }, `Agenda « ${e.source} », en lecture seule : modifie-le dans son application d'origine.`),
    el("div", { class: "boutons" }, el("button", { type: "button", onclick: () => d.close() }, "Fermer")));
}

const heureDe = (e) => (e.journee ? "Journée" : e.debut.slice(11, 16));

export async function vueAgenda(cible) {
  let vue = ["liste", "semaine", "mois"].includes(localStorage.getItem(PREF_VUE)) ? localStorage.getItem(PREF_VUE) : "liste";
  let reference = new Date();
  const zone = el("div", { class: "ag-zone" });
  const periode = el("strong", { class: "ag-periode" });
  const onglets = el("div", { class: "segments", role: "tablist", "aria-label": "Affichage" });
  const navigation = el("div", { class: "ag-nav" },
    el("button", { class: "fx-outil", "aria-label": "Précédent", onclick: () => decaler(-1) }, "‹"),
    el("button", { onclick: () => { reference = new Date(); dessiner(); } }, "Aujourd'hui"),
    el("button", { class: "fx-outil", "aria-label": "Suivant", onclick: () => decaler(1) }, "›"),
    periode);
  const ouvrir = (e) => (e.externe ? fiche(e) : formulaire(dessiner, e));
  const nouveau = (jour) => formulaire(dessiner, null, jour ? `${jour}T09:00` : "");

  function decaler(sens) {
    if (vue === "semaine") reference = plusJours(reference, 7 * sens);
    else reference = new Date(reference.getFullYear(), reference.getMonth() + sens, 1);
    dessiner();
  }

  // Ajout rapide : on montre ce qui sera créé avant d'appuyer sur Entrée.
  const rapide = el("input", { placeholder: "Ajout rapide : « demain 14h appel Dupont »", "aria-label": "Ajout rapide", autocomplete: "off" });
  const apercu = el("p", { class: "doux petit ag-apercu" });
  rapide.addEventListener("input", () => {
    const r = analyser(rapide.value);
    apercu.textContent = !rapide.value.trim() ? ""
      : r && r.titre ? `→ ${majuscule(jourLong(r.debut))} à ${r.debut.slice(11, 16)} · ${r.titre}` : "Ajoute un jour ou une heure : « lundi 9h », « le 12 à 18h », « 24/12 »…";
  });
  const formRapide = el("form", {
    class: "hermes-rapide une-ligne ag-rapide",
    onsubmit: async (ev) => {
      ev.preventDefault();
      const r = analyser(rapide.value);
      if (!r || !r.titre) return;
      try {
        await api("/api/agenda", { methode: "POST", corps: { titre: r.titre, debut: r.debut } });
        rapide.value = "";
        apercu.textContent = "Ajouté.";
        reference = new Date(`${r.debut}:00`);
        dessiner();
      } catch (err) {
        apercu.textContent = err.message;
      }
    },
  }, rapide, boutonMicro(rapide, { etiquette: "Dicter le rendez-vous" }), el("button", { class: "plein" }, "Ajouter"));

  const evenement = (e, classe = "ag-evt") => el("button", {
    class: `${classe}${e.externe ? " externe" : ""}`, type: "button", onclick: () => ouvrir(e),
    title: [e.titre, e.lieu, e.externe ? e.source : ""].filter(Boolean).join(" · "),
  }, el("span", { class: "num doux" }, heureDe(e)), " ", e.titre);

  async function liste() {
    periode.textContent = "À venir";
    const evenements = await api("/api/agenda");
    const parJour = new Map();
    for (const e of evenements) parJour.set(e.debut.slice(0, 10), [...(parJour.get(e.debut.slice(0, 10)) || []), e]);
    return evenements.length ? [...parJour].map(([j, items]) => el("section", {},
      el("h2", {}, majuscule(jourLong(j))),
      items.map((e) => el("button", { class: `ligne ag-ligne${e.externe ? " externe" : ""}`, type: "button", onclick: () => ouvrir(e) },
        el("span", { class: "quand num" }, heureDe(e)),
        el("span", { class: "corps" }, e.titre, e.lieu || e.externe ? el("div", { class: "doux petit" }, [e.lieu, e.externe ? e.source : ""].filter(Boolean).join(" · ")) : null))))) : [vide("Rien de prévu.")];
  }

  async function semaine() {
    const lundi = debutSemaine(reference);
    const dimanche = plusJours(lundi, 6);
    periode.textContent = `${lundi.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} – ${dimanche.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}`;
    const evenements = await api(`/api/agenda?du=${jourIso(lundi)}T00:00&au=${jourIso(dimanche)}T23:59`);
    const auj = jourIso(new Date());
    return [el("div", { class: "ag-semaine" }, Array.from({ length: 7 }, (_, i) => {
      const j = jourIso(plusJours(lundi, i));
      const items = evenements.filter((e) => e.debut.startsWith(j));
      return el("div", { class: `ag-jour${j === auj ? " aujourdhui" : ""}${j < auj ? " passe" : ""}` },
        el("div", { class: "ag-jour-tete" }, el("span", { class: "doux" }, NOMS_JOURS[i]),
          el("span", { class: "ag-tete-droite" },
            el("button", { class: "ag-ajout", type: "button", title: "Ajouter", "aria-label": `Ajouter le ${jourLong(j)}`, onclick: () => nouveau(j) }, "+"),
            el("span", { class: "ag-num num" }, String(Number(j.slice(8)))))),
        items.map((e) => evenement(e)));
    }))];
  }

  async function mois() {
    const premier = new Date(reference.getFullYear(), reference.getMonth(), 1);
    const debut = debutSemaine(premier);
    const dernier = new Date(reference.getFullYear(), reference.getMonth() + 1, 0);
    const semaines = Math.ceil(((dernier - debut) / 864e5 + 1) / 7);
    const fin = plusJours(debut, semaines * 7 - 1);
    periode.textContent = majuscule(premier.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }));
    const evenements = await api(`/api/agenda?du=${jourIso(debut)}T00:00&au=${jourIso(fin)}T23:59`);
    const auj = jourIso(new Date());
    const detail = el("div", { class: "ag-detail" });
    const montrerJour = (j) => {
      const items = evenements.filter((e) => e.debut.startsWith(j));
      detail.replaceChildren(el("h2", { class: "h2-lien" }, majuscule(jourLong(j)), el("button", { class: "lien petit", onclick: () => nouveau(j) }, "+ Ajouter")),
        ...(items.length ? items.map((e) => evenement(e, "ligne ag-ligne")) : [vide("Rien ce jour-là.")]));
    };
    const grille = el("div", { class: "ag-mois" },
      NOMS_JOURS.map((n) => el("div", { class: "ag-mois-nom doux petit" }, n)),
      Array.from({ length: semaines * 7 }, (_, i) => {
        const date = plusJours(debut, i);
        const j = jourIso(date);
        const items = evenements.filter((e) => e.debut.startsWith(j));
        return el("button", {
          type: "button", class: `ag-case${date.getMonth() !== premier.getMonth() ? " hors" : ""}${j === auj ? " aujourdhui" : ""}`,
          "aria-label": `${jourLong(j)}, ${items.length} rendez-vous`, onclick: () => montrerJour(j),
        }, el("span", { class: "ag-num num" }, String(date.getDate())),
        el("span", { class: "ag-titres" }, items.slice(0, 3).map((e) => el("span", { class: `ag-mini${e.externe ? " externe" : ""}` }, e.titre)),
          items.length > 3 ? el("span", { class: "doux petit" }, `+${items.length - 3}`) : null),
        items.length ? el("span", { class: "ag-points" }, items.slice(0, 4).map(() => el("i", {}))) : null);
      }));
    montrerJour(premier.getMonth() === new Date().getMonth() && premier.getFullYear() === new Date().getFullYear() ? auj : jourIso(premier));
    return [grille, detail];
  }

  async function dessiner() {
    onglets.replaceChildren(...[["liste", "Liste"], ["semaine", "Semaine"], ["mois", "Mois"]].map(([id, texte]) => el("button", {
      role: "tab", "aria-selected": String(vue === id), class: vue === id ? "actif" : "",
      onclick: () => { vue = id; localStorage.setItem(PREF_VUE, id); dessiner(); },
    }, texte)));
    navigation.hidden = vue === "liste";
    try {
      zone.replaceChildren(...await { liste, semaine, mois }[vue]());
    } catch (err) {
      zone.replaceChildren(el("p", { class: "erreur" }, err.message));
    }
  }

  cible.append(el("div", { class: "page agenda" },
    el("div", { class: "tete" }, el("h1", {}, "Agenda"), el("button", { class: "bouton-principal", onclick: () => nouveau(vue === "liste" ? "" : jourIso(reference)) }, "Nouveau rendez-vous")),
    formRapide, apercu,
    el("div", { class: "ag-barre" }, onglets, navigation),
    zone));
  await dessiner();
}

