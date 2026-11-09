// Mise en forme des réponses de Hermes. Construit des nœuds, jamais de HTML : le texte d'un modèle reste du texte.
import { el } from "./outils.js";
import { ouvrirLecteur } from "./lecteur.js";
import { ouvrirApercu } from "./apercu.js";

const ICONE_COPIER = "Copier";

async function copier(texte) {
  try {
    await navigator.clipboard.writeText(texte);
    return true;
  } catch {
    // Vue Web sans droit sur le presse-papiers : ancienne méthode, encore acceptée après un geste.
    const zone = el("textarea", { class: "copie-cachee", "aria-hidden": "true" });
    zone.value = texte;
    document.body.append(zone);
    zone.select();
    const fait = document.execCommand("copy");
    zone.remove();
    return fait;
  }
}

function blocCode(code, langage) {
  const bouton = el("button", {
    type: "button",
    class: "copier",
    onclick: async () => {
      const fait = await copier(code);
      bouton.textContent = fait ? "Copié" : "Échec";
      setTimeout(() => { bouton.textContent = ICONE_COPIER; }, 1500);
    },
  }, ICONE_COPIER);
  return el("div", { class: "bloc-code" },
    el("div", { class: "bloc-code-tete" }, el("span", { class: "mono petit doux" }, langage || "code"), bouton),
    el("pre", {}, el("code", {}, code)));
}

const FICHIER_POSTE = /^\/api\/fichiers\/[0-9a-f]{32}\/[^\s/]+$/;

function lien(texte, adresse) {
  // Fichier créé par Hermes : se télécharge depuis la session (dans l'APK, par le gestionnaire de téléchargements).
  // Image, PDF ou texte : aperçu dans le lecteur léger (téléchargement depuis l'aperçu) ; le reste se télécharge.
  if (FICHIER_POSTE.test(adresse)) {
    const nom = decodeURIComponent(adresse.split("/").pop());
    // Un clic ouvre l'aperçu (panneau de Hermes, ou fenêtre) ; Ctrl+clic télécharge directement.
    return el("a", {
      href: adresse, download: nom, class: "fichier-cree",
      onclick: (e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); ouvrirApercu(adresse); } },
    }, texte);
  }
  if (!/^(https?:|mailto:)/i.test(adresse)) return `${texte} (${adresse})`;
  return el("a", {
    href: adresse, target: "_blank", rel: "noopener noreferrer",
    onclick: (e) => {
      // Dans l'APK, naviguer vers un autre site ouvre le navigateur du téléphone.
      if (window.Capacitor?.isNativePlatform?.()) {
        e.preventDefault();
        location.href = adresse;
      }
    },
  }, texte);
}

const EN_LIGNE = /!\[([^\]\n]*)\]\((\/api\/fichiers\/[^)\s]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)\]]+)/g;

// L'utilisateur n'en veut pas, et le modèle en glisse encore malgré la consigne. Le code, lui, n'est jamais touché.
const sansTiret = (texte) => texte.replace(/\s+[—–]\s+/g, ", ").replace(/^[—–]\s+/, "");

function enLigne(texte) {
  const noeuds = [];
  let position = 0;
  for (const m of texte.matchAll(EN_LIGNE)) {
    noeuds.push(sansTiret(texte.slice(position, m.index)));
    position = m.index + m[0].length;
    if (m[2] !== undefined) {
      noeuds.push(FICHIER_POSTE.test(m[2]) ? el("img", {
        src: m[2], alt: m[1], class: "image-creee", tabindex: "0", role: "button", "aria-label": `Agrandir ${m[1] || "l'image"}`,
        onclick: () => ouvrirLecteur({ adresse: m[2], nom: decodeURIComponent(m[2].split("/").pop()), genre: "image" }),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.target.click(); } },
      }) : m[0]);
    }
    else if (m[3] !== undefined) noeuds.push(el("code", { class: "code-ligne" }, m[3]));
    else if (m[4] !== undefined || m[5] !== undefined) noeuds.push(el("strong", {}, ...enLigne(m[4] ?? m[5])));
    else if (m[6] !== undefined) noeuds.push(el("em", {}, ...enLigne(m[6])));
    else if (m[7] !== undefined) noeuds.push(lien(m[7], m[8]));
    else noeuds.push(lien(m[9], m[9]));
  }
  noeuds.push(sansTiret(texte.slice(position)));
  return noeuds.filter((n) => n !== "");
}

const cellules = (ligne) => ligne.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const SEPARATEUR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

// Le modèle ignore parfois la consigne : les tirets de ponctuation sont retirés, sauf dans le code.
const sansTirets = (texte) => texte.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
  .map((morceau, i) => (i % 2 ? morceau : morceau.replace(/([^\s|])[ \t]+[—–][ \t]+(?=[^\s|])/g, "$1, "))).join("");

export function rendreMarkdown(brut, { decalage = 2 } = {}) {
  const texte = sansTirets(brut);
  const lignes = texte.replace(/\r\n/g, "\n").split("\n");
  const sortie = [];
  let i = 0;
  while (i < lignes.length) {
    const ligne = lignes[i];
    const barriere = ligne.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/);
    if (barriere) {
      const code = [];
      i += 1;
      // Pendant l'écriture, la barrière de fin peut manquer : le bloc reste ouvert jusqu'au bout.
      while (i < lignes.length && !lignes[i].trim().startsWith(barriere[1])) code.push(lignes[i++]);
      i += 1;
      sortie.push(blocCode(code.join("\n"), barriere[2]));
    } else if (!ligne.trim()) {
      i += 1;
    } else if (/^#{1,6}\s/.test(ligne)) {
      const m = ligne.match(/^(#{1,6})\s+(.*)$/);
      sortie.push(el(`h${Math.min(m[1].length + decalage, 6)}`, { class: "titre-md" }, ...enLigne(m[2])));
      i += 1;
    } else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(ligne)) {
      sortie.push(el("hr", {}));
      i += 1;
    } else if (ligne.includes("|") && i + 1 < lignes.length && SEPARATEUR.test(lignes[i + 1]) && lignes[i + 1].includes("-")) {
      const tete = cellules(ligne);
      i += 2;
      const rangs = [];
      while (i < lignes.length && lignes[i].includes("|") && lignes[i].trim()) rangs.push(cellules(lignes[i++]));
      sortie.push(el("div", { class: "table-md" }, el("table", {},
        el("thead", {}, el("tr", {}, tete.map((c) => el("th", {}, ...enLigne(c))))),
        el("tbody", {}, rangs.map((r) => el("tr", {}, r.map((c) => el("td", {}, ...enLigne(c)))))))));
    } else if (/^\s*>/.test(ligne)) {
      const cite = [];
      while (i < lignes.length && /^\s*>/.test(lignes[i])) cite.push(lignes[i++].replace(/^\s*>\s?/, ""));
      sortie.push(el("blockquote", {}, ...enLigne(cite.join(" "))));
    } else if (/^\s*([-*+]|\d+[.)])\s+/.test(ligne)) {
      const ordonnee = /^\s*\d/.test(ligne);
      const items = [];
      while (i < lignes.length) {
        const m = lignes[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        if (m) {
          items.push(m[2]);
          i += 1;
        } else if (lignes[i].trim() && /^\s+\S/.test(lignes[i]) && items.length) {
          items[items.length - 1] += ` ${lignes[i++].trim()}`;
        } else {
          break;
        }
      }
      sortie.push(el(ordonnee ? "ol" : "ul", {}, items.map((t) => el("li", {}, ...enLigne(t)))));
    } else {
      const para = [];
      while (i < lignes.length && lignes[i].trim() && !/^\s*(`{3,}|~{3,}|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lignes[i])
        && !(lignes[i].includes("|") && SEPARATEUR.test(lignes[i + 1] || ""))) para.push(lignes[i++]);
      if (!para.length) para.push(lignes[i++]);
      sortie.push(el("p", {}, para.flatMap((l, n) => (n ? [el("br", {}), ...enLigne(l)] : enLigne(l)))));
    }
  }
  return sortie;
}
