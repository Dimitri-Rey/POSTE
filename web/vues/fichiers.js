import { api, el, glissable, moduleActif, vide, surRetour } from "../js/outils.js";
import { rendreMarkdown } from "../js/markdown.js";
import { boutonMicro } from "../js/micro.js";

const SUGGESTIONS = "poste-suggestions";
const taille = (o) => (o < 1024 ? `${o} o` : o < 1048576 ? `${Math.round(o / 1024)} Ko` : o < 1073741824 ? `${(o / 1048576).toFixed(1)} Mo` : `${(o / 1073741824).toFixed(1)} Go`);
const parent = (c) => c.split("/").slice(0, -1).join("/");
const nomDe = (c) => c.split("/").pop();
const q = encodeURIComponent;
const adresse = (type, chemin) => `#fichiers/${type}/${q(chemin)}`;

// Comparaison par mots : assez simple pour un texte relu à l'écran. Trop long : on montre seulement le résultat.
function difference(avant, apres) {
  const a = avant.split(/(\s+)/);
  const b = apres.split(/(\s+)/);
  if (a.length * b.length > 4000000) return [el("span", {}, apres)];
  const t = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  const morceaux = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      morceaux.push(el("span", {}, a[i]));
      i += 1;
      j += 1;
    } else if (j < b.length && (i >= a.length || t[i][j + 1] >= t[i + 1][j])) {
      morceaux.push(el("ins", {}, b[j++]));
    } else {
      morceaux.push(el("del", {}, a[i++]));
    }
  }
  return morceaux;
}

async function vueEditeur(cible, chemin) {
  const f = await api(`/api/espace/fichier?chemin=${q(chemin)}`);
  let version = f.version;
  let enregistre = f.contenu;
  let minuteur = null;
  let enCours = Promise.resolve();

  const texte = el("textarea", { class: "editeur", "aria-label": "Texte du fichier", spellcheck: "true" });
  texte.value = f.contenu;
  const apercu = el("div", { class: "bulle assistant apercu", hidden: true });
  const etat = el("span", { class: "doux petit", role: "status" }, "Enregistré");
  const barreSuite = el("button", { class: "suite-ia", type: "button", hidden: true });
  const panneau = el("div", { class: "panneau-ia" });

  // --- Enregistrement automatique : jamais sur une version que l'on n'a pas relue.
  function enregistrer() {
    clearTimeout(minuteur);
    enCours = enCours.then(async () => {
      const contenu = texte.value;
      if (contenu === enregistre) return;
      etat.textContent = "Enregistrement…";
      try {
        const r = await api("/api/espace/fichier", { methode: "PUT", corps: { chemin, contenu, version } });
        version = r.version;
        enregistre = contenu;
        etat.textContent = texte.value === contenu ? "Enregistré" : "Modifié";
      } catch (err) {
        etat.textContent = err.message;
      }
    });
    return enCours;
  }
  const quitter = () => {
    if (!document.body.contains(texte)) {
      window.removeEventListener("hashchange", quitter);
      return;
    }
    enregistrer();
  };

  // --- Suggestions pendant la saisie : seule la dernière demande compte.
  let numero = 0;
  let suggestion = "";
  let minuteurSuite = null;
  const actives = () => localStorage.getItem(SUGGESTIONS) !== "non";
  const effacerSuite = () => {
    numero += 1;
    clearTimeout(minuteurSuite);
    suggestion = "";
    barreSuite.hidden = true;
  };
  function demanderSuite() {
    effacerSuite();
    if (!actives() || texte.selectionStart !== texte.selectionEnd) return;
    const position = texte.selectionStart;
    const avant = texte.value.slice(0, position);
    if (avant.trim().length < 12) return;
    const demande = numero;
    minuteurSuite = setTimeout(async () => {
      const r = await api("/api/espace/ia/suite", { methode: "POST", corps: { avant, apres: texte.value.slice(position) } }).catch(() => null);
      if (demande !== numero || !r?.suite) return;
      suggestion = r.suite;
      barreSuite.replaceChildren(el("span", { class: "doux petit" }, "Suggestion (Tab) "), suggestion);
      barreSuite.hidden = false;
    }, 1000);
  }
  function accepterSuite() {
    const debut = texte.selectionStart;
    const avant = texte.value.slice(0, debut);
    const espace = /\s$/.test(avant) || /^[\s,.;:!?)]/.test(suggestion) ? "" : " ";
    texte.setRangeText(espace + suggestion, debut, texte.selectionEnd, "end");
    effacerSuite();
    texte.focus();
    surModification();
  }
  barreSuite.addEventListener("click", accepterSuite);

  function surModification() {
    etat.textContent = "Modifié";
    clearTimeout(minuteur);
    minuteur = setTimeout(enregistrer, 1200);
  }
  texte.addEventListener("input", () => {
    surModification();
    demanderSuite();
  });
  texte.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && suggestion) {
      e.preventDefault();
      accepterSuite();
    } else if (e.key === "Escape") {
      effacerSuite();
    }
  });

  // --- Correction et réécriture : une proposition à accepter, jamais un remplacement direct.
  function retoucher(demande) {
    const debut = texte.selectionStart;
    const fin = texte.selectionEnd;
    const selection = fin > debut;
    const original = selection ? texte.value.slice(debut, fin) : texte.value;
    if (!original.trim()) return;
    effacerSuite();
    panneau.replaceChildren(el("p", { class: "petit", role: "status" }, selection ? "L'IA relit ta sélection…" : "L'IA relit le texte…"));
    api("/api/espace/ia/retoucher", { methode: "POST", corps: { texte: original, demande } }).then((r) => {
      if (r.texte === original) {
        panneau.replaceChildren(el("p", { class: "petit" }, "Rien à changer."));
        return;
      }
      panneau.replaceChildren(
        el("div", { class: "difference" }, difference(original, r.texte)),
        el("div", { class: "boutons" },
          el("button", {
            class: "plein",
            onclick: () => {
              // Le texte a pu bouger pendant que l'IA travaillait : on ne remplace que s'il est identique.
              const courant = selection ? texte.value.slice(debut, fin) : texte.value;
              if (courant !== original) {
                panneau.replaceChildren(el("p", { class: "erreur" }, "Le texte a changé entre-temps : proposition écartée."));
                return;
              }
              texte.setRangeText(r.texte, selection ? debut : 0, selection ? fin : texte.value.length, "select");
              panneau.replaceChildren();
              surModification();
              if (editeurVisuel) monterVisuel();
            },
          }, "Accepter"),
          el("button", { onclick: () => panneau.replaceChildren() }, "Refuser")));
    }).catch((err) => panneau.replaceChildren(el("p", { class: "erreur" }, err.message)));
  }
  const demandeLibre = el("input", { placeholder: "Ou demande autre chose : plus court, en liste, plus poli…", "aria-label": "Demande à l'IA" });

  const boutonApercu = el("button", {
    onclick: () => {
      const montrer = apercu.hidden;
      apercu.hidden = !montrer;
      texte.hidden = montrer;
      boutonApercu.textContent = montrer ? "Modifier" : "Aperçu";
      if (montrer) apercu.replaceChildren(...rendreMarkdown(texte.value));
    },
  }, "Aperçu");
  // Édition visuelle : le Markdown reste la référence, le texte n'est réécrit qu'à une vraie modification.
  const visuel = el("div", { class: "editeur-visuel", hidden: true });
  let editeurVisuel = null;
  const boutonVisuel = el("button", {
    onclick: async () => {
      const entrer = visuel.hidden;
      boutonVisuel.disabled = true;
      effacerSuite();
      if (entrer) {
        await monterVisuel();
        apercu.hidden = true;
        boutonApercu.textContent = "Aperçu";
      } else {
        await editeurVisuel?.destroy();
        editeurVisuel = null;
        visuel.replaceChildren();
      }
      visuel.hidden = !entrer;
      texte.hidden = entrer;
      boutonApercu.hidden = entrer;
      boutonVisuel.textContent = entrer ? "Source" : "Visuel";
      boutonVisuel.disabled = false;
    },
  }, "Visuel");
  async function monterVisuel() {
    const m = await import("../lib/milkdown.js");
    await editeurVisuel?.destroy();
    visuel.replaceChildren();
    editeurVisuel = await m.Editor.make()
      .config((ctx) => {
        ctx.set(m.rootCtx, visuel);
        ctx.set(m.defaultValueCtx, texte.value);
        ctx.get(m.listenerCtx).markdownUpdated((_, md, avant) => {
          if (md !== avant) {
            texte.value = md;
            surModification();
          }
        });
      })
      .use(m.commonmark).use(m.gfm).use(m.history).use(m.listener)
      .create();
  }
  const caseSuite = el("input", {
    type: "checkbox", class: "case", checked: actives(),
    onchange: (e) => {
      localStorage.setItem(SUGGESTIONS, e.target.checked ? "oui" : "non");
      effacerSuite();
    },
  });

  window.addEventListener("hashchange", quitter);
  document.addEventListener("visibilitychange", () => { if (document.hidden && document.body.contains(texte)) enregistrer(); });
  cible.append(el("div", { class: "page fichiers" },
    el("a", { href: parent(chemin) ? adresse("d", parent(chemin)) : "#fichiers", class: "doux petit" }, "Retour aux fichiers"),
    el("div", { class: "tete" }, el("h1", { class: "nom-fichier" }, nomDe(chemin)), etat),
    el("div", { class: "boutons outils-editeur" },
      boutonMicro(texte, { etiquette: "Dicter dans la note" }),
      el("button", { onclick: () => retoucher("") }, "Corriger"),
      /\.(md|markdown)$/i.test(chemin) ? boutonVisuel : null,
      boutonApercu,
      el("label", { class: "petit doux choix" }, caseSuite, "Suggestions")),
    el("form", {
      class: "demande-ia",
      onsubmit: (e) => {
        e.preventDefault();
        if (demandeLibre.value.trim()) retoucher(demandeLibre.value.trim());
      },
    }, demandeLibre, boutonMicro(demandeLibre), el("button", {}, "Demander")),
    panneau, barreSuite, texte, visuel, apercu));
}

function panneauRangement(surFin) {
  const demande = el("textarea", { rows: 2, placeholder: "Ex. : crée une arborescence Clients, Factures et Notes, puis range tout", "aria-label": "Demande de rangement" });
  const resultat = el("div", {});
  const bouton = el("button", { class: "plein" }, "Proposer un rangement");
  const ligne = (o) => el("li", { class: "mono" }, o.action === "creer_dossier" ? `Créer ${o.chemin}/` : `${o.de} → ${o.vers}`);
  return el("div", {},
    el("form", {
      class: "pile",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!demande.value.trim()) return;
        bouton.disabled = true;
        resultat.replaceChildren(el("p", { class: "petit", role: "status" }, "L'IA prépare un plan…"));
        try {
          const plan = await api("/api/espace/ia/ranger", { methode: "POST", corps: { demande: demande.value } });
          if (!plan.operations.length) {
            resultat.replaceChildren(el("p", { class: "petit" }, plan.resume || "Rien à faire."));
            return;
          }
          resultat.replaceChildren(
            plan.resume ? el("p", {}, plan.resume) : null,
            el("ul", { class: "plan" }, plan.operations.map(ligne)),
            el("p", { class: "doux petit" }, "Rien n'est supprimé, et rien ne change avant ton accord."),
            el("div", { class: "boutons" },
              el("button", {
                class: "plein",
                onclick: async () => {
                  try {
                    await api("/api/espace/appliquer", { methode: "POST", corps: { operations: plan.operations } });
                    surFin();
                  } catch (err) {
                    resultat.append(el("p", { class: "erreur" }, `${err.message} Rien n'a été changé.`));
                  }
                },
              }, "Appliquer"),
              el("button", { onclick: () => resultat.replaceChildren() }, "Annuler")));
        } catch (err) {
          resultat.replaceChildren(el("p", { class: "erreur" }, err.message));
        } finally {
          bouton.disabled = false;
        }
      },
    }, el("div", { class: "champ-micro" }, demande, boutonMicro(demande)), bouton), resultat);
}

// --- Explorateur : préférences gardées entre deux dossiers, sélection propre à chaque vue.
const PREF_VUE = "poste-fichiers-vue";
const PREF_RECHERCHE = "poste-fichiers-recherche";
const PREF_OUVERTURE = "poste-fichiers-ouverture";
const OUVERTURES = {
  nom: "Clic sur le nom",
  ligne: "Clic sur la ligne",
  double: "Double-clic seulement",
};
const MODES_RECHERCHE = {
  vue: { titre: "Dans la vue", court: "Vue", indication: "Filtrer cette vue par nom" },
  noms: { titre: "Noms de fichiers", court: "Noms", indication: "Rechercher un nom dans tous les fichiers" },
  contenu: { titre: "Contenu des fichiers", court: "Contenu", indication: "Rechercher dans le contenu des fichiers" },
};
// Extrait renvoyé par l'API : \x02 et \x03 encadrent les mots trouvés, rendus en <mark> sans passer par innerHTML.
const surligner = (texte) => texte.split(/(\x02[^\x03]*\x03)/).filter(Boolean)
  .map((m) => (m.startsWith("\x02") ? el("mark", {}, m.slice(1, -1)) : m));
const PREF_NOUVEAU = "poste-fichiers-nouveau";
const PREF_OUVRIR = "poste-fichiers-ouvrir-apres";
// ia : Hermes sait le préparer à partir d'une description. texte : créé vide par écriture directe.
const TYPES_NOUVEAUX = [
  { titre: "Note", ext: "md", genre: "note", texte: true }, { titre: "Texte", ext: "txt", genre: "note", texte: true },
  { titre: "Document Word", ext: "docx", genre: "document", ia: true }, { titre: "Document LibreOffice", ext: "odt", genre: "document" },
  { titre: "Classeur Excel", ext: "xlsx", genre: "tableur", ia: true }, { titre: "Classeur LibreOffice", ext: "ods", genre: "tableur" },
  { titre: "Présentation PowerPoint", ext: "pptx", genre: "presentation", ia: true }, { titre: "Présentation LibreOffice", ext: "odp", genre: "presentation" },
  { titre: "Diagramme", ext: "drawio", genre: "diagramme", texte: true, vue: "g", modele: '<mxfile><diagram name="Page-1" id="page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>' },
];
const BUREAU = new Set(["docx", "doc", "odt", "rtf", "xlsx", "xls", "ods", "pptx", "ppt", "odp"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const FAMILLES = {
  pdf: ["pdf"], archive: ["zip", "gz", "tar", "7z", "rar", "xz", "bz2"], audio: ["mp3", "wav", "flac", "ogg", "m4a"],
  video: ["mp4", "mkv", "webm", "mov", "avi"], tableur: ["xlsx", "xls", "ods", "csv"], document: ["docx", "doc", "odt", "rtf"],
  presentation: ["pptx", "ppt", "odp"], diagramme: ["drawio", "vsdx"],
  code: ["js", "ts", "py", "sh", "json", "yml", "yaml", "html", "css", "toml", "sql", "xml"], note: ["md", "txt"],
};
const LIBELLES = {
  dossier: "Dossier", image: "Image", pdf: "PDF", archive: "Archive", audio: "Audio", video: "Vidéo", tableur: "Tableur",
  document: "Document", presentation: "Présentation", diagramme: "Diagramme", code: "Code", note: "Note", fichier: "Fichier",
};
// Fichiers : une feuille de la couleur du type, avec un motif clair. Le reste garde le trait fin de la navigation.
const MOTIFS = {
  document: '<path d="M8 11h8M8 14h8M8 17h5"/>',
  tableur: '<path d="M8 10h8v8H8zM8 14h8M12 10v8"/>',
  presentation: '<rect x="7.5" y="10" width="9" height="6"/><path d="M12 16v2.5"/>',
  pdf: '<path d="M8 17.5c1.5-.6 3.5-3.4 4-7 .3 2.6 2 4.8 4 5.5-2.6-.4-5.6.3-8 1.5"/>',
  diagramme: '<rect x="7" y="9.5" width="4" height="3"/><rect x="13" y="15" width="4" height="3"/><path d="M9 12.5V16.5h4"/>',
  image: '<path d="m7.5 18 3-4 2 2.2 1.8-2.2 2.7 4z" fill="#fff"/><circle cx="10" cy="10.5" r="1.2" fill="#fff"/>',
  video: '<path d="M10 10.5v6.5l5.5-3.2z" fill="#fff"/>',
  audio: '<path d="M11 17V10.5l4.5-1v6"/><circle cx="9.8" cy="17" r="1.3" fill="#fff"/><circle cx="14.3" cy="15.5" r="1.3" fill="#fff"/>',
  archive: '<path d="M12 8.5v1.5m0 1.5v1.5M10.8 14h2.4v3.5h-2.4z"/>',
  code: '<path d="m10 11.5-2.5 2.5 2.5 2.5m4-5 2.5 2.5-2.5 2.5"/>',
  note: '<path d="M8 11h8M8 14h8M8 17h4"/>',
  fichier: "",
};
// Toujours des textes écrits ici, jamais une donnée : innerHTML reste sans risque.
const TRACES = {
  dossier: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z" fill="currentColor" stroke="none"/>',
  recents: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  favoris: '<path d="m12 4 2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>',
  corbeille: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>',
};
const ouverts = new Set();
let tri = { cle: "nom", sens: 1 };
let pressePapiers = null;

const extension = (c) => (nomDe(c).match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
function genre(e) {
  if (e.dossier) return "dossier";
  const x = extension(e.chemin);
  if (IMAGES.has(x)) return "image";
  return Object.keys(FAMILLES).find((f) => FAMILLES[f].includes(x)) || "fichier";
}
function icone(type) {
  const i = el("span", { class: `fx-icone fx-${type}`, "aria-hidden": "true" });
  i.innerHTML = type in MOTIFS
    ? `<svg viewBox="0 0 24 24" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path class="fx-feuille" d="M4 2h11l5 5v15H4z"/><path class="fx-coin" d="M15 2v5h5"/><g fill="none" stroke="#fff">${MOTIFS[type]}</g></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${TRACES[type]}</svg>`;
  return i;
}
// Récent : durée écoulée, comme on le dirait. Ancien : la date. La date exacte reste au survol.
function depuis(ts) {
  const ecart = (Date.now() / 1000 - ts) / 60;
  const date = new Date(ts * 1000);
  const hier = new Date();
  hier.setDate(hier.getDate() - 1);
  if (ecart < 1) return "à l'instant";
  if (ecart < 60) return `${Math.floor(ecart)} min`;
  if (ecart < 60 * 24 && date.toDateString() !== hier.toDateString()) return `${Math.floor(ecart / 60)} h`;
  if (date.toDateString() === hier.toDateString()) return "hier";
  if (ecart < 60 * 24 * 7) return `${Math.ceil(ecart / 60 / 24)} jours`;
  const memeAnnee = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: memeAnnee ? undefined : "numeric" });
}
const dateLongue = (ts) => new Date(ts * 1000).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const joindre = (d, n) => (d ? `${d}/${n}` : n);
const tactile = () => matchMedia("(hover: none)").matches;

function dialogue(titre, ...contenu) {
  const d = el("dialog", { class: "fx-dialogue", onclose: () => d.remove() },
    el("h2", {}, titre), ...contenu);
  document.body.append(d);
  d.showModal();
  glissable(d);
  return d;
}

function confirmer(titre, detail, libelle, faire) {
  const erreur = el("p", { class: "erreur" });
  const oui = el("button", {
    class: "plein",
    onclick: async () => {
      oui.disabled = true;
      try {
        await faire();
        d.close();
      } catch (err) {
        erreur.textContent = err.message;
        oui.disabled = false;
      }
    },
  }, libelle);
  const d = dialogue(titre, el("p", { class: "doux" }, detail), erreur,
    el("div", { class: "boutons" }, oui, el("button", { onclick: () => d.close() }, "Annuler")));
}

// Tout sur le même modèle : icône à gauche, dossier ouvrable, et cible de dépôt pour le glisser.
function panneauDossiers(arbre, dossier, { depot, surChoix }) {
  const dossiers = arbre.filter((e) => e.dossier);
  const noeud = (chemin, nom, profondeur) => {
    const enfants = dossiers.filter((e) => parent(e.chemin) === chemin && e.chemin !== "");
    const ouvert = ouverts.has(chemin) || chemin === "" || dossier === chemin || dossier.startsWith(`${chemin}/`);
    const bascule = enfants.length ? el("button", {
      class: "fx-pli", type: "button", "aria-label": ouvert ? `Replier ${nom}` : `Déplier ${nom}`, "aria-expanded": String(ouvert),
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (ouvert) ouverts.delete(chemin); else ouverts.add(chemin);
        surChoix.redessiner();
      },
    }, ouvert ? "▾" : "▸") : el("span", { class: "fx-pli" });
    const contenu = [bascule, icone("dossier"), el("span", { class: "fx-nom-arbre" }, nom)];
    const ligne = surChoix.lien
      ? el("a", { class: `fx-noeud${dossier === chemin ? " actif" : ""}`, href: chemin ? adresse("d", chemin) : "#fichiers" }, contenu)
      : el("button", { type: "button", class: `fx-noeud${dossier === chemin ? " actif" : ""}`, onclick: () => surChoix.choisir(chemin) }, contenu);
    ligne.dataset.profondeur = profondeur;
    ligne.style.paddingLeft = `${4 + profondeur * 14}px`;
    if (depot) depot(ligne, chemin);
    return [ligne, ...(ouvert ? enfants.flatMap((e) => noeud(e.chemin, nomDe(e.chemin), profondeur + 1)) : [])];
  };
  return noeud("", "Tous les fichiers", 0);
}

async function navigation(arbre, actif, options) {
  const dossier = ["recents", "favoris", "corbeille"].includes(actif) ? "\0" : actif;
  const entree = (id, texte) => el("a", { class: `fx-noeud fx-vue${actif === id ? " actif" : ""}`, href: `#fichiers/${id}` }, el("span", { class: "fx-pli" }), icone(id), el("span", { class: "fx-nom-arbre" }, texte));
  const { libre } = await api("/api/espace/stockage");
  const utilise = arbre.reduce((t, e) => t + e.taille, 0);
  const jauge = el("div", { class: "fx-jauge" }, el("span", {}));
  jauge.firstChild.style.width = `${Math.max(1, Math.round((utilise / Math.max(1, utilise + libre)) * 100))}%`;
  return [
    ...panneauDossiers(arbre, dossier, options),
    entree("recents", "Récents"), entree("favoris", "Favoris"), entree("corbeille", "Corbeille"),
    el("div", { class: "fx-stockage petit doux" }, jauge, `${taille(utilise)} utilisés · ${taille(libre)} libres`),
  ];
}

function envoyerUn(fichier, dossier, surProgres) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", `/api/espace/envoyer?nom=${q(fichier.name)}&dossier=${q(dossier)}`);
    x.upload.onprogress = (e) => { if (e.lengthComputable) surProgres(Math.round((e.loaded / e.total) * 100)); };
    x.onload = () => {
      if (x.status < 300) return resolve();
      let detail = `erreur ${x.status}`;
      try { detail = JSON.parse(x.responseText).detail || detail; } catch { /* réponse sans JSON */ }
      return reject(new Error(`${fichier.name} : ${detail}`));
    };
    x.onerror = () => reject(new Error(`${fichier.name} : connexion perdue`));
    x.send(fichier);
  });
}

async function vueExplorateur(cible, dossier, mode = "dossier") {
  // Un menu resté ouvert agirait sur la vue précédente.
  document.querySelector(".fx-menu")?.remove();
  let [arbre, favoris] = await Promise.all([api("/api/espace/arbre"), api("/api/espace/favoris")]);
  favoris = new Set(favoris);
  let enDetails = null;
  if (dossier && !arbre.some((e) => e.dossier && e.chemin === dossier)) {
    cible.append(el("div", { class: "page" }, el("p", { class: "erreur" }, "Ce dossier n'existe plus."), el("a", { href: "#fichiers" }, "Retour aux fichiers")));
    return;
  }
  const selection = new Set();
  let ancre = null;
  // Au toucher, seules les cases font entrer en mode sélection : le menu « ⋯ » ne doit pas empêcher d'ouvrir ensuite.
  let parCases = false;
  let recherche = "";
  let modeRecherche = MODES_RECHERCHE[localStorage.getItem(PREF_RECHERCHE)] ? localStorage.getItem(PREF_RECHERCHE) : "noms";
  let numeroRecherche = 0;
  let enVignettes = localStorage.getItem(PREF_VUE) === "vignettes";
  let lignes = new Map();
  let visibles = [];

  const racine = el("div", { class: "page fichiers fx", tabindex: "-1" });
  const panneau = el("nav", { class: "fx-arbre", "aria-label": "Dossiers" });
  const panneauDetails = el("aside", { class: "fx-details", hidden: true });
  const panneauSelection = el("aside", { class: "fx-details fx-selection", hidden: true, "aria-label": "Sélection" });
  const corps = el("div", { class: "fx-corps" });
  const fil = el("div", { class: "fx-fil" });
  const actions = el("div", { class: "fx-actions", role: "toolbar", "aria-label": "Actions sur la sélection" });
  const zone = el("div", { class: "fx-zone" });
  const statut = el("div", { class: "fx-statut petit doux", role: "status" });
  const compte = el("span", {});
  const progres = el("span", { class: "ambre" });
  statut.append(compte, progres);

  const element = (c) => arbre.find((e) => e.chemin === c);
  // Un dossier pèse ce qu'il contient : même total dans la barre d'état et dans le panneau Sélection.
  const poidsDe = (liste) => liste.reduce((t, e) => t + (e.dossier ? arbre.filter((x) => !x.dossier && x.chemin.startsWith(`${e.chemin}/`)).reduce((u, x) => u + x.taille, 0) : e.taille), 0);
  const choisis = () => [...selection].map(element).filter(Boolean);
  const signaler = (m) => { progres.textContent = m; };
  const fermerMenu = () => document.querySelector(".fx-menu")?.remove();

  async function rafraichir() {
    arbre = await api("/api/espace/arbre");
    favoris = new Set(await api("/api/espace/favoris"));
    for (const c of [...selection]) if (!element(c)) selection.delete(c);
    if (enDetails && !element(enDetails)) enDetails = null;
    await dessiner();
  }
  const tenter = async (faire) => {
    try {
      signaler("");
      await faire();
      await rafraichir();
    } catch (err) {
      signaler(err.message);
      await rafraichir().catch(() => {});
    }
  };

  function ouvrir(e) {
    if (e.dossier) location.hash = adresse("d", e.chemin);
    else if (genre(e) === "image") visionner(e);
    else if (genre(e) === "pdf") location.hash = adresse("p", e.chemin);
    else if (BUREAU.has(extension(e.chemin))) { if (moduleActif("collabora")) location.hash = adresse("o", e.chemin); else telecharger(e); }
    else if (/\.(drawio|dio)$/i.test(e.chemin)) { if (moduleActif("drawio")) location.hash = adresse("g", e.chemin); else telecharger(e); }
    else if (["note", "code", "fichier"].includes(genre(e)) || extension(e.chemin) === "csv") location.hash = adresse("f", e.chemin);
    else telecharger(e);
  }
  function telecharger(e) {
    const a = el("a", { href: `/api/espace/telecharger/${q(nomDe(e.chemin))}?chemin=${q(e.chemin)}`, download: nomDe(e.chemin), hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
  }
  // Visionneuse : les images de la vue en cours, une à une ou en diaporama. Zoom et rotation ne touchent pas au fichier.
  function visionner(depart) {
    const images = visibles.filter((x) => genre(x) === "image");
    if (!images.some((x) => x.chemin === depart.chemin)) images.splice(0, images.length, depart);
    let i = images.findIndex((x) => x.chemin === depart.chemin);
    let zoom = 1, angle = 0, dx = 0, dy = 0, minuterie = null, glisse = null;
    const source = (x) => `/api/espace/apercu?chemin=${q(x.chemin)}`;
    const image = el("img", { class: "fx-image-vue", alt: "", draggable: "false" });
    const scene = el("div", { class: "fx-scene" }, image);
    const titre = el("span", { class: "fx-vis-titre" });
    const compteur = el("span", { class: "fx-vis-compteur petit" });
    const galerie = el("div", { class: "fx-galerie", hidden: images.length < 2 }, images.map((x, n) => el("button", {
      class: "fx-miniature", "aria-label": `Voir ${nomDe(x.chemin)}`, onclick: () => montrer(n),
    }, el("img", { src: source(x), alt: "", loading: "lazy", draggable: "false" }))));
    const outil = (texte, etiquette, faire, classe = "") => el("button", { class: `fx-vis-outil ${classe}`, title: etiquette, "aria-label": etiquette, onclick: faire }, texte);
    const lecture = outil("▶", "Diaporama", () => diaporama(!minuterie));
    function appliquer() {
      image.style.transform = `translate(${dx}px, ${dy}px) scale(${zoom}) rotate(${angle}deg)`;
      scene.classList.toggle("zoome", zoom > 1);
    }
    function montrer(n) {
      i = (n + images.length) % images.length;
      zoom = 1; angle = 0; dx = 0; dy = 0;
      image.src = source(images[i]);
      image.alt = nomDe(images[i].chemin);
      titre.textContent = nomDe(images[i].chemin);
      compteur.textContent = `${i + 1} / ${images.length}`;
      galerie.querySelectorAll(".fx-miniature").forEach((b, k) => b.classList.toggle("actif", k === i));
      galerie.children[i]?.scrollIntoView({ block: "nearest", inline: "center" });
      appliquer();
    }
    function zoomer(facteur) {
      zoom = Math.min(8, Math.max(1, zoom * facteur));
      if (zoom === 1) { dx = 0; dy = 0; }
      appliquer();
    }
    function tourner(pas) { angle += pas; appliquer(); }
    function diaporama(marche) {
      clearInterval(minuterie);
      minuterie = marche && images.length > 1 ? setInterval(() => montrer(i + 1), 4000) : null;
      lecture.textContent = minuterie ? "❚❚" : "▶";
      lecture.setAttribute("aria-label", minuterie ? "Arrêter le diaporama" : "Diaporama");
    }
    const d = el("dialog", {
      class: "fx-visionneuse",
      onclose: () => { diaporama(false); if (document.fullscreenElement) document.exitFullscreen(); d.remove(); },
      onkeydown: (ev) => {
        if (ev.target.matches("input, textarea")) return;
        const actions = { ArrowLeft: () => montrer(i - 1), ArrowRight: () => montrer(i + 1), "+": () => zoomer(1.25), "=": () => zoomer(1.25), "-": () => zoomer(0.8), r: () => tourner(90), R: () => tourner(-90), " ": () => diaporama(!minuterie), "0": () => zoomer(0) };
        if (actions[ev.key]) { ev.preventDefault(); actions[ev.key](); }
      },
    },
    el("div", { class: "fx-vis-tete" }, titre, compteur,
      el("span", { class: "fx-vis-espace" }),
      outil("Télécharger", "Télécharger", () => telecharger(images[i]), "texte"),
      outil("Fermer", "Fermer", () => d.close(), "texte")),
    scene,
    el("div", { class: "fx-vis-barre", role: "toolbar", "aria-label": "Visionneuse" },
      images.length > 1 ? outil("‹", "Image précédente", () => montrer(i - 1)) : null,
      images.length > 1 ? outil("›", "Image suivante", () => montrer(i + 1)) : null,
      outil("−", "Dézoomer", () => zoomer(0.8)), outil("+", "Zoomer", () => zoomer(1.25)), outil("Ajuster", "Taille ajustée", () => zoomer(0), "texte"),
      outil("↺", "Tourner à gauche", () => tourner(-90)), outil("↻", "Tourner à droite", () => tourner(90)),
      images.length > 1 ? outil("▦", "Galerie", () => { galerie.hidden = !galerie.hidden; }) : null,
      images.length > 1 ? lecture : null,
      document.fullscreenEnabled ? outil("⛶", "Plein écran", () => (document.fullscreenElement ? document.exitFullscreen() : d.requestFullscreen())) : null),
    galerie);
    // Molette : zoom. Glisser : déplacer l'image zoomée, ou changer d'image au doigt quand elle est ajustée.
    scene.addEventListener("wheel", (ev) => { ev.preventDefault(); zoomer(ev.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
    scene.addEventListener("dblclick", () => zoomer(zoom > 1 ? 0 : 2));
    scene.addEventListener("pointerdown", (ev) => { glisse = { x: ev.clientX, y: ev.clientY, dx, dy }; scene.setPointerCapture(ev.pointerId); });
    scene.addEventListener("pointermove", (ev) => {
      if (!glisse || zoom === 1) return;
      dx = glisse.dx + ev.clientX - glisse.x;
      dy = glisse.dy + ev.clientY - glisse.y;
      appliquer();
    });
    scene.addEventListener("pointerup", (ev) => {
      if (glisse && zoom === 1 && Math.abs(ev.clientX - glisse.x) > 60 && images.length > 1) montrer(i + (ev.clientX < glisse.x ? 1 : -1));
      glisse = null;
    });
    document.body.append(d);
    d.showModal();
    montrer(i);
  }
  function jeter(elements) {
    if (!elements.length) return;
    const titre = elements.length === 1 ? `Mettre « ${nomDe(elements[0].chemin)} » à la corbeille ?` : `Mettre ${elements.length} éléments à la corbeille ?`;
    confirmer(titre, "Tu pourras les restaurer depuis la corbeille.", "Mettre à la corbeille", async () => {
      for (const e of elements) await api(`/api/espace/element?chemin=${q(e.chemin)}`, { methode: "DELETE" });
      selection.clear();
      await rafraichir();
    });
  }
  const deplacerVers = (chemins, cibleDossier) => tenter(async () => {
    const operations = chemins.filter((c) => parent(c) !== cibleDossier)
      .map((c) => ({ action: "deplacer", de: c, vers: joindre(cibleDossier, nomDe(c)) }));
    if (!operations.length) return;
    await api("/api/espace/appliquer", { methode: "POST", corps: { operations } });
    selection.clear();
  });
  const copierVers = (chemins, cibleDossier) => tenter(async () => {
    for (const de of chemins) await api("/api/espace/copier", { methode: "POST", corps: { de, dossier: cibleDossier } });
  });
  function choisirDestination(titre, libelle, chemins, faire) {
    let choix = dossier;
    const liste = el("div", { class: "fx-choix-dossiers" });
    const dessinerChoix = () => liste.replaceChildren(...panneauDossiers(arbre, choix, { surChoix: { choisir: (c) => { choix = c; dessinerChoix(); }, redessiner: dessinerChoix } }));
    dessinerChoix();
    const d = dialogue(titre, liste, el("div", { class: "boutons" },
      el("button", { class: "plein", onclick: () => { d.close(); faire(chemins, choix); } }, libelle),
      el("button", { onclick: () => d.close() }, "Annuler")));
  }
  const basculerFavori = (e) => tenter(() => api("/api/espace/favoris", { methode: "PUT", corps: { chemin: e.chemin, favori: !favoris.has(e.chemin) } }));
  // Colonne de droite : les détails demandés, sinon la sélection dès deux éléments (sur PC, le téléphone a sa barre).
  function colonneDroite() {
    const selectionVisible = !enDetails && selection.size > 1 && !tactile();
    corps.classList.toggle("avec-details", Boolean(enDetails) || selectionVisible);
    panneauDetails.hidden = !enDetails;
    panneauSelection.hidden = !selectionVisible;
    return selectionVisible;
  }
  function dessinerSelection() {
    if (!colonneDroite()) return;
    const liste = choisis();
    const dossiers = liste.filter((e) => e.dossier);
    const poids = poidsDe(liste);
    const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`;
    panneauSelection.replaceChildren(
      el("div", { class: "fx-details-tete" },
        el("h2", {}, "Sélection"),
        el("button", { class: "fx-outil", "aria-label": "Tout désélectionner", onclick: () => { selection.clear(); marquer(); } }, "×")),
      el("p", { class: "fx-resume petit" }, [pluriel(dossiers.length, "dossier"), pluriel(liste.length - dossiers.length, "fichier"), taille(poids)].join(" · ")),
      el("div", { class: "boutons" },
        el("button", { class: "plein", onclick: () => compresser(liste.map((e) => e.chemin)) }, "Compresser en zip")),
      el("ul", { class: "fx-choisis" }, liste.map((e) => el("li", {},
        icone(genre(e)), el("span", { class: "fx-nom-arbre", title: e.chemin }, nomDe(e.chemin)),
        el("button", { class: "fx-outil", "aria-label": `Retirer ${nomDe(e.chemin)} de la sélection`, onclick: () => { selection.delete(e.chemin); marquer(); } }, "×")))));
  }
  function compresser(chemins) {
    const seul = chemins.length === 1 ? nomDe(chemins[0]).replace(/\.[^.]+$/, "") : null;
    const nom = el("input", { value: seul || (dossier ? nomDe(dossier) : "archive"), "aria-label": "Nom de l'archive", autocomplete: "off" });
    const serre = el("input", { type: "checkbox", checked: true });
    const erreur = el("p", { class: "erreur" });
    const creer = el("button", { class: "plein" }, "Créer");
    const destination = mode === "dossier" ? dossier : "";
    const d = dialogue("Compresser et enregistrer", el("form", {
      class: "pile",
      onsubmit: async (ev) => {
        ev.preventDefault();
        if (!nom.value.trim()) return;
        creer.disabled = true;
        creer.textContent = "Compression…";
        try {
          const r = await api("/api/espace/archiver", { methode: "POST", corps: { chemins, nom: nom.value.trim(), dossier: destination, compresser: serre.checked } });
          d.close();
          selection.clear();
          await rafraichir();
          if (element(r.chemin)) { selection.add(r.chemin); marquer(); }
          signaler(`Archive créée : ${nomDe(r.chemin)} (${taille(r.taille)})`);
        } catch (err) {
          erreur.textContent = err.message;
          creer.disabled = false;
          creer.textContent = "Créer";
        }
      },
    },
    el("p", { class: "doux petit" }, `${chemins.length} élément${chemins.length > 1 ? "s" : ""}, archive rangée dans « ${destination || "Tous les fichiers"} ».`),
    el("div", { class: "fx-champ-nom" }, icone("archive"), nom, el("span", { class: "fx-ext" }, ".zip")),
    el("label", { class: "fx-ouvrir-apres petit" }, serre, "Compresser (plus lent, archive plus petite)"),
    erreur,
    el("div", { class: "boutons" }, creer, el("button", { type: "button", onclick: () => d.close() }, "Annuler"))));
    d.classList.add("fx-nouveau");
    nom.focus();
    nom.select();
  }
  function dessinerDetails() {
    if (colonneDroite()) dessinerSelection();
    const e = enDetails && element(enDetails);
    if (!e) return;
    const type = genre(e);
    const dedans = e.dossier ? arbre.filter((x) => x.chemin.startsWith(`${e.chemin}/`)) : [];
    const poids = e.dossier ? dedans.reduce((t, x) => t + x.taille, 0) : e.taille;
    const info = (a, b) => el("div", { class: "fx-info" }, el("span", { class: "doux" }, a), el("span", {}, b));
    panneauDetails.replaceChildren(
      el("div", { class: "fx-details-tete" },
        el("h2", {}, nomDe(e.chemin)),
        el("button", { class: "fx-outil", "aria-label": "Fermer", onclick: () => { enDetails = null; dessinerDetails(); } }, "×")),
      type === "image"
        ? el("img", { class: "fx-details-image", src: `/api/espace/apercu?chemin=${q(e.chemin)}`, alt: "" })
        : el("div", { class: "fx-details-icone" }, icone(type)),
      info("Type", LIBELLES[type]), info("Emplacement", parent(e.chemin) || "Tous les fichiers"), info("Taille", taille(poids)),
      e.dossier ? info("Contenu", `${dedans.length} élément${dedans.length > 1 ? "s" : ""}`) : null,
      info("Modifié", dateLongue(e.modifie)),
      el("div", { class: "boutons" },
        el("button", { class: "plein", onclick: () => ouvrir(e) }, "Ouvrir"),
        e.dossier ? null : el("button", { onclick: () => telecharger(e) }, "Télécharger"),
        el("button", { onclick: () => basculerFavori(e) }, favoris.has(e.chemin) ? "Retirer des favoris" : "Ajouter aux favoris")));
  }
  const details = (e) => { enDetails = e.chemin; dessinerDetails(); };
  // Touche Retour (appli Android) : fermer les détails, le menu des dossiers, puis la sélection, avant de quitter.
  surRetour(zone, () => {
    if (enDetails) { enDetails = null; dessinerDetails(); return true; }
    if (panneau.classList.contains("ouvert")) { panneau.classList.remove("ouvert"); return true; }
    if (selection.size) { selection.clear(); marquer(); return true; }
    return false;
  });
  function renommer(e) {
    const ligne = lignes.get(e.chemin);
    const nom = ligne?.querySelector(".fx-nom");
    if (!nom) return;
    ligne.draggable = false;
    const champ = el("input", { class: "fx-renommer", value: nomDe(e.chemin), "aria-label": "Nouveau nom" });
    let fini = false;
    const valider = async (garder) => {
      if (fini) return;
      fini = true;
      const nouveau = champ.value.trim();
      if (!garder || !nouveau || nouveau === nomDe(e.chemin)) return dessiner();
      return tenter(async () => {
        const vers = joindre(parent(e.chemin), nouveau);
        await api("/api/espace/deplacer", { methode: "POST", corps: { de: e.chemin, vers } });
        selection.clear();
        selection.add(vers);
      });
    };
    for (const type of ["click", "dblclick", "mousedown"]) champ.addEventListener(type, (ev) => ev.stopPropagation());
    champ.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") valider(true);
      else if (ev.key === "Escape") valider(false);
    });
    champ.addEventListener("blur", () => valider(true));
    nom.replaceChildren(champ);
    champ.focus();
    const fin = e.dossier ? champ.value.length : champ.value.lastIndexOf(".");
    champ.setSelectionRange(0, fin > 0 ? fin : champ.value.length);
  }
  async function nouveauDossier() {
    const pris = new Set(arbre.filter((e) => parent(e.chemin) === dossier).map((e) => nomDe(e.chemin)));
    let nom = "Nouveau dossier";
    for (let i = 2; pris.has(nom); i += 1) nom = `Nouveau dossier ${i}`;
    await tenter(() => api("/api/espace/dossier", { methode: "POST", corps: { chemin: joindre(dossier, nom) } }));
    const cree = element(joindre(dossier, nom));
    if (cree) renommer(cree);
  }
  async function envoyerFichiers(fichiers, destination = dossier) {
    const tous = [...fichiers];
    try {
      for (const [i, f] of tous.entries()) {
        await envoyerUn(f, destination, (p) => signaler(`Envoi ${i + 1}/${tous.length} : ${f.name} (${p} %)`));
      }
      signaler("");
    } catch (err) {
      signaler(err.message);
    }
    await rafraichir();
  }
  const choixFichiers = el("input", {
    type: "file", multiple: true, hidden: true,
    onchange: (e) => { envoyerFichiers(e.target.files); e.target.value = ""; },
  });
  const ranger = () => {
    const d = dialogue("Demander à l'IA de ranger", panneauRangement(() => { d.close(); rafraichir(); }), el("div", { class: "boutons" }, el("button", { onclick: () => d.close() }, "Fermer")));
    d.classList.add("large");
  };
  const couper = () => { pressePapiers = { mode: "couper", chemins: [...selection] }; marquer(); };
  const copier = () => { pressePapiers = { mode: "copier", chemins: [...selection] }; marquer(); };
  function coller(destination = dossier) {
    if (!pressePapiers) return;
    const { mode, chemins } = pressePapiers;
    if (mode === "couper") {
      pressePapiers = null;
      deplacerVers(chemins, destination);
    } else copierVers(chemins, destination);
  }

  // --- Menus et sélection
  function menu(x, y, entrees) {
    fermerMenu();
    const m = el("div", { class: "fx-menu", role: "menu", onkeydown: (e) => {
      if (e.key === "Escape") { fermerMenu(); racine.focus(); }
      const items = [...m.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    } }, entrees.filter(Boolean).map(([texte, faire, classe]) => el("button", {
      role: "menuitem", class: classe || "", onclick: () => { fermerMenu(); faire(); },
    }, texte)));
    document.body.append(m);
    m.style.left = `${Math.max(8, Math.min(x, innerWidth - m.offsetWidth - 8))}px`;
    m.style.top = `${Math.max(8, Math.min(y, innerHeight - m.offsetHeight - 8))}px`;
    m.querySelector("button")?.focus();
    setTimeout(() => document.addEventListener("pointerdown", (e) => { if (!m.contains(e.target)) fermerMenu(); }, { once: true }));
  }
  // Vide : il s'ouvre aussitôt. Décrit (Office) : Hermes le prépare, avec ses confirmations habituelles.
  function fenetreNouveau() {
    // Documents Office seulement avec Collabora, diagrammes seulement avec draw.io.
    const types = TYPES_NOUVEAUX.filter((t) => (t.genre === "diagramme" ? moduleActif("drawio") : t.texte || moduleActif("collabora")));
    let choix = types.find((t) => t.ext === localStorage.getItem(PREF_NOUVEAU)) || types[0];
    const nom = el("input", { value: "Sans titre", "aria-label": "Nom du fichier", autocomplete: "off" });
    const marque = el("span", {});
    const ext = el("span", { class: "fx-ext" });
    const description = el("textarea", { rows: 3, "aria-label": "Description pour l'IA", placeholder: "Facultatif : décris le contenu, l'IA le prépare. Vide = fichier vierge." });
    const ouvrirApres = el("input", { type: "checkbox", checked: localStorage.getItem(PREF_OUVRIR) !== "non" });
    const erreur = el("p", { class: "erreur" });
    const tuiles = types.map((t) => el("button", {
      type: "button", class: "fx-type-choix", "aria-pressed": "false",
      onclick: () => { choix = t; montrer(); nom.focus(); nom.select(); },
    }, icone(t.genre), el("span", {}, t.titre), el("span", { class: "fx-ext" }, `.${t.ext}`)));
    function montrer() {
      tuiles.forEach((b, i) => b.setAttribute("aria-pressed", String(types[i] === choix)));
      marque.replaceChildren(icone(choix.genre));
      ext.textContent = `.${choix.ext}`;
      description.hidden = !choix.ia;
    }
    const puis = (faire) => () => { d.close(); faire(); };
    const d = dialogue("Nouveau",
      el("div", { class: "fx-nouveau-tete" },
        el("button", { type: "button", onclick: puis(nouveauDossier) }, icone("dossier"), "Nouveau dossier"),
        el("button", { type: "button", onclick: puis(() => choixFichiers.click()) }, "Envoyer des fichiers"),
        pressePapiers ? el("button", { type: "button", onclick: puis(() => coller()) }, `Coller (${pressePapiers.chemins.length})`) : null,
        el("button", { type: "button", onclick: puis(ranger) }, "Ranger avec l'IA")),
      el("h3", {}, "Document"),
      el("div", { class: "fx-types" }, tuiles),
      el("form", {
        class: "pile",
        onsubmit: async (e) => {
          e.preventDefault();
          const base = nom.value.trim().replace(new RegExp(`\\.${choix.ext}$`, "i"), "");
          if (!base) return;
          localStorage.setItem(PREF_NOUVEAU, choix.ext);
          localStorage.setItem(PREF_OUVRIR, ouvrirApres.checked ? "oui" : "non");
          let chemin = joindre(dossier, `${base}.${choix.ext}`);
          try {
            if (choix.ia && description.value.trim()) {
              sessionStorage.setItem("hermes-question", `Crée ce fichier (${choix.titre}) : ${description.value.trim()}\nUtilise l'outil de création adapté, puis range le résultat avec poste_espace_enregistrer à l'emplacement exact « ${chemin} ».`);
              d.close();
              location.hash = "hermes";
              return;
            }
            if (choix.texte) {
              // L'écriture remplacerait un fichier existant : on refuse plutôt que d'écraser.
              if (element(chemin)) throw new Error("Un fichier porte déjà ce nom ici.");
              await api("/api/espace/fichier", { methode: "PUT", corps: { chemin, contenu: choix.modele || "" } });
            } else chemin = (await api("/api/espace/nouveau", { methode: "POST", corps: { chemin } })).chemin;
            d.close();
            if (ouvrirApres.checked) location.hash = adresse(choix.vue || (choix.texte ? "f" : "o"), chemin);
            else await rafraichir();
          } catch (err) {
            erreur.textContent = err.message;
          }
        },
      },
      el("div", { class: "fx-champ-nom" }, marque, nom, ext), el("div", { class: "champ-micro" }, description, boutonMicro(description)),
      el("label", { class: "fx-ouvrir-apres petit" }, ouvrirApres, "Ouvrir après la création"),
      erreur,
      el("div", { class: "boutons" }, el("button", { class: "plein" }, "Créer"), el("button", { type: "button", onclick: () => d.close() }, "Annuler"))));
    d.classList.add("fx-nouveau");
    montrer();
    nom.focus();
    nom.select();
  }
  const entreesFond = () => [
    ["Nouveau fichier…", fenetreNouveau],
    ["Nouveau dossier", nouveauDossier], ["Envoyer des fichiers", () => choixFichiers.click()],
    pressePapiers ? [`Coller (${pressePapiers.chemins.length})`, () => coller()] : null,
    ["Ranger avec l'IA", ranger],
  ];
  function entreesPour(e) {
    const plusieurs = selection.size > 1;
    return [
      plusieurs ? null : ["Ouvrir", () => ouvrir(e)],
      plusieurs || e.dossier ? null : ["Télécharger", () => telecharger(e)],
      plusieurs ? null : [favoris.has(e.chemin) ? "Retirer des favoris" : "Ajouter aux favoris", () => basculerFavori(e)],
      plusieurs ? null : ["Détails", () => details(e)],
      plusieurs ? null : ["Renommer", () => renommer(e)],
      ["Couper", couper], ["Copier", copier],
      e.dossier && pressePapiers && !plusieurs ? [`Coller dans ce dossier (${pressePapiers.chemins.length})`, () => coller(e.chemin)] : null,
      ["Déplacer vers…", () => choisirDestination("Déplacer vers", "Déplacer ici", [...selection], deplacerVers)],
      ["Copier vers…", () => choisirDestination("Copier vers", "Copier ici", [...selection], copierVers)],
      ["Compresser en zip…", () => compresser([...selection])],
      ["Mettre à la corbeille", () => jeter(choisis()), "alerte"],
    ];
  }
  function marquer() {
    if (!selection.size) parCases = false;
    for (const [c, l] of lignes) {
      const pris = selection.has(c);
      l.classList.toggle("choisi", pris);
      l.setAttribute("aria-selected", String(pris));
      l.classList.toggle("coupe", pressePapiers?.mode === "couper" && pressePapiers.chemins.includes(c));
      const caseL = l.querySelector(".fx-case");
      if (caseL) caseL.checked = pris;
    }
    const liste = choisis();
    const seul = liste.length === 1 ? liste[0] : null;
    actions.replaceChildren(...(liste.length ? [
      el("span", { class: "petit fx-compte" }, `${liste.length} sélectionné${liste.length > 1 ? "s" : ""}`),
      seul ? el("button", { onclick: () => ouvrir(seul) }, "Ouvrir") : null,
      seul && !seul.dossier ? el("button", { onclick: () => telecharger(seul) }, "Télécharger") : null,
      seul ? el("button", { onclick: () => renommer(seul) }, "Renommer") : null,
      el("button", { onclick: () => choisirDestination("Déplacer vers", "Déplacer ici", [...selection], deplacerVers) }, "Déplacer"),
      el("button", { onclick: () => choisirDestination("Copier vers", "Copier ici", [...selection], copierVers) }, "Copier"),
      el("button", { onclick: () => compresser(liste.map((e) => e.chemin)) }, "Compresser"),
      el("button", { class: "alerte", onclick: () => jeter(liste) }, "Corbeille"),
      el("button", { onclick: () => { selection.clear(); marquer(); } }, "Désélectionner"),
    ].filter(Boolean) : []));
    actions.hidden = !liste.length || (tactile() && !parCases);
    const poids = (l) => taille(poidsDe(l));
    compte.textContent = liste.length
      ? `${liste.length} sur ${visibles.length} sélectionné${liste.length > 1 ? "s" : ""} · ${poids(liste)}`
      : `${visibles.length} élément${visibles.length > 1 ? "s" : ""} · ${poids(visibles)}`;
    dessinerSelection();
  }
  function cliquer(e, ev) {
    // Sur PC, selon la préférence : clic sur le nom (défaut), sur toute la ligne, ou double-clic seulement.
    // Au toucher, tout ouvre hors mode sélection.
    const ouverture = localStorage.getItem(PREF_OUVERTURE) || "nom";
    const surNom = ev.target.closest(".fx-nom-bloc, .fx-icone, .fx-vignette");
    const ouvre = tactile() || ouverture === "ligne" || (ouverture === "nom" && surNom);
    if (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !parCases && ouvre) return ouvrir(e);
    if (tactile() || parCases) {
      if (selection.has(e.chemin)) selection.delete(e.chemin); else selection.add(e.chemin);
    } else if (ev.shiftKey && ancre) {
      const a = visibles.findIndex((x) => x.chemin === ancre);
      const b = visibles.findIndex((x) => x.chemin === e.chemin);
      selection.clear();
      visibles.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((x) => selection.add(x.chemin));
    } else if (ev.ctrlKey || ev.metaKey) {
      if (selection.has(e.chemin)) selection.delete(e.chemin); else selection.add(e.chemin);
      ancre = e.chemin;
    } else {
      selection.clear();
      selection.add(e.chemin);
      ancre = e.chemin;
    }
    return marquer();
  }
  // Glisser : vers un dossier de la liste, de l'arbre ou du fil d'Ariane ; des fichiers de l'ordinateur aussi.
  const TYPE_GLISSE = "application/x-poste-chemins";
  function depot(noeud, destination) {
    noeud.addEventListener("dragover", (e) => {
      if (!e.dataTransfer.types.includes(TYPE_GLISSE) && !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      e.stopPropagation();
      noeud.classList.add("survol");
    });
    noeud.addEventListener("dragleave", () => noeud.classList.remove("survol"));
    noeud.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      noeud.classList.remove("survol");
      const chemins = e.dataTransfer.getData(TYPE_GLISSE);
      if (chemins) deplacerVers(JSON.parse(chemins), destination);
      else if (e.dataTransfer.files.length) envoyerFichiers(e.dataTransfer.files, destination);
    });
  }
  function ligneElement(e) {
    const type = genre(e);
    const apercu = enVignettes && type === "image"
      ? el("img", { class: "fx-vignette", src: `/api/espace/apercu?chemin=${q(e.chemin)}`, alt: "", loading: "lazy", draggable: "false" })
      : icone(type);
    const ligne = el("div", {
      class: "fx-el", role: "row", tabindex: "0", "aria-selected": "false", draggable: tactile() ? "false" : "true",
      "data-chemin": e.chemin,
      onclick: (ev) => cliquer(e, ev),
      ondblclick: (ev) => { if (!tactile() && !ev.target.closest("input, button")) ouvrir(e); },
      oncontextmenu: (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!selection.has(e.chemin)) {
          selection.clear();
          selection.add(e.chemin);
          ancre = e.chemin;
          marquer();
        }
        menu(ev.clientX, ev.clientY, entreesPour(e));
      },
      ondragstart: (ev) => {
        if (!selection.has(e.chemin)) {
          selection.clear();
          selection.add(e.chemin);
          marquer();
        }
        ev.dataTransfer.setData(TYPE_GLISSE, JSON.stringify([...selection]));
        ev.dataTransfer.effectAllowed = "move";
      },
    },
    el("span", { class: "fx-cellule-case", role: "gridcell" }, el("input", {
      type: "checkbox", class: "fx-case", "aria-label": `Sélectionner ${nomDe(e.chemin)}`, tabindex: "-1",
      onclick: (ev) => {
        ev.stopPropagation();
        if (ev.target.checked) selection.add(e.chemin); else selection.delete(e.chemin);
        ancre = e.chemin;
        parCases = true;
        marquer();
      },
    })),
    apercu,
    el("span", { class: "fx-nom-bloc", role: "gridcell" },
      el("span", { class: "fx-nom" }, ...nomDecoupe(e)),
      (recherche || mode !== "dossier") && parent(e.chemin) ? el("span", { class: "fx-lieu doux petit" }, parent(e.chemin)) : null,
      el("span", { class: "fx-sous doux petit" }, e.dossier ? depuis(e.modifie) : `${taille(e.taille)} · ${depuis(e.modifie)}`)),
    el("span", { class: "fx-date doux petit", role: "gridcell" }, el("span", { class: "fx-quand", title: dateLongue(e.modifie) }, depuis(e.modifie))),
    el("span", { class: "fx-type doux petit", role: "gridcell" }, LIBELLES[type]),
    el("span", { class: "fx-poids doux petit", role: "gridcell" }, e.dossier ? "" : taille(e.taille)),
    el("button", {
      class: `fx-etoile${favoris.has(e.chemin) ? " actif" : ""}`,
      "aria-label": favoris.has(e.chemin) ? `Retirer ${nomDe(e.chemin)} des favoris` : `Ajouter ${nomDe(e.chemin)} aux favoris`,
      "aria-pressed": String(favoris.has(e.chemin)),
      onclick: (ev) => { ev.stopPropagation(); basculerFavori(e); },
    }, favoris.has(e.chemin) ? "★" : "☆"),
    el("button", {
      class: "fx-plus", "aria-label": `Actions pour ${nomDe(e.chemin)}`,
      onclick: (ev) => {
        ev.stopPropagation();
        if (!selection.has(e.chemin)) {
          selection.clear();
          selection.add(e.chemin);
          marquer();
        }
        const r = ev.currentTarget.getBoundingClientRect();
        menu(r.left, r.bottom, entreesPour(e));
      },
    }, "⋯"));
    if (e.dossier) depot(ligne, e.chemin);
    return ligne;
  }
  function entete() {
    const col = (cle, texte) => el("button", {
      class: `fx-col fx-col-${cle}`, "aria-sort": tri.cle === cle ? (tri.sens > 0 ? "ascending" : "descending") : "none",
      onclick: () => {
        tri = { cle, sens: tri.cle === cle ? -tri.sens : 1 };
        dessinerZone();
      },
    }, texte, tri.cle === cle ? (tri.sens > 0 ? " ↑" : " ↓") : "");
    return el("div", { class: "fx-entete", role: "row" }, el("span", { class: "fx-cellule-case" }, el("input", {
      type: "checkbox", class: "fx-tout", "aria-label": "Tout sélectionner", checked: visibles.length > 0 && selection.size === visibles.length,
      onclick: (ev) => {
        selection.clear();
        if (ev.target.checked) visibles.forEach((x) => selection.add(x.chemin));
        marquer();
      },
    })), el("span", { class: "fx-icone" }), col("nom", "Nom"), col("modifie", "Modifié"), col("type", "Type"), col("taille", "Taille"), el("span", {}), el("span", {}));
  }
  function nomDecoupe(e) {
    const point = nomDe(e.chemin).lastIndexOf(".");
    if (e.dossier || point <= 0) return [nomDe(e.chemin)];
    return [nomDe(e.chemin).slice(0, point), el("span", { class: "doux" }, nomDe(e.chemin).slice(point))];
  }
  function trier(liste) {
    if (mode === "recents" && !recherche) return [...liste].sort((a, b) => b.modifie - a.modifie);
    const valeur = {
      nom: (a, b) => nomDe(a.chemin).localeCompare(nomDe(b.chemin), "fr", { numeric: true, sensitivity: "base" }),
      modifie: (a, b) => a.modifie - b.modifie,
      taille: (a, b) => a.taille - b.taille,
      type: (a, b) => LIBELLES[genre(a)].localeCompare(LIBELLES[genre(b)], "fr"),
    }[tri.cle];
    return [...liste].sort((a, b) => Number(b.dossier) - Number(a.dossier) || valeur(a, b) * tri.sens);
  }
  function dessinerZone() {
    if (recherche && modeRecherche === "contenu") return dessinerContenu();
    const mot = recherche.toLocaleLowerCase("fr");
    const parNom = (e) => nomDe(e.chemin).toLocaleLowerCase("fr").includes(mot);
    const dansLaVue = mode === "recents" ? (e) => !e.dossier
      : mode === "favoris" ? (e) => favoris.has(e.chemin)
        : (e) => parent(e.chemin) === dossier;
    const garde = !mot ? dansLaVue : modeRecherche === "vue" ? (e) => dansLaVue(e) && parNom(e) : parNom;
    visibles = trier(arbre.filter(garde)).slice(0, mode === "recents" && modeRecherche !== "noms" ? 50 : undefined);
    lignes = new Map(visibles.map((e) => [e.chemin, ligneElement(e)]));
    const contenu = el("div", { class: enVignettes ? "fx-vignettes" : "fx-liste", role: "grid", "aria-label": "Contenu du dossier", "aria-multiselectable": "true" }, [...lignes.values()]);
    zone.replaceChildren(enVignettes ? el("div", {}) : entete(), visibles.length ? contenu
      : vide(recherche ? (modeRecherche === "vue" ? "Aucun nom ne correspond dans cette vue." : "Aucun nom de fichier ne correspond.")
        : mode === "favoris" ? "Aucun favori : touche l'étoile d'un fichier pour l'ajouter."
          : mode === "recents" ? "Aucun fichier récent."
            : "Ce dossier est vide. Glisses-y des fichiers ou crée une note."));
    marquer();
  }
  // Contenu : résultats de l'index, avec l'extrait. Une frappe rapide n'envoie que la dernière demande.
  function dessinerContenu() {
    const numero = ++numeroRecherche;
    const texte = recherche;
    selection.clear();
    visibles = [];
    lignes = new Map();
    marquer();
    if (texte.length < 2) {
      zone.replaceChildren(vide("Encore une lettre…"));
      return;
    }
    if (!zone.querySelector(".fx-resultats")) zone.replaceChildren(vide("Recherche…"));
    setTimeout(async () => {
      if (numero !== numeroRecherche) return;
      let trouves;
      try {
        trouves = await api(`/api/espace/recherche?texte=${q(texte)}`);
      } catch (err) {
        if (numero === numeroRecherche) zone.replaceChildren(el("p", { class: "erreur" }, err.message));
        return;
      }
      if (numero !== numeroRecherche) return;
      const resultats = trouves.map((r) => [element(r.chemin), r.extrait]).filter(([e]) => e);
      zone.replaceChildren(resultats.length
        ? el("div", { class: "fx-resultats", role: "list" }, resultats.map(([e, extrait]) => el("button", {
          class: "fx-resultat", role: "listitem", "data-chemin": e.chemin, onclick: () => ouvrir(e),
        },
        el("span", { class: "fx-resultat-tete" }, icone(genre(e)), el("span", { class: "fx-nom" }, nomDe(e.chemin)),
          el("span", { class: "doux petit" }, parent(e.chemin) || "Tous les fichiers")),
        el("span", { class: "fx-extrait petit" }, surligner(extrait)))))
        : vide("Aucun fichier ne contient ce texte. Les documents Office et PDF sont lus en arrière-plan : un fichier tout juste ajouté peut mettre deux minutes à apparaître."));
      compte.textContent = `${resultats.length} fichier${resultats.length > 1 ? "s" : ""} contenant « ${texte} »`;
    }, 250);
  }
  async function dessiner() {
    panneau.replaceChildren(...await navigation(arbre, mode === "dossier" ? dossier : mode, { depot, surChoix: { lien: true, redessiner: dessiner } }));
    const racineFil = el("a", { href: mode === "dossier" ? "#fichiers" : `#fichiers/${mode}` }, { recents: "Récents", favoris: "Favoris" }[mode] || "Tous les fichiers");
    depot(racineFil, "");
    const morceaux = [racineFil];
    dossier.split("/").filter(Boolean).forEach((p, i, tout) => {
      const chemin = tout.slice(0, i + 1).join("/");
      const lien = el("a", { href: adresse("d", chemin) }, p);
      depot(lien, chemin);
      morceaux.push(el("span", { class: "doux" }, "›"), lien);
    });
    fil.replaceChildren(...morceaux);
    dessinerZone();
    dessinerDetails();
  }

  // --- Clavier : comme un explorateur, sans gêner la saisie dans un champ.
  racine.addEventListener("keydown", (e) => {
    if (e.target.matches("input:not([type=checkbox]), textarea")) return;
    const courant = e.target.closest?.(".fx-el")?.dataset.chemin;
    const ctrl = e.ctrlKey || e.metaKey;
    const touche = e.key.toLowerCase();
    const un = selection.size === 1 ? choisis()[0] : null;
    if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key) && visibles.length) {
      e.preventDefault();
      const i = visibles.findIndex((x) => x.chemin === (courant || ancre));
      const pas = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
      const suivant = visibles[Math.max(0, Math.min(visibles.length - 1, i < 0 ? 0 : i + pas))];
      if (!e.shiftKey) selection.clear();
      selection.add(suivant.chemin);
      ancre = suivant.chemin;
      marquer();
      lignes.get(suivant.chemin).focus();
    } else if (e.key === "Enter" && !e.target.matches("button, a")) {
      const cibleEntree = courant ? element(courant) : un;
      if (cibleEntree) ouvrir(cibleEntree);
    } else if (e.key === "F2" && un) {
      e.preventDefault();
      renommer(un);
    } else if (e.key === "Delete" && selection.size) {
      jeter(choisis());
    } else if (e.key === "Backspace" && dossier) {
      location.hash = parent(dossier) ? adresse("d", parent(dossier)) : "#fichiers";
    } else if (e.key === "Escape") {
      fermerMenu();
      selection.clear();
      marquer();
    } else if (ctrl && touche === "a") {
      e.preventDefault();
      visibles.forEach((x) => selection.add(x.chemin));
      marquer();
    } else if (ctrl && touche === "x" && selection.size) couper();
    else if (ctrl && touche === "c" && selection.size) copier();
    else if (ctrl && touche === "v") coller();
    else if (e.key === "/" && !ctrl) {
      e.preventDefault();
      champRecherche.focus();
      champRecherche.select();
    }
  });
  const bouton = (texte, etiquette, faire) => el("button", { class: "fx-outil", title: etiquette, "aria-label": etiquette, onclick: faire }, texte);
  const basculeVue = bouton("▦", "Changer d'affichage", () => {
    enVignettes = !enVignettes;
    localStorage.setItem(PREF_VUE, enVignettes ? "vignettes" : "liste");
    dessinerZone();
  });
  async function preferences() {
    const choix = (nom, valeurs, actuelle, surChoix) => el("select", { "aria-label": nom, onchange: (ev) => surChoix(ev.target.value) },
      Object.entries(valeurs).map(([v, texte]) => el("option", { value: v, selected: v === actuelle }, texte)));
    const ligne = (titre, aide, champ) => el("div", { class: "fx-pref" }, el("div", {}, el("strong", {}, titre), aide ? el("p", { class: "doux petit" }, aide) : null), champ);
    const index = el("span", { class: "doux" }, "…");
    const d = dialogue("Préférences des fichiers",
      el("h3", {}, "Interface"),
      tactile() ? null : ligne("Ouverture", "Clic sur le nom : ailleurs sur la ligne, un clic sélectionne. Au doigt, un appui ouvre toujours.", choix("Ouverture", OUVERTURES, localStorage.getItem(PREF_OUVERTURE) || "nom", (v) => localStorage.setItem(PREF_OUVERTURE, v))),
      ligne("Affichage", null, choix("Affichage", { liste: "Liste", vignettes: "Vignettes" }, enVignettes ? "vignettes" : "liste", (v) => {
        enVignettes = v === "vignettes";
        localStorage.setItem(PREF_VUE, v);
        dessinerZone();
      })),
      ligne("Recherche", "Raccourci : « / ». Ctrl+K cherche dans tout Poste.", choix("Recherche", Object.fromEntries(Object.entries(MODES_RECHERCHE).map(([c, m]) => [c, m.titre])), modeRecherche, changerMode)),
      ligne("Nouveau document", null, choix("Nouveau document", { oui: "Ouvrir après la création", non: "Rester dans le dossier" }, localStorage.getItem(PREF_OUVRIR) === "non" ? "non" : "oui", (v) => localStorage.setItem(PREF_OUVRIR, v))),
      el("h3", {}, "Recherche dans le contenu"),
      ligne("Index", "Textes et notes tout de suite ; Word, Excel, PowerPoint, LibreOffice et PDF en arrière-plan, toutes les deux minutes.", index),
      el("div", { class: "boutons" }, el("button", { class: "plein", onclick: () => d.close() }, "Fermer")));
    d.classList.add("fx-nouveau");
    try {
      const e = await api("/api/espace/recherche/etat");
      index.textContent = `${e.fichiers} fichier${e.fichiers > 1 ? "s" : ""} lu${e.fichiers > 1 ? "s" : ""}, ${e.avec_texte} avec du texte`;
    } catch (err) {
      index.textContent = err.message;
    }
  }
  const boutonPreferences = bouton("", "Préférences", preferences);
  boutonPreferences.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>';
  const champRecherche = el("input", {
    class: "fx-recherche", type: "search", "aria-label": "Rechercher",
    oninput: (e) => { recherche = e.target.value.trim(); selection.clear(); dessinerZone(); },
  });
  const choixMode = el("button", {
    class: "fx-mode-recherche", "aria-haspopup": "menu",
    onclick: (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      menu(r.left, r.bottom + 4, Object.entries(MODES_RECHERCHE).map(([cle, m]) => [
        `${cle === modeRecherche ? "✓ " : ""}${m.titre}`, () => changerMode(cle)]));
    },
  });
  function changerMode(cle) {
    modeRecherche = cle;
    localStorage.setItem(PREF_RECHERCHE, cle);
    choixMode.textContent = `${MODES_RECHERCHE[cle].court} ▾`;
    choixMode.setAttribute("aria-label", `Mode de recherche : ${MODES_RECHERCHE[cle].titre}`);
    champRecherche.placeholder = MODES_RECHERCHE[cle].indication;
    champRecherche.focus();
    if (recherche) dessinerZone();
  }
  changerMode(modeRecherche);
  const boutonNouveau = el("button", {
    class: "plein bouton-principal",
    onclick: (e) => {
      e.stopPropagation();
      fenetreNouveau();
    },
  }, "+ Nouveau");
  const boutonEnvoyer = el("button", { class: "fx-envoyer", onclick: () => choixFichiers.click() }, "Envoyer");
  const basculeArbre = el("button", { class: "fx-bascule-arbre", onclick: () => panneau.classList.toggle("ouvert") }, "Menu");

  zone.addEventListener("click", (e) => {
    if (e.target === zone || e.target.matches(".fx-liste, .fx-vignettes")) {
      selection.clear();
      marquer();
    }
  });
  zone.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    menu(e.clientX, e.clientY, entreesFond());
  });
  depot(zone, dossier);

  corps.append(panneau,
    el("div", { class: "fx-colonne" },
      el("div", { class: "fx-barre" },
        basculeArbre,
        dossier ? bouton("↑", "Dossier parent", () => { location.hash = parent(dossier) ? adresse("d", parent(dossier)) : "#fichiers"; }) : null,
        fil, boutonEnvoyer, boutonNouveau, choixFichiers),
      el("div", { class: "fx-outils" }, choixMode, champRecherche, basculeVue, boutonPreferences),
      // Place réservée : si les actions décalaient la liste, le second clic d'un double-clic tomberait sur une autre ligne.
      el("div", { class: "fx-place-actions" }, actions),
      zone, statut),
    panneauDetails, panneauSelection);
  racine.append(corps);
  await dessiner();
  cible.append(racine);
}

// draw.io tourne sur sa propre origine : il ne reçoit que le XML du diagramme, et Poste enregistre ce qu'il renvoie.
async function vueDiagramme(cible, chemin) {
  const etat = el("span", { class: "petit doux", role: "status" });
  const page = el("div", { class: "fx-vue-document" }, teteDocument(chemin, etat));
  cible.append(page);
  let fichier, url;
  try {
    [fichier, { url }] = await Promise.all([api(`/api/espace/fichier?chemin=${q(chemin)}`), api("/api/espace/drawio")]);
  } catch (err) {
    page.append(el("p", { class: "erreur" }, err.message));
    return;
  }
  const origine = new URL(url).origin;
  // Petit écran : l'interface « simple » de draw.io, qui tient sur un téléphone (formes derrière le bouton +).
  const petit = matchMedia("(max-width: 760px)").matches;
  // Petit écran : « Retour aux fichiers » de Poste suffit, le bouton Quitter de draw.io ne tiendrait pas.
  const parametres = new URLSearchParams({ embed: "1", proto: "json", spin: "1", lang: "fr", ui: petit ? "simple" : "dark", dark: "1", stealth: "1", libraries: "1", saveAndExit: "0", noExitBtn: petit ? "1" : "0" });
  const cadre = el("iframe", { class: "fx-cadre", title: `Diagramme ${nomDe(chemin)}`, src: `${url}/?${parametres}`, allow: "clipboard-read; clipboard-write; fullscreen" });
  page.append(cadre);
  let version = fichier.version;
  let file = Promise.resolve();
  const envoyer = (message) => cadre.contentWindow?.postMessage(JSON.stringify(message), origine);
  // Les enregistrements partent l'un après l'autre : chacun porte la version rendue par le précédent.
  const enregistrer = (xml, confirmer) => {
    file = file.then(async () => {
      if (xml === fichier.contenu) return;
      etat.textContent = "Enregistrement…";
      try {
        const r = await api("/api/espace/fichier", { methode: "PUT", corps: { chemin, contenu: xml, version } });
        version = r.version;
        fichier.contenu = xml;
        etat.textContent = "Enregistré";
        if (confirmer) envoyer({ action: "status", message: "Enregistré", modified: false });
      } catch (err) {
        etat.textContent = err.message;
        etat.classList.add("erreur");
      }
    });
    return file;
  };
  const recevoir = async (ev) => {
    if (!document.body.contains(cadre)) { removeEventListener("message", recevoir); return; }
    if (ev.origin !== origine || ev.source !== cadre.contentWindow || typeof ev.data !== "string") return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.event === "init") envoyer({ action: "load", xml: fichier.contenu, autosave: 1, title: nomDe(chemin) });
    else if (m.event === "autosave" && typeof m.xml === "string") enregistrer(m.xml, false);
    else if (m.event === "save" && typeof m.xml === "string") enregistrer(m.xml, true);
    else if (m.event === "exit") {
      await file;
      location.hash = parent(chemin) ? adresse("d", parent(chemin)) : "#fichiers";
    }
  };
  addEventListener("message", recevoir);
}
// Travailler à l'étroit, non : « Pleine page » donne tout l'onglet au document (sans le menu de Poste, retenu sur
// l'appareil), « Plein écran » tout l'écran. Échap ou la touche Retour de l'appli en sortent.
const SVG_DOC = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONE_PAGE = SVG_DOC('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 9h6v6H9z"/>');
const ICONE_PAGE_SORTIR = SVG_DOC('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 12h8"/>');
const ICONE_ECRAN = SVG_DOC('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>');
const ICONE_ECRAN_SORTIR = SVG_DOC('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>');
const PREF_PLEINE_PAGE = "poste-doc-pleine-page";

function teteDocument(chemin, ...autres) {
  const vue = () => tete.closest(".fx-vue-document");
  const bouton = (classe) => el("button", { type: "button", class: `fx-outil fx-taille ${classe}` });
  const page = bouton("fx-pleine-page");
  const ecran = bouton("fx-plein-ecran");
  const dessiner = () => {
    const pleine = Boolean(vue()?.classList.contains("pleine-page"));
    const plein = Boolean(document.fullscreenElement && document.fullscreenElement === vue());
    page.innerHTML = pleine ? ICONE_PAGE_SORTIR : ICONE_PAGE;
    page.title = pleine ? "Quitter la pleine page" : "Pleine page";
    page.setAttribute("aria-label", page.title);
    page.setAttribute("aria-pressed", String(pleine));
    ecran.innerHTML = plein ? ICONE_ECRAN_SORTIR : ICONE_ECRAN;
    ecran.title = plein ? "Quitter le plein écran" : "Plein écran";
    ecran.setAttribute("aria-label", ecran.title);
  };
  const poserPleinePage = (oui) => {
    vue()?.classList.toggle("pleine-page", oui);
    localStorage.setItem(PREF_PLEINE_PAGE, oui ? "1" : "");
    dessiner();
  };
  page.onclick = () => poserPleinePage(!vue()?.classList.contains("pleine-page"));
  ecran.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else vue()?.requestFullscreen?.().catch(() => {});
  };
  ecran.hidden = !document.fullscreenEnabled;
  const tete = el("div", { class: "fx-tete-doc" },
    el("a", { href: parent(chemin) ? adresse("d", parent(chemin)) : "#fichiers", class: "doux petit" }, "Retour aux fichiers"),
    el("strong", { class: "fx-nom-doc" }, nomDe(chemin)), ...autres,
    el("a", { class: "petit doux", href: `/api/espace/telecharger/${q(nomDe(chemin))}?chemin=${q(chemin)}`, download: nomDe(chemin) }, "Télécharger"),
    page, ecran);
  const suivreEcran = () => { if (!tete.isConnected) document.removeEventListener("fullscreenchange", suivreEcran); else dessiner(); };
  document.addEventListener("fullscreenchange", suivreEcran);
  // La vue entoure l'en-tête juste après : le choix retenu s'applique alors.
  queueMicrotask(() => { vue()?.classList.toggle("pleine-page", localStorage.getItem(PREF_PLEINE_PAGE) === "1"); dessiner(); });
  surRetour(tete, () => {
    if (!vue()?.classList.contains("pleine-page")) return false;
    poserPleinePage(false);
    return true;
  });
  return tete;
}

// Dans Word, l'assistant ne peut pas écrire lui-même : Poste exécute les commandes qu'il a fait approuver.
function relayerCommandes(cadre, origine) {
  const vue = crypto.randomUUID();
  const envoyer = (message) => cadre.contentWindow?.postMessage(JSON.stringify({ SendTime: Date.now(), ...message }), origine);
  let pret = false;
  const ecouter = (e) => {
    if (e.origin !== origine || e.source !== cadre.contentWindow) return;
    let m = null;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.MessageId === "App_LoadingStatus" && m.Values?.Status === "Document_Loaded") {
      envoyer({ MessageId: "Host_PostmessageReady" });
      pret = true;
    }
  };
  window.addEventListener("message", ecouter);
  const suivre = async () => {
    if (cadre.isConnected === false && cadre.dataset.vu) {
      window.removeEventListener("message", ecouter);
      return;
    }
    if (cadre.isConnected) cadre.dataset.vu = "1";
    if (pret && cadre.isConnected) {
      const commandes = await api(`/api/espace/bureau/commandes?vue=${vue}`).catch(() => []);
      for (const c of commandes) {
        for (const commande of c.commandes) envoyer({ MessageId: "Send_UNO_Command", Values: commande });
        await api(`/api/espace/bureau/commandes/${q(c.id)}/fait`, { methode: "POST" }).catch(() => {});
      }
      // Ces commandes ne déclenchent pas toujours l'enregistrement à la fermeture : on ne laisse rien en suspens.
      if (commandes.length) envoyer({ MessageId: "Action_Save", Values: { DontTerminateEdit: true, DontSaveIfUnmodified: true, Notify: false } });
    }
    setTimeout(suivre, 700);
  };
  suivre();
}

// Le jeton part en POST, jamais dans l'adresse : il ne doit pas finir dans un journal ou un historique.
async function vueBureau(cible, chemin) {
  const page = el("div", { class: "fx-vue-document" }, teteDocument(chemin));
  cible.append(page);
  try {
    const s = await api("/api/espace/bureau/session", { methode: "POST", corps: { chemin } });
    const cadre = el("iframe", { class: "fx-cadre", name: "fx-bureau", title: `Édition de ${nomDe(chemin)}`, allow: "clipboard-read; clipboard-write; fullscreen" });
    const formulaire = el("form", { action: s.url, method: "post", target: "fx-bureau", hidden: true },
      el("input", { type: "hidden", name: "access_token", value: s.jeton }),
      el("input", { type: "hidden", name: "access_token_ttl", value: String(s.expire_ms) }));
    page.append(cadre, formulaire);
    if (/\.(docx|doc|odt|rtf)$/i.test(chemin)) relayerCommandes(cadre, new URL(s.url).origin);
    // Le cadre doit être dans la page avant l'envoi : la vue n'y est insérée qu'au retour.
    queueMicrotask(() => {
      const attendre = () => { if (document.body.contains(formulaire)) formulaire.submit(); else requestAnimationFrame(attendre); };
      attendre();
    });
  } catch (err) {
    page.append(el("p", { class: "erreur" }, err.message));
  }
}

async function vuePdf(cible, chemin) {
  const zone = el("div", { class: "fx-pages" });
  const statut = el("span", { class: "doux petit", role: "status" }, "Chargement…");
  let echelle = 1;
  let pdf = null;
  const dessiner = async () => {
    const observateur = new IntersectionObserver((vues) => {
      for (const v of vues) {
        if (!v.isIntersecting || v.target.dataset.fait) continue;
        v.target.dataset.fait = "1";
        pdf.getPage(Number(v.target.dataset.page)).then((page) => {
          const largeur = zone.clientWidth - 2;
          const taille = page.getViewport({ scale: 1 });
          const vue = page.getViewport({ scale: (largeur / taille.width) * echelle * (devicePixelRatio || 1) });
          const canvas = v.target;
          canvas.width = vue.width;
          canvas.height = vue.height;
          page.render({ canvas, viewport: vue });
        });
      }
    }, { root: null, rootMargin: "600px" });
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const page = await pdf.getPage(n);
      const t = page.getViewport({ scale: 1 });
      const c = el("canvas", { class: "fx-page", "aria-label": `Page ${n}`, "data-page": String(n) });
      c.style.width = `${100 * echelle}%`;
      c.style.aspectRatio = `${t.width} / ${t.height}`;
      pages.push(c);
    }
    zone.replaceChildren(...pages);
    pages.forEach((c) => observateur.observe(c));
    statut.textContent = `${pdf.numPages} page${pdf.numPages > 1 ? "s" : ""}`;
  };
  const zoom = (f) => { echelle = Math.min(3, Math.max(0.5, echelle * f)); dessiner(); };
  cible.append(el("div", { class: "fx-vue-document" },
    teteDocument(chemin, statut,
      el("button", { class: "fx-outil", "aria-label": "Réduire", onclick: () => zoom(0.8) }, "−"),
      el("button", { class: "fx-outil", "aria-label": "Agrandir", onclick: () => zoom(1.25) }, "+")),
    zone));
  // Sans attendre : Poste n'insère la vue dans la page qu'une fois cette fonction terminée.
  (async () => {
    try {
      const { getDocument, GlobalWorkerOptions } = await import("../lib/pdf.js");
      GlobalWorkerOptions.workerSrc = "/lib/pdf.worker.js";
      const r = await fetch(`/api/espace/telecharger/${q(nomDe(chemin))}?chemin=${q(chemin)}`, { credentials: "same-origin" });
      if (!r.ok) throw new Error(`Lecture impossible (${r.status})`);
      pdf = await getDocument({ data: await r.arrayBuffer(), isEvalSupported: false }).promise;
      await new Promise((fin) => { const v = () => (document.body.contains(zone) ? fin() : requestAnimationFrame(v)); v(); });
      await dessiner();
    } catch (err) {
      statut.textContent = err.name === "PasswordException" ? "PDF protégé par un mot de passe : télécharge-le." : `Affichage impossible : ${err.message}`;
    }
  })();
}

async function vueCorbeille(cible) {
  const arbre = await api("/api/espace/arbre");
  const liste = el("div", {});
  const message = el("p", { class: "erreur", role: "status" });
  const panneau = el("nav", { class: "fx-arbre", "aria-label": "Dossiers" });
  panneau.append(...await navigation(arbre, "corbeille", { surChoix: { lien: true, redessiner: () => {} } }));
  async function charger() {
    const jetes = await api("/api/espace/corbeille");
    liste.replaceChildren(...(jetes.length ? jetes.map((j) => el("div", { class: "fx-jete" },
      icone(genre({ chemin: j.chemin, dossier: !/\.[^./]+$/.test(j.chemin) })),
      el("span", { class: "corps" }, nomDe(j.chemin), parent(j.chemin) ? el("span", { class: "doux petit fx-lieu" }, parent(j.chemin)) : null),
      el("span", { class: "doux petit" }, dateLongue(j.jete_le)),
      el("button", {
        onclick: async () => {
          try {
            await api(`/api/espace/corbeille/${j.id}/restaurer`, { methode: "POST" });
            await charger();
          } catch (err) {
            message.textContent = err.message;
          }
        },
      }, "Restaurer"))) : [vide("La corbeille est vide.")]));
  }
  await charger();
  cible.append(el("div", { class: "page fichiers fx" },
    el("div", { class: "fx-corps" }, panneau, el("div", { class: "fx-colonne" },
      el("div", { class: "fx-barre" },
        el("button", { class: "fx-bascule-arbre", onclick: () => panneau.classList.toggle("ouvert") }, "Menu"),
        el("div", { class: "fx-fil" }, el("span", {}, "Corbeille"))),
      message, el("div", { class: "fx-zone" }, liste)))));
}

export async function vueFichiers(cible) {
  const [, type, chemin = ""] = location.hash.slice(1).split("/");
  if (type === "corbeille") return vueCorbeille(cible);
  if (type === "recents" || type === "favoris") return vueExplorateur(cible, "", type);
  if (type === "o") return vueBureau(cible, decodeURIComponent(chemin));
  if (type === "p") return vuePdf(cible, decodeURIComponent(chemin));
  if (type === "g") return vueDiagramme(cible, decodeURIComponent(chemin));
  if (type !== "f") return vueExplorateur(cible, type === "d" ? decodeURIComponent(chemin) : "");
  const fichier = decodeURIComponent(chemin);
  try {
    return await vueEditeur(cible, fichier);
  } catch (err) {
    cible.append(el("div", { class: "page fichiers" },
      el("a", { href: parent(fichier) ? adresse("d", parent(fichier)) : "#fichiers", class: "doux petit" }, "Retour aux fichiers"),
      el("h1", { class: "nom-fichier" }, nomDe(fichier)),
      el("p", { class: "erreur" }, err.message),
      el("a", { class: "lien-action", href: `/api/espace/telecharger/${q(nomDe(fichier))}?chemin=${q(fichier)}`, download: nomDe(fichier) }, "Télécharger")));
    return undefined;
  }
}
