import { api, el, fab, fenetre, glissable, jauge, moduleActif, quand, toast, vide } from "../js/outils.js";
import { boutonMicro } from "../js/micro.js";

export const PREF_PRENOM = "poste-prenom";
const heure = (iso) => iso.slice(11, 16);
const SOURCES = { Agenda: "agenda", Tâches: "taches", Mails: "mails", Serveur: "serveur", Hermes: "hermes" };

// Téléphone : pas de menu latéral, la recherche globale se lance d'ici (ou depuis « Plus »).
function boutonChercher() {
  const b = el("button", { class: "fx-outil chercher-partout", title: "Rechercher partout", "aria-label": "Rechercher partout", onclick: () => window.posteRechercher?.() });
  b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
  return b;
}

function salutation() {
  const h = new Date().getHours();
  const mot = h < 5 || h >= 18 ? "Bonsoir" : "Bonjour";
  const prenom = (localStorage.getItem(PREF_PRENOM) || "").trim();
  return prenom ? `${mot} ${prenom}` : mot;
}

// Actions rapides : un petit formulaire, sans quitter l'accueil (la note, elle, s'ouvre dans l'éditeur).
function ajouterTache(surFin) {
  const titre = el("input", { required: true, placeholder: "Que faut-il faire ?", "aria-label": "Tâche" });
  const echeance = el("input", { type: "date", "aria-label": "Échéance", value: new Date().toISOString().slice(0, 10) });
  const erreur = el("p", { class: "erreur" });
  const d = fenetre("Nouvelle tâche", el("form", {
    class: "pile",
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api("/api/taches", { methode: "POST", corps: { titre: titre.value.trim(), echeance: echeance.value || null } });
        d.close();
        surFin();
      } catch (err) { erreur.textContent = err.message; }
    },
  }, el("div", { class: "champ-micro" }, titre, boutonMicro(titre)), echeance, erreur, el("div", { class: "boutons" }, el("button", { class: "plein" }, "Ajouter"), el("button", { type: "button", onclick: () => d.close() }, "Annuler"))));
  titre.focus();
}

function ajouterRdv(surFin) {
  const proche = new Date(Date.now() + 3600e3);
  proche.setMinutes(0, 0, 0);
  const local = new Date(proche.getTime() - proche.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
  const titre = el("input", { required: true, placeholder: "Titre", "aria-label": "Titre" });
  const debut = el("input", { required: true, type: "datetime-local", "aria-label": "Début", value: local });
  const lieu = el("input", { placeholder: "Lieu (facultatif)", "aria-label": "Lieu" });
  const erreur = el("p", { class: "erreur" });
  const d = fenetre("Nouveau rendez-vous", el("form", {
    class: "pile",
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api("/api/agenda", { methode: "POST", corps: { titre: titre.value.trim(), debut: debut.value, lieu: lieu.value.trim() } });
        d.close();
        surFin();
      } catch (err) { erreur.textContent = err.message; }
    },
  }, el("div", { class: "champ-micro" }, titre, boutonMicro(titre)), debut, lieu, erreur, el("div", { class: "boutons" }, el("button", { class: "plein" }, "Ajouter"), el("button", { type: "button", onclick: () => d.close() }, "Annuler"))));
  titre.focus();
}

async function nouvelleNote() {
  const maintenant = new Date();
  const nom = `Note du ${maintenant.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })} ${maintenant.toTimeString().slice(0, 5).replace(":", "h")}`;
  const chemin = `Notes/${nom}.md`;
  await api("/api/espace/fichier", { methode: "PUT", corps: { chemin, contenu: "" } });
  location.hash = `#fichiers/f/${encodeURIComponent(chemin)}`;
}

// La journée : rendez-vous à l'heure, tâches du jour en tête, et un repère « Maintenant ».
function journee(d) {
  const maintenant = new Date().toTimeString().slice(0, 5);
  const points = d.rdv.filter((r) => !r.journee).map((r) => ({ h: heure(r.debut), titre: r.titre, detail: r.lieu, lien: "#agenda", type: "rdv" }));
  const lignes = [];
  // Journées entières (congés, anniversaires des agendas branchés) : en tête, sans heure.
  for (const r of d.rdv.filter((x) => x.journee)) {
    lignes.push(el("a", { class: "tl-point journee", href: "#agenda" },
      el("span", { class: "tl-heure" }, "Journée"), el("span", { class: "tl-titre" }, r.titre)));
  }
  for (const t of d.taches) {
    const retard = t.echeance < new Date().toISOString().slice(0, 10);
    lignes.push(el("a", { class: `tl-point tache${retard ? " retard" : ""}`, href: "#taches" },
      el("span", { class: "tl-heure" }, retard ? "En retard" : "Aujourd'hui"), el("span", { class: "tl-titre" }, t.titre)));
  }
  let repere = false;
  for (const p of points) {
    if (!repere && p.h > maintenant) {
      lignes.push(el("div", { class: "tl-maintenant" }, el("span", {}, `Maintenant · ${maintenant}`)));
      repere = true;
    }
    lignes.push(el("a", { class: `tl-point${p.h < maintenant ? " passe" : ""}`, href: p.lien },
      el("span", { class: "tl-heure num" }, p.h),
      el("span", { class: "tl-titre" }, p.titre, p.detail ? el("span", { class: "doux petit" }, ` · ${p.detail}`) : null)));
  }
  if (points.length && !repere) lignes.push(el("div", { class: "tl-maintenant" }, el("span", {}, `Maintenant · ${maintenant}`)));
  return el("section", { class: "carte" }, el("h2", {}, "Ta journée"),
    lignes.length ? el("div", { class: "ligne-temps" }, lignes) : vide("Rien de prévu aujourd'hui."));
}

function serveurResume(s) {
  const arretes = s.services.filter((x) => x.etat !== "active");
  const etat = arretes.length
    ? el("span", { class: `pastille ${arretes.some((x) => x.etat === "failed") ? "panne" : "attention"}` },
      `${arretes.map((x) => x.nom).join(", ")} : ${arretes.length > 1 ? "arrêtés" : "arrêté"}`)
    : el("span", { class: "pastille ok" }, "Tout tourne");
  const mesure = (nom, texte, part) => el("div", { class: "mini-mesure" },
    el("div", { class: "mesure-tete petit" }, el("span", { class: "doux" }, nom), el("span", { class: "num" }, texte)), jauge(part));
  return el("section", { class: "carte" },
    el("h2", { class: "h2-lien" }, "Serveur", el("a", { href: "#serveur", class: "petit doux" }, "Détails")),
    el("p", { class: "resume-serveur" }, etat),
    el("div", { class: "mini-mesures" },
      mesure("Processeur", `${Math.round((s.charge / s.coeurs) * 100)} %`, s.charge / s.coeurs),
      mesure("Mémoire", `${Math.round((s.memoire.utilise_go / s.memoire.total_go) * 100)} %`, s.memoire.utilise_go / s.memoire.total_go),
      s.gpu ? mesure("GPU", `${s.gpu.temperature} °C`, s.gpu.charge / 100) : null));
}

function ligneJournal(e) {
  return el(e.lien ? "a" : "div", { class: "ligne", href: e.lien || null },
    el("span", { class: "quand num" }, quand(e.ts)),
    el("span", { class: "corps" },
      el("span", { class: "titre" }, e.titre),
      e.detail ? el("div", { class: "doux petit" }, e.detail) : null),
    el("span", { class: `source etiquette ${SOURCES[e.source] ? `source-${SOURCES[e.source]}` : ""}` }, e.source));
}

// Icônes des actions rapides (tracés écrits ici, jamais une donnée).
const ICONES = {
  tache: '<path d="m5 12 4 4 10-10"/>',
  rdv: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4m8-4v4"/>',
  note: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  envoyer: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  fermer: '<path d="M6 6l12 12M18 6 6 18"/>',
};
const svg = (trace, taille = 22) => {
  const s = el("span", { class: "icone", "aria-hidden": "true" });
  s.innerHTML = `<svg viewBox="0 0 24 24" width="${taille}" height="${taille}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${trace}</svg>`;
  return s;
};

// « Dis-le à Hermes » : la dictée démarre tout de suite, on relit, on envoie.
// « Dis-le à Hermes » : une barre compacte en bas d'écran, comme la saisie vocale de Claude (une ligne qui grandit,
// l'onde dessous pendant la dictée, trois boutons ronds), au lieu d'une grande fenêtre.
function direAHermes() {
  const texte = el("textarea", { rows: 1, placeholder: "Parle, le texte s'écrit ici…", "aria-label": "Message pour Hermes" });
  const micro = boutonMicro(texte, { etiquette: "Dicter à Hermes" });
  const fermer = el("button", { type: "button", class: "rond", "aria-label": "Fermer", title: "Fermer", onclick: () => d.close() }, svg(ICONES.fermer, 18));
  const envoyer = el("button", { class: "plein rond", "aria-label": "Envoyer à Hermes", title: "Envoyer à Hermes" }, svg(ICONES.envoyer, 20));
  const d = el("dialog", { class: "dis-le", "aria-label": "Dis-le à Hermes", onclose: () => d.remove() }, el("form", {
    class: "dis-le-barre",
    onsubmit: (e) => {
      e.preventDefault();
      if (!texte.value.trim()) return;
      sessionStorage.setItem("hermes-question", texte.value.trim());
      d.close();
      location.hash = "#hermes";
    },
  }, fermer, texte, micro, envoyer));
  document.body.append(d);
  d.showModal();
  glissable(d);
  if (!micro.hidden) micro.click();
  else texte.focus();
}

function prochainRdv(d) {
  const maintenant = new Date();
  const h = maintenant.toTimeString().slice(0, 5);
  const r = d.rdv.find((x) => !x.journee && heure(x.debut) >= h);
  if (!r) return null;
  const minutes = Math.round((new Date(`${r.debut}:00`) - maintenant) / 60000);
  const dans = minutes < 1 ? "maintenant" : minutes < 60 ? `dans ${minutes} min` : `dans ${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${String(minutes % 60).padStart(2, "0")}` : ""}`;
  return el("a", { class: "carte carte-lien prochain", href: "#agenda" },
    el("span", { class: "prochain-etiquette" }, `Prochain rendez-vous · ${dans}`),
    el("span", { class: "prochain-heure num" }, heure(r.debut)),
    el("span", { class: "prochain-titre" }, r.titre),
    r.lieu ? el("span", { class: "doux" }, r.lieu) : null);
}

// Le point des mails du jour, à la taille choisie dans Réglages (petit : la phrase ; moyen : + urgents et importants ;
// grand : tout). Mêmes repères que dans Mails : pastille verte ou rouge, filet de couleur par liste.
const LISTES_POINT = [["urgences", "Urgent"], ["importants", "Important"], ["bonnes", "Bonnes nouvelles"], ["mauvaises", "Mauvaises nouvelles"]];
function pointDuJour(c) {
  if (!c) return null;
  const p = c.point;
  const tete = el("h2", { class: "h2-lien" }, "Le point des mails", el("a", { href: "#mails", class: "petit doux" }, p ? "Ouvrir" : "Le préparer"));
  if (!p) {
    return el("section", { class: "carte point-accueil" }, tete,
      el("p", { class: "point-titre attente" }, "Pas encore de point aujourd'hui."));
  }
  const listes = c.taille === "petit" ? [] : c.taille === "moyen" ? LISTES_POINT.slice(0, 2) : LISTES_POINT;
  const lien = (e) => el("a", { class: `point-mail${e.lu ? "" : " non-lu"}`, href: `#mails/${e.compte}/${e.uid}` },
    el("span", { class: "point-pastille", "aria-label": e.lu ? "lu" : "non lu" }),
    el("span", { class: "point-texte" }, el("span", { class: "point-qui" }, e.de), el("span", { class: "point-note" }, e.note || e.sujet)));
  return el("section", { class: `carte point-accueil taille-${c.taille}` }, tete,
    el("p", { class: `point-titre ${p.urgent ? "urgent" : "calme"}` }, p.titre),
    c.taille === "grand" && (p.aujourdhui || p.semaine) ? el("dl", { class: "point-recit" },
      p.aujourdhui ? [el("dt", {}, "Aujourd'hui"), el("dd", {}, p.aujourdhui)] : null,
      p.semaine ? [el("dt", {}, "La semaine"), el("dd", {}, p.semaine)] : null) : null,
    listes.filter(([cle]) => p[cle]?.length).map(([cle, titre]) => el("div", { class: `point-liste ${cle}` },
      el("h3", { class: "titre-groupe" }, titre, el("span", { class: "point-compte num" }, String(p[cle].length))), p[cle].map(lien))));
}

export async function vueAccueil(cible) {
  const page = el("div", { class: "page accueil" });
  cible.append(page);
  async function dessiner() {
    const d = await api("/api/accueil");
    const aujourdhui = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    const champ = el("input", { placeholder: "Demander à Hermes…", "aria-label": "Demander à Hermes", name: "q", autocomplete: "off" });
    const tuile = (icone, texte, faire) => el("button", { class: "tuile-action", type: "button", onclick: faire }, svg(ICONES[icone]), el("span", {}, texte));
    const tousJournal = el("details", { class: "plus-journal" }, el("summary", {}, "Tout le journal"), d.journal.slice(6).map(ligneJournal));
    const prenom = (localStorage.getItem(PREF_PRENOM) || "").trim();
    const envoyer = el("button", { class: "plein envoyer-rond", "aria-label": "Envoyer à Hermes" }, svg(ICONES.envoyer, 20), el("span", { class: "texte-envoyer" }, "Envoyer"));
    page.replaceChildren(...[
      el("div", { class: "salut" },
        el("div", {}, el("h1", {}, salutation()), el("p", { class: "doux" }, aujourdhui.charAt(0).toUpperCase() + aujourdhui.slice(1))),
        el("div", { class: "salut-actions" }, boutonChercher(),
          el("a", { class: "avatar", href: "#reglages", title: "Réglages", "aria-label": "Réglages" }, prenom ? prenom.charAt(0).toUpperCase() : "P"))),
      moduleActif("mails") ? pointDuJour(d.point) : null,
      !moduleActif("hermes") ? null : el("form", {
        class: "barre-hermes",
        onsubmit: (e) => {
          e.preventDefault();
          if (!champ.value.trim()) return;
          sessionStorage.setItem("hermes-question", champ.value);
          location.hash = "#hermes";
        },
      }, champ, boutonMicro(champ, { etiquette: "Dicter à Hermes" }), envoyer),
      el("div", { class: "tuiles-actions" },
        moduleActif("taches") ? tuile("tache", "Tâche", () => ajouterTache(dessiner)) : null,
        moduleActif("agenda") ? tuile("rdv", "RDV", () => ajouterRdv(dessiner)) : null,
        tuile("note", "Note", () => nouvelleNote().catch((err) => toast(err.message))),
        moduleActif("mails") ? tuile("mail", "Brouillon", () => { sessionStorage.setItem("poste-nouveau-brouillon", "1"); location.hash = "#mails"; }) : null),
      el("div", { class: "colonnes" },
        el("div", {},
          prochainRdv(d),
          journee(d),
          el("section", { class: "carte" }, el("h2", {}, "Journal"),
            d.journal.length ? [...d.journal.slice(0, 6).map(ligneJournal), d.journal.length > 6 ? tousJournal : null] : vide("Rien pour l'instant."))),
        el("div", { class: "jour" },
          !moduleActif("mails") ? null : el("section", { class: "carte" }, el("h2", { class: "h2-lien" }, "Mails importants", el("a", { href: "#mails", class: "petit doux" }, "Tous")),
            d.mails.length ? d.mails.map((m) => el("a", { class: "ligne", href: `#mails/${m.compte}/${m.uid}` },
              el("span", { class: "corps" }, el("span", { class: "titre" }, m.sujet), el("div", { class: "doux petit" }, m.de)))) : vide("Rien de nouveau.")),
          serveurResume(d.serveur))),
      moduleActif("hermes") ? fab("micro", "Dis-le à Hermes", direAHermes, true) : null].filter(Boolean));
  }
  await dessiner();
  // Un mail arrive pendant que l'accueil est ouvert : la carte « Mails importants » se met à jour (jamais pendant une saisie).
  let montee = false;
  const surMails = () => {
    if (!page.isConnected) { if (montee) window.removeEventListener("poste:mails", surMails); return; }
    montee = true;
    if (![...page.querySelectorAll("input, textarea")].some((c) => c.value.trim()) && !document.querySelector("dialog[open]")) dessiner();
  };
  window.addEventListener("poste:mails", surMails);
}
