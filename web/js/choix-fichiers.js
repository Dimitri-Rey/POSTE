// Choisir un ou plusieurs fichiers de l'espace Fichiers (pour les joindre à Hermes) : on parcourt les dossiers ou on
// cherche par nom, on coche, « Joindre ». Renvoie la liste des fichiers choisis ({ chemin, nom, taille }) ou [] si annulé.
import { api, el, glissable } from "./outils.js";

const CHOIX_MAX = 10;
const TAILLE_MAX = 100 * 1024 * 1024; // la limite des documents joints
const RESULTATS_MAX = 200;

const taille = (o) => (o < 1024 ? `${o} o` : o < 1048576 ? `${Math.round(o / 1024)} Ko` : `${(o / 1048576).toFixed(1)} Mo`);
const date = (s) => new Date(s * 1000).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const sansAccents = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("fr");
const nomDe = (chemin) => chemin.split("/").pop();
const parentDe = (chemin) => chemin.split("/").slice(0, -1).join("/");

const SVG = (d, l = 18) => `<svg viewBox="0 0 24 24" width="${l}" height="${l}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONE_DOSSIER = SVG('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>');
const ICONE_FICHIER = SVG('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>');
const ICONE_IMAGE = SVG('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/>');
const ICONE_COCHE = SVG('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 14);
const ICONE_FERMER = SVG('<path d="M6 6l12 12M18 6L6 18"/>');
const icone = (e) => (e.dossier ? ICONE_DOSSIER : /\.(png|jpe?g|gif|webp|avif|heic)$/i.test(e.chemin) ? ICONE_IMAGE : ICONE_FICHIER);

export async function choisirDansFichiers() {
  return new Promise((rendre) => {
    let arbre = null;
    let dossier = sessionStorage.getItem("poste-choix-dossier") || "";
    const choisis = new Map();
    let rendu = false;

    const chercher = el("input", { type: "search", placeholder: "Chercher un fichier par son nom", "aria-label": "Chercher un fichier par son nom" });
    const chemin = el("nav", { class: "cf-chemin", "aria-label": "Dossier affiché" });
    const liste = el("ul", { class: "cf-liste", "aria-label": "Fichiers" });
    const compte = el("span", { class: "cf-compte", role: "status" });
    const joindre = el("button", { type: "button", class: "plein", disabled: true }, "Joindre");
    const annuler = el("button", { type: "button" }, "Annuler");
    const fermer = el("button", { type: "button", class: "lecteur-outil", "aria-label": "Fermer" });
    fermer.innerHTML = ICONE_FERMER;

    const d = el("dialog", { class: "choix-fichiers", "aria-label": "Joindre depuis Fichiers",
      onclose: () => { d.remove(); if (!rendu) rendre([]); },
      onclick: (e) => { if (e.target === d) d.close(); } },
    el("div", { class: "cf-tete" }, el("h2", {}, "Joindre depuis Fichiers"), fermer),
    el("div", { class: "cf-outils" }, chercher, chemin),
    liste,
    el("div", { class: "cf-pied" }, compte, annuler, joindre));

    const finir = () => { rendu = true; rendre([...choisis.values()]); d.close(); };
    fermer.onclick = () => d.close();
    annuler.onclick = () => d.close();
    joindre.onclick = finir;

    const majPied = () => {
      const n = choisis.size;
      compte.textContent = n ? `${n} fichier${n > 1 ? "s" : ""} choisi${n > 1 ? "s" : ""}` : "Aucun fichier choisi";
      joindre.disabled = !n;
      joindre.textContent = n > 1 ? `Joindre les ${n}` : "Joindre";
    };

    const ligne = (e, avecDossier) => {
      const pris = choisis.has(e.chemin);
      const trop = !e.dossier && e.taille > TAILLE_MAX;
      const meta = e.dossier ? "Dossier"
        : [avecDossier ? (parentDe(e.chemin) || "Fichiers") : null, taille(e.taille), date(e.modifie)].filter(Boolean).join(" · ");
      const b = el("button", {
        type: "button", class: `cf-element${e.dossier ? " dossier" : ""}${pris ? " pris" : ""}`, disabled: trop,
        title: trop ? "Trop gros pour être joint (100 Mo au plus)" : e.chemin,
        ...(e.dossier ? {} : { role: "checkbox", "aria-checked": String(pris) }),
        onclick: () => {
          if (e.dossier) { dossier = e.chemin; chercher.value = ""; dessiner(); liste.scrollTop = 0; return; }
          if (choisis.has(e.chemin)) choisis.delete(e.chemin);
          else if (choisis.size < CHOIX_MAX) choisis.set(e.chemin, { chemin: e.chemin, nom: nomDe(e.chemin), taille: e.taille });
          else { compte.textContent = `${CHOIX_MAX} fichiers au plus par message`; return; }
          dessiner();
        },
        ondblclick: () => { if (!e.dossier && choisis.has(e.chemin)) finir(); },
      });
      const signe = el("span", { class: "cf-signe", "aria-hidden": "true" });
      signe.innerHTML = e.dossier ? ICONE_DOSSIER : pris ? ICONE_COCHE : icone(e);
      b.append(signe, el("span", { class: "cf-texte" }, el("span", { class: "cf-nom" }, nomDe(e.chemin)), el("span", { class: "cf-meta" }, meta)));
      if (e.dossier) b.append(el("span", { class: "cf-fleche", "aria-hidden": "true" }, "›"));
      return el("li", {}, b);
    };

    function dessinerChemin() {
      const morceaux = dossier ? dossier.split("/") : [];
      const lien = (nom, cible, actif) => el("button", { type: "button", class: `cf-etape${actif ? " actif" : ""}`, "aria-current": actif ? "location" : null,
        onclick: () => { dossier = cible; dessiner(); } }, nom);
      chemin.replaceChildren(lien("Fichiers", "", !morceaux.length),
        ...morceaux.flatMap((m, i) => [el("span", { class: "cf-sep", "aria-hidden": "true" }, "/"), lien(m, morceaux.slice(0, i + 1).join("/"), i === morceaux.length - 1)]));
    }

    function dessiner() {
      majPied();
      if (!arbre) return;
      const texte = sansAccents(chercher.value.trim());
      chemin.hidden = Boolean(texte);
      let elements;
      if (texte) {
        elements = arbre.filter((e) => !e.dossier && sansAccents(nomDe(e.chemin)).includes(texte))
          .sort((a, b) => b.modifie - a.modifie).slice(0, RESULTATS_MAX);
      } else {
        if (dossier && !arbre.some((e) => e.dossier && e.chemin === dossier)) dossier = "";
        sessionStorage.setItem("poste-choix-dossier", dossier);
        dessinerChemin();
        elements = arbre.filter((e) => parentDe(e.chemin) === dossier)
          .sort((a, b) => (b.dossier - a.dossier) || a.chemin.localeCompare(b.chemin, "fr", { sensitivity: "base" }));
      }
      liste.replaceChildren(...(elements.length ? elements.map((e) => ligne(e, Boolean(texte)))
        : [el("li", { class: "cf-vide" }, texte ? "Aucun fichier ne porte ce nom." : "Ce dossier est vide.")]));
    }

    chercher.addEventListener("input", dessiner);
    document.body.append(d);
    d.showModal();
    glissable(d);
    liste.append(el("li", { class: "cf-vide" }, "Chargement…"));
    majPied();
    api("/api/espace/arbre").then((a) => { arbre = a; dessiner(); })
      .catch((err) => liste.replaceChildren(el("li", { class: "cf-vide erreur" }, err.message)));
    if (matchMedia("(min-width: 761px)").matches) chercher.focus();
  });
}
