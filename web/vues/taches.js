import { api, el, toast, vibrer, vide } from "../js/outils.js";
import { boutonMicro } from "../js/micro.js";

const dateCourte = (d) => new Date(`${d}T12:00`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const aujourdhui = () => new Date().toISOString().slice(0, 10);
const enRetard = (d) => d && d < aujourdhui();

function groupe(t) {
  if (!t.echeance) return "Sans date";
  if (t.echeance < aujourdhui()) return "En retard";
  if (t.echeance === aujourdhui()) return "Aujourd'hui";
  return "À venir";
}
const ORDRE = ["En retard", "Aujourd'hui", "À venir", "Sans date"];


export async function vueTaches(cible) {
  const liste = el("div", {});
  const titre = el("input", { required: true, placeholder: "Nouvelle tâche", "aria-label": "Nouvelle tâche", autocomplete: "off" });
  const echeance = el("input", { type: "date", "aria-label": "Échéance" });
  const urgente = el("button", {
    type: "button", class: "etoile-tache", "aria-pressed": "false", title: "Priorité haute", "aria-label": "Priorité haute",
    onclick: () => urgente.setAttribute("aria-pressed", String(urgente.getAttribute("aria-pressed") !== "true")),
  }, "★");

  const changer = async (t, corps) => { await api(`/api/taches/${t.id}`, { methode: "PATCH", corps }); charger(); };
  // Terminer : la tâche disparaît, « Annuler » la remet.
  const terminer = async (t) => {
    vibrer(15);
    await changer(t, { faite: true });
    toast("Tâche terminée", "Annuler", () => changer(t, { faite: false }));
  };
  const retirer = async (t) => {
    vibrer(15);
    await api(`/api/taches/${t.id}`, { methode: "DELETE" });
    charger();
    toast("Tâche retirée");
  };
  // Au doigt : glisser vers la droite termine, vers la gauche retire.
  function gestes(ligne, t) {
    let x0 = null, y0 = 0, dx = 0, horizontal = null;
    ligne.addEventListener("touchstart", (e) => {
      if (e.target.closest("input, button")) return;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; horizontal = null;
    }, { passive: true });
    ligne.addEventListener("touchmove", (e) => {
      if (x0 === null) return;
      dx = e.touches[0].clientX - x0;
      if (horizontal === null && Math.abs(dx) + Math.abs(e.touches[0].clientY - y0) > 8) horizontal = Math.abs(dx) > Math.abs(e.touches[0].clientY - y0);
      if (!horizontal) return;
      ligne.style.transform = `translateX(${dx}px)`;
      ligne.classList.toggle("vers-fait", dx > 0);
      ligne.classList.toggle("vers-retrait", dx < 0);
    }, { passive: true });
    ligne.addEventListener("touchend", () => {
      if (x0 === null) return;
      x0 = null;
      ligne.style.transform = "";
      if (horizontal && dx > 90) terminer(t);
      else if (horizontal && dx < -90) retirer(t);
      else ligne.classList.remove("vers-fait", "vers-retrait");
    });
  }
  function ligneTache(t) {
    const ligne = el("div", { class: `ligne tache${t.priorite ? " prioritaire" : ""}` },
      el("input", { type: "checkbox", class: "case", "aria-label": `Terminer ${t.titre}`, onchange: () => terminer(t) }),
      el("span", { class: "corps" }, t.titre,
        t.echeance ? el("span", { class: `sous-date num petit ${enRetard(t.echeance) ? "alerte" : "doux"}` }, dateCourte(t.echeance)) : null),
      el("button", {
        class: `etoile-tache${t.priorite ? " actif" : ""}`, "aria-pressed": String(Boolean(t.priorite)),
        title: t.priorite ? "Retirer la priorité" : "Prioritaire", "aria-label": t.priorite ? `Retirer la priorité de ${t.titre}` : `Rendre ${t.titre} prioritaire`,
        onclick: () => changer(t, { priorite: t.priorite ? 0 : 1 }),
      }, "★"),
      el("button", { class: "lien petit alerte retirer-tache", onclick: () => retirer(t) }, "Retirer"));
    gestes(ligne, t);
    return ligne;
  }

  async function charger() {
    const taches = await api("/api/taches");
    const groupes = new Map(ORDRE.map((g) => [g, []]));
    for (const t of taches) groupes.get(groupe(t)).push(t);
    liste.replaceChildren(...(taches.length
      ? [...groupes].filter(([, l]) => l.length).map(([nom, l]) => el("div", { class: "groupe-taches" },
        el("h3", { class: `titre-groupe${nom === "En retard" ? " alerte" : ""}` }, `${nom} · ${l.length}`), el("div", { class: "liste-carte" }, l.map(ligneTache))))
      : [vide("Aucune tâche. Ajoute-en une ci-dessus.")]));
  }

  cible.append(el("div", { class: "page" },
    el("div", { class: "tete" }, el("h1", {}, "Tâches")),
    el("form", {
      class: "hermes-rapide ajout-tache",
      onsubmit: async (e) => {
        e.preventDefault();
        await api("/api/taches", { methode: "POST", corps: { titre: titre.value.trim(), echeance: echeance.value || null, priorite: urgente.getAttribute("aria-pressed") === "true" ? 1 : 0 } });
        titre.value = "";
        echeance.value = "";
        urgente.setAttribute("aria-pressed", "false");
        charger();
      },
    }, titre, boutonMicro(titre), echeance, urgente, el("button", { class: "plein ajouter-tache", "aria-label": "Ajouter la tâche" }, el("span", { class: "plus" }, "+"), el("span", { class: "texte" }, "Ajouter"))),
    el("div", { class: "colonnes" },
      el("section", {}, el("h2", {}, "Mes tâches"), liste))));
  await charger();
}
