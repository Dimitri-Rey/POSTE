import { el } from "../js/outils.js";

// Un site intégré (Réglages → Sites intégrés) : sa page dans un cadre, et de quoi l'ouvrir à part.
// Le cadre garde ses propres cookies et scripts, mais il ne peut pas toucher à Poste (autre origine, vérifiée au serveur).
export function vueSite(site) {
  return async (cible) => {
    const cadre = el("iframe", {
      class: "site-cadre", src: site.adresse, title: site.nom, referrerpolicy: "no-referrer",
      sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals",
      allow: "clipboard-read; clipboard-write; fullscreen",
    });
    cible.append(el("section", { class: "site" },
      el("header", { class: "site-tete" },
        el("h1", {}, site.nom),
        el("span", { class: "doux petit site-adresse" }, new URL(site.adresse).host),
        el("span", { class: "site-actions" },
          el("button", { class: "lien", type: "button", onclick: () => { cadre.src = site.adresse; } }, "Recharger"),
          el("a", { class: "lien", href: site.adresse, target: "_blank", rel: "noopener noreferrer" }, "Ouvrir dans un onglet"))),
      cadre,
      el("p", { class: "doux petit site-aide" }, "Page blanche ? Le site refuse d'être affiché dans une autre page : ouvre-le dans un onglet.")));
  };
}
