// Livrables de Hermes, comme dans Claude : une carte dans la conversation (nom, « Document · DOCX »), et un clic ouvre
// l'aperçu dans un panneau à droite (plein écran sur téléphone). Aperçu ou code, Copier, Télécharger, Agrandir, Fermer.
// Ne lit que des fichiers créés par Hermes (/api/fichiers/<id>/<nom>) : jamais une adresse extérieure.
import { el } from "./outils.js";
import { rendreMarkdown } from "./markdown.js";

export const LIVRABLE = /^\/api\/fichiers\/[0-9a-f]{32}\/[^\s/?#]+$/;
const TEXTE_MAX = 400_000;

const FAMILLES = [
  [/^(docx?|odt|rtf)$/, "bureau", "Document"],
  [/^(xlsx?|ods)$/, "bureau", "Tableur"],
  [/^(pptx?|odp)$/, "bureau", "Présentation"],
  [/^pdf$/, "pdf", "PDF"],
  [/^(png|jpe?g|gif|webp|avif)$/, "image", "Image"],
  [/^(md|markdown)$/, "markdown", "Document"],
  [/^html?$/, "html", "Page web"],
  [/^(csv|tsv)$/, "csv", "Tableau"],
  [/^(txt|log)$/, "texte", "Texte"],
  [/^(json|ya?ml|xml|toml|ini|conf|py|js|ts|sh|sql|css|java|c|cpp|h|go|rs|rb|php|svg|drawio|mmd)$/, "code", "Code"],
];

export function infosLivrable(nom) {
  const ext = (nom.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
  const [, genre, famille] = FAMILLES.find(([motif]) => motif.test(ext)) || [null, "autre", "Fichier"];
  return { ext, genre, famille, libelle: famille === "PDF" ? "Document · PDF" : `${famille}${ext ? ` · ${ext.toUpperCase()}` : ""}`,
    source: ["markdown", "html", "csv"].includes(genre), texte: ["markdown", "html", "csv", "texte", "code"].includes(genre) };
}
const nomDe = (adresse) => decodeURIComponent(adresse.split("/").pop());
const titreDe = (nom) => nom.replace(/\.[^.]+$/, "");

const SVG = (d, l = 18) => `<svg viewBox="0 0 24 24" width="${l}" height="${l}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONES = {
  document: SVG('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  tableur: SVG('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/>'),
  diapo: SVG('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M12 17v3M8 20h8"/>'),
  image: SVG('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 8"/>'),
  code: SVG('<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>'),
  oeil: SVG('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 17),
  telecharger: SVG('<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>', 17),
  agrandir: SVG('<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>', 16),
  reduire: SVG('<path d="M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7"/>', 16),
  fermer: SVG('<path d="M6 6l12 12M18 6L6 18"/>', 17),
};
const iconeDe = (i) => (i.famille === "Tableur" || i.genre === "csv" ? ICONES.tableur : i.famille === "Présentation" ? ICONES.diapo
  : i.genre === "image" ? ICONES.image : i.genre === "code" || i.genre === "html" ? ICONES.code : ICONES.document);

function outil(svg, etiquette, attributs = {}) {
  const b = el(attributs.href ? "a" : "button", { class: "apercu-outil", "aria-label": etiquette, title: etiquette, ...(attributs.href ? {} : { type: "button" }), ...attributs });
  b.innerHTML = svg;
  return b;
}

// Carte d'un livrable dans la réponse de Hermes.
export function carteLivrable(adresse) {
  const nom = nomDe(adresse);
  const i = infosLivrable(nom);
  const signe = el("span", { class: `livrable-signe ${i.genre}`, "aria-hidden": "true" });
  signe.innerHTML = iconeDe(i);
  const carte = el("div", { class: "livrable", "data-adresse": adresse },
    el("button", { type: "button", class: "livrable-ouvrir", "aria-label": `Ouvrir l'aperçu de ${nom}`, onclick: () => ouvrirApercu(adresse) },
      signe, el("span", { class: "livrable-texte" }, el("span", { class: "livrable-nom" }, titreDe(nom)), el("span", { class: "livrable-type" }, i.libelle))),
    outil(ICONES.telecharger, `Télécharger ${nom}`, { href: adresse, download: nom, class: "apercu-outil livrable-telecharger" }));
  return carte;
}

// Ajoute sous une réponse les cartes de ses livrables (une par fichier, dans l'ordre), en plus des liens du texte.
export function ajouterLivrables(bulle) {
  const adresses = [...new Set([...bulle.querySelectorAll("a.fichier-cree")].map((a) => a.getAttribute("href")).filter((h) => LIVRABLE.test(h)))];
  bulle.querySelector(":scope > .livrables")?.remove();
  if (adresses.length) bulle.append(el("div", { class: "livrables" }, ...adresses.map(carteLivrable)));
}

// Hermes accueille l'aperçu dans son panneau ; ailleurs (ou sans Hermes à l'écran), une fenêtre par-dessus la page.
let hote = null;
export function poserHoteApercu(noeud, ouvrir) { hote = { noeud, ouvrir }; }

export function ouvrirApercu(adresse) {
  if (!LIVRABLE.test(adresse)) return;
  if (hote?.noeud.isConnected) { hote.ouvrir(adresse); return; }
  const d = el("dialog", { class: "apercu-fenetre", onclose: () => d.remove(), onclick: (e) => { if (e.target === d) d.close(); } });
  d.append(construireApercu(adresse, { fermer: () => d.close() }));
  document.body.append(d);
  d.showModal();
}

async function lireTexte(adresse) {
  const r = await fetch(adresse, { credentials: "same-origin" });
  if (!r.ok) throw new Error(r.status === 404 ? "Ce fichier n'existe plus." : `Lecture impossible (erreur ${r.status}).`);
  const brut = await r.text();
  return brut.length > TEXTE_MAX ? `${brut.slice(0, TEXTE_MAX)}\n\n… (la suite est dans le fichier téléchargé)` : brut;
}

function tableauCsv(texte, separateur) {
  const lignes = texte.trim().split(/\r?\n/).slice(0, 500).map((l) => l.split(separateur).map((c) => c.replace(/^"(.*)"$/, "$1")));
  const [tete, ...corps] = lignes;
  return el("div", { class: "apercu-tableau" }, el("table", {},
    el("thead", {}, el("tr", {}, ...(tete || []).map((c) => el("th", {}, c)))),
    el("tbody", {}, ...corps.map((l) => el("tr", {}, ...l.map((c) => el("td", {}, c)))))));
}

async function pagesDe(adresse, corps) {
  corps.replaceChildren(el("p", { class: "apercu-attente" }, "Préparation de l'aperçu…"));
  const r = await fetch(`${adresse}/pages`, { credentials: "same-origin" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof d.detail === "string" ? d.detail : "Aperçu impossible.");
  const pages = el("div", { class: "apercu-pages" });
  for (let n = 1; n <= d.pages; n += 1) {
    pages.append(el("img", { src: `${adresse}/page/${n}`, alt: `Page ${n} sur ${d.total}`, loading: n > 2 ? "lazy" : "eager", class: "apercu-page" }));
  }
  if (d.total > d.pages) pages.append(el("p", { class: "doux petit" }, `Aperçu limité aux ${d.pages} premières pages sur ${d.total} : télécharge le fichier pour tout voir.`));
  corps.replaceChildren(pages);
}

// Le contenu de l'aperçu (tête + corps), le même dans le panneau de Hermes et dans la fenêtre.
export function construireApercu(adresse, { fermer, agrandir = null } = {}) {
  const nom = nomDe(adresse);
  const i = infosLivrable(nom);
  let texte = null;
  let vueCode = false;
  const corps = el("div", { class: `apercu-corps apercu-${i.genre}` });
  const bascule = i.source ? el("div", { class: "apercu-bascule", role: "group", "aria-label": "Affichage" }) : null;
  const copier = i.texte ? el("button", { type: "button", class: "apercu-copier", disabled: true }, "Copier") : null;
  const tete = el("div", { class: "apercu-tete" },
    bascule,
    el("span", { class: "apercu-titre", title: nom }, el("span", { class: "apercu-nom" }, titreDe(nom)), el("span", { class: "apercu-ext" }, ` · ${i.ext.toUpperCase() || "FICHIER"}`)),
    copier,
    outil(ICONES.telecharger, "Télécharger", { href: adresse, download: nom }),
    agrandir ? outil(ICONES.agrandir, "Agrandir", { class: "apercu-outil apercu-agrandir", onclick: (e) => {
      const large = agrandir();
      e.currentTarget.innerHTML = large ? ICONES.reduire : ICONES.agrandir;
      e.currentTarget.setAttribute("aria-label", large ? "Réduire" : "Agrandir");
      e.currentTarget.title = large ? "Réduire" : "Agrandir";
    } }) : null,
    outil(ICONES.fermer, "Fermer l'aperçu", { onclick: fermer }));

  const erreur = (message) => corps.replaceChildren(el("div", { class: "apercu-vide" }, el("p", {}, message),
    el("a", { class: "bouton-lien", href: adresse, download: nom }, "Télécharger")));

  function dessiner() {
    if (texte === null) return;
    bascule?.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.vue === "code") === vueCode)));
    corps.classList.toggle("en-code", vueCode || !i.source);
    if (vueCode || !i.source) {
      corps.replaceChildren(el("pre", { class: "apercu-source" }, el("code", {}, texte || "(vide)")));
    } else if (i.genre === "markdown") {
      corps.replaceChildren(el("article", { class: "apercu-doc" }, ...rendreMarkdown(texte, { decalage: 0 })));
    } else if (i.genre === "html") {
      // Aucun script, aucun accès à Poste : la page est montrée telle quelle, dans un cadre fermé.
      corps.replaceChildren(el("iframe", { class: "apercu-page-web", sandbox: "", srcdoc: texte, title: nom, referrerpolicy: "no-referrer" }));
    } else if (i.genre === "csv") {
      corps.replaceChildren(tableauCsv(texte, i.ext === "tsv" ? "\t" : (texte.split("\n")[0].split(";").length > texte.split("\n")[0].split(",").length ? ";" : ",")));
    }
  }

  if (bascule) {
    for (const [vue, svg, etiquette] of [["apercu", ICONES.oeil, "Aperçu"], ["code", ICONES.code, "Code"]]) {
      const b = el("button", { type: "button", "data-vue": vue, "aria-label": etiquette, title: etiquette, onclick: () => { vueCode = vue === "code"; dessiner(); } });
      b.innerHTML = svg;
      bascule.append(b);
    }
  }
  if (copier) {
    copier.onclick = async () => {
      try {
        await navigator.clipboard.writeText(texte ?? "");
        copier.textContent = "Copié";
      } catch {
        copier.textContent = "Copie impossible";
      }
      setTimeout(() => { copier.textContent = "Copier"; }, 1500);
    };
  }

  if (i.texte) {
    corps.append(el("p", { class: "apercu-attente" }, "Lecture…"));
    lireTexte(adresse).then((t) => { texte = t; if (copier) copier.disabled = false; dessiner(); }).catch((err) => erreur(err.message));
  } else if (i.genre === "image") {
    corps.append(el("img", { src: adresse, alt: nom, class: "apercu-image", onerror: () => erreur("Cette image n'existe plus.") }));
  } else if (i.genre === "pdf" || i.genre === "bureau") {
    pagesDe(adresse, corps).catch((err) => erreur(err.message));
  } else {
    erreur("Pas d'aperçu pour ce format.");
  }
  return el("div", { class: "apercu-livrable" }, tete, corps);
}
