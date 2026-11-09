// Recherche globale (Ctrl+K) : sections, tâches, agenda, fichiers (noms et contenu), mails et conversations Hermes,
// dans une seule fenêtre. Flèches pour choisir, Entrée pour ouvrir, Échap pour fermer.
import { api, el, vide } from "./outils.js";
import { boutonMicro } from "./micro.js";

const q = encodeURIComponent;
const sansAccent = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const contient = (texte, mot) => sansAccent(texte || "").includes(sansAccent(mot));
const surligner = (texte) => texte.split(/(\x02[^\x03]*\x03)/).filter(Boolean)
  .map((m) => (m.startsWith("\x02") ? el("mark", {}, m.slice(1, -1)) : m));
const jour = (iso) => new Date(`${iso.slice(0, 10)}T12:00`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });

export function ouvrirRecherche(sections) {
  if (document.querySelector(".palette")) return;
  const champ = el("input", { type: "search", placeholder: "Chercher partout : tâches, agenda, fichiers, mails, Hermes…", "aria-label": "Recherche globale", autocomplete: "off" });
  const resultats = el("div", { class: "palette-resultats", role: "listbox", "aria-label": "Résultats" });
  const d = el("dialog", { class: "palette", onclose: () => d.remove(), onclick: (e) => { if (e.target === d) d.close(); } },
    el("div", { class: "palette-tete" }, champ, boutonMicro(champ, { etiquette: "Dicter la recherche" })),
    resultats,
    el("p", { class: "palette-pied doux petit" }, "↑ ↓ pour choisir · Entrée pour ouvrir · Échap pour fermer"));
  document.body.append(d);
  d.showModal();
  champ.focus();

  // Ce qui se charge une fois à l'ouverture ; le reste est demandé au serveur à chaque frappe.
  const recul = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);
  const locales = Promise.all([
    api("/api/taches").catch(() => []),
    api(`/api/agenda?du=${recul}T00:00`).catch(() => []),
    api("/api/espace/arbre").catch(() => []),
  ]);
  let numero = 0;
  let choix = 0;
  let liens = [];

  const ouvrir = (a) => {
    if (a.dataset.hermes) sessionStorage.setItem("hermes-ouvrir", a.dataset.hermes);
    d.close();
    const cible = a.getAttribute("href");
    // Même adresse : on redessine quand même (ex. ouvrir une autre conversation depuis Hermes).
    if (cible === location.hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
    else location.hash = cible;
  };
  const marquer = () => liens.forEach((a, i) => { a.classList.toggle("choisi", i === choix); a.setAttribute("aria-selected", String(i === choix)); if (i === choix) a.scrollIntoView({ block: "nearest" }); });
  const resultat = (href, titre, detail, extra = {}) => el("a", { class: "palette-item", href, role: "option", ...extra,
    onclick: (e) => { e.preventDefault(); ouvrir(e.currentTarget); } },
  el("span", { class: "palette-titre" }, titre), detail ? el("span", { class: "palette-detail doux petit" }, detail) : null);
  const groupe = (nom, items) => (items.length ? [el("div", { class: "palette-groupe", role: "presentation" }, nom), ...items] : []);

  async function chercher() {
    const mot = champ.value.trim();
    const n = ++numero;
    if (!mot) {
      liens = sections.map(([id, titre]) => resultat(`#${id}`, titre, "Aller à la section"));
      resultats.replaceChildren(...groupe("Sections", liens));
      choix = 0;
      marquer();
      return;
    }
    const [taches, agenda, arbre] = await locales;
    const distants = mot.length >= 2 ? await Promise.all([
      api(`/api/espace/recherche?texte=${q(mot)}`).catch(() => []),
      api(`/api/mails?q=${q(mot)}&limite=6`).catch(() => []),
      api(`/api/hermes/conversations/recherche?q=${q(mot)}`).catch(() => []),
    ]) : [[], [], []];
    if (n !== numero) return;
    const [contenus, mails, conversations] = distants;
    const nomDe = (c) => c.split("/").pop();
    const parNom = arbre.filter((e) => contient(nomDe(e.chemin), mot)).slice(0, 6);
    const dejaVus = new Set(parNom.map((e) => e.chemin));
    const ouvrirFichier = (e) => (e.dossier ? `#fichiers/d/${q(e.chemin)}` : `#fichiers/d/${q(e.chemin.split("/").slice(0, -1).join("/"))}`);
    const blocs = [
      ...groupe("Sections", sections.filter(([, t]) => contient(t, mot)).map(([id, titre]) => resultat(`#${id}`, titre, "Section"))),
      ...groupe("Tâches", taches.filter((t) => contient(t.titre, mot)).slice(0, 5).map((t) => resultat("#taches", t.titre, t.echeance ? `Échéance ${jour(t.echeance)}` : "Sans date"))),
      ...groupe("Agenda", agenda.filter((e) => contient(e.titre, mot) || contient(e.lieu, mot)).slice(0, 5)
        .map((e) => resultat("#agenda", e.titre, `${jour(e.debut)} à ${e.debut.slice(11, 16)}${e.lieu ? ` · ${e.lieu}` : ""}`))),
      ...groupe("Fichiers", [
        ...parNom.map((e) => resultat(ouvrirFichier(e), nomDe(e.chemin), e.chemin.includes("/") ? e.chemin.split("/").slice(0, -1).join("/") : "Tous les fichiers")),
        ...contenus.filter((r) => !dejaVus.has(r.chemin)).slice(0, 5).map((r) => {
          const a = resultat(`#fichiers/d/${q(r.chemin.split("/").slice(0, -1).join("/"))}`, nomDe(r.chemin), null);
          a.append(el("span", { class: "palette-detail doux petit" }, surligner(r.extrait)));
          return a;
        })]),
      ...groupe("Mails", mails.slice(0, 6).map((m) => resultat(`#mails/${m.compte}/${m.uid}`, m.sujet, m.de))),
      ...groupe("Hermes", conversations.slice(0, 5).map((c) => resultat("#hermes", c.titre, c.extrait, { "data-hermes": c.id }))),
    ];
    liens = blocs.filter((b) => b.matches("a"));
    resultats.replaceChildren(...(blocs.length ? blocs : [vide(`Rien pour « ${mot} ».`)]));
    choix = 0;
    marquer();
  }

  let attente = 0;
  let aJour = true;
  champ.addEventListener("input", () => { aJour = false; clearTimeout(attente); attente = setTimeout(() => chercher().then(() => { aJour = true; }), 200); });
  champ.addEventListener("keydown", async (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!liens.length) return;
      choix = (choix + (e.key === "ArrowDown" ? 1 : -1) + liens.length) % liens.length;
      marquer();
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Entrée juste après la frappe : on attend les résultats de ce qui est tapé, pas ceux d'avant.
      if (!aJour) {
        clearTimeout(attente);
        await chercher();
        aJour = true;
      }
      if (liens[choix]) ouvrir(liens[choix]);
    }
  });
  chercher();
}
