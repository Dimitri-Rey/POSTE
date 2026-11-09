// Lecteur léger : un aperçu par-dessus la page (image, PDF, texte), fermé par un clic à l'extérieur, Échap, × ou Retour.
// Ne lit que des adresses de Poste (fichiers créés par Hermes, documents joints) : jamais un site extérieur.
import { el } from "./outils.js";

const IMAGES = /\.(png|jpe?g|gif|webp|avif)$/i;
const TEXTES = /\.(txt|md|csv|tsv|json|ya?ml|xml|log|py|js|ts|sh|sql|ini|toml|conf|css|html?)$/i;
const TEXTE_MAX = 400_000;
const ADRESSE_POSTE = /^\/api\/(fichiers\/[0-9a-f]{32}\/[^\s/]+|documents\/[0-9a-f]{32}\/texte)$/;

export const genreDe = (nom) => (IMAGES.test(nom) ? "image" : /\.pdf$/i.test(nom) ? "pdf" : TEXTES.test(nom) ? "texte" : "autre");

const ICONE_FERMER = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICONE_TELECHARGER = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>';

function bouton(svg, etiquette, attributs = {}) {
  const b = el(attributs.href ? "a" : "button", { class: "lecteur-outil", "aria-label": etiquette, title: etiquette, ...(attributs.href ? {} : { type: "button" }), ...attributs });
  b.innerHTML = svg;
  return b;
}

async function texteDe(adresse) {
  const r = await fetch(adresse, { credentials: "same-origin" });
  if (!r.ok) throw new Error(r.status === 404 ? "Ce fichier n'existe plus." : `Lecture impossible (erreur ${r.status}).`);
  if (adresse.startsWith("/api/documents/")) return (await r.json()).texte ?? "";
  const brut = await r.text();
  return brut.length > TEXTE_MAX ? `${brut.slice(0, TEXTE_MAX)}\n\n… (la suite est dans le fichier téléchargé)` : brut;
}

// { adresse, nom, genre?, telecharger? } : telecharger = adresse du fichier d'origine (sinon l'adresse affichée).
export function ouvrirLecteur({ adresse, nom, genre = genreDe(nom), telecharger = adresse }) {
  if (!ADRESSE_POSTE.test(adresse)) return null;
  const corps = el("div", { class: `lecteur-corps lecteur-${genre}` });
  const d = el("dialog", {
    class: "lecteur", "aria-label": `Aperçu : ${nom}`,
    onclose: () => d.remove(),
    // Un clic à l'extérieur du contenu (le fond sombre, les marges) ferme et rend la conversation.
    onclick: (e) => { if (e.target === d || e.target === corps) d.close(); },
  },
  el("div", { class: "lecteur-tete" },
    el("span", { class: "lecteur-nom", title: nom }, nom),
    ADRESSE_POSTE.test(telecharger) && telecharger.startsWith("/api/fichiers/")
      ? bouton(ICONE_TELECHARGER, "Télécharger", { href: telecharger, download: nom }) : null,
    bouton(ICONE_FERMER, "Fermer l'aperçu", { onclick: () => d.close() })),
  corps);
  const vide = (texte) => corps.replaceChildren(el("div", { class: "lecteur-vide" }, el("p", {}, texte),
    telecharger.startsWith("/api/fichiers/") ? el("a", { class: "bouton-lien", href: telecharger, download: nom }, "Télécharger") : null));
  if (genre === "image") {
    const image = el("img", { src: adresse, alt: nom, onerror: () => vide("Cette image n'existe plus."),
      onclick: () => corps.classList.toggle("zoom") });
    corps.append(image);
  } else if (genre === "pdf") {
    corps.append(el("iframe", { src: adresse, title: nom }));
  } else if (genre === "texte") {
    corps.append(el("p", { class: "doux" }, "Lecture…"));
    texteDe(adresse).then((t) => corps.replaceChildren(el("pre", { class: "lecteur-texte" }, t || "(vide)")))
      .catch((err) => vide(err.message));
  } else {
    vide("Pas d'aperçu pour ce format.");
  }
  document.body.append(d);
  d.showModal();
  return d;
}
