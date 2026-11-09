import { api, el, jauge, pastilleService } from "../js/outils.js";

export function blocStrava(etat) {
  const zone = el("div", {});
  const message = el("p", { class: "doux petit" });
  const formulaire = (e) => {
    const id = el("input", { inputmode: "numeric", autocomplete: "off", placeholder: "ID du client", "aria-label": "ID du client" });
    const secret = el("input", { type: "password", autocomplete: "off", placeholder: "Secret du client", "aria-label": "Secret du client" });
    const avis = el("p", { class: "petit doux" }, "À copier depuis strava.com/settings/api. Le secret reste sur ton serveur et ne sera plus jamais affiché.");
    return el("form", {
      class: "pile",
      onsubmit: async (ev) => {
        ev.preventDefault();
        try {
          await api("/api/sport/identifiants", { methode: "POST", corps: { client_id: id.value.trim(), client_secret: secret.value.trim() } });
          dessiner(await api("/api/sport/etat"));
        } catch {
          avis.className = "petit erreur";
          avis.textContent = "Vérifie les deux valeurs : l'ID ne contient que des chiffres, le secret que des lettres et des chiffres.";
        }
      },
    }, id, secret, el("button", { class: "plein" }, "Enregistrer"), e.configure ? el("button", { type: "button", onclick: () => dessiner(e) }, "Annuler") : null, avis);
  };
  const dessiner = (e) => {
    if (!e.configure) {
      zone.replaceChildren(formulaire(e));
    } else if (!e.connecte) {
      message.textContent = "Hermes pourra lire tes activités, sans jamais rien modifier.";
      zone.replaceChildren(message, el("div", { class: "boutons" },
        el("a", { href: "/api/sport/connexion", class: "bouton-lien plein" }, "Connecter Strava"),
        el("button", { onclick: () => zone.replaceChildren(formulaire(e)) }, "Changer les identifiants")));
    } else {
      message.textContent = `Connecté, ${e.activites} activités lues.`;
      const deconnecter = el("button", {
        onclick: async () => {
          if (!deconnecter.dataset.confirme) {
            deconnecter.dataset.confirme = "1";
            deconnecter.textContent = "Confirmer : retirer l'accès et effacer les activités de Poste";
            return;
          }
          await api("/api/sport/deconnecter", { methode: "POST" });
          dessiner(await api("/api/sport/etat"));
        },
      }, "Déconnecter");
      const synchro = el("button", {
        onclick: async () => {
          synchro.disabled = true;
          try {
            await api("/api/sport/synchroniser", { methode: "POST" });
            dessiner(await api("/api/sport/etat"));
          } catch (err) {
            message.textContent = err.message;
            synchro.disabled = false;
          }
        },
      }, "Synchroniser");
      zone.replaceChildren(message, el("div", { class: "boutons" }, synchro, deconnecter));
    }
  };
  dessiner(etat);
  return zone;
}

export async function vueServeur(cible) {
  const s = await api("/api/serveur");
  // [libellé, valeur lisible, part utilisée 0..1]
  const paires = [
    ["Charge", `${s.charge} sur ${s.coeurs} cœurs`, s.charge / s.coeurs],
    ["Mémoire", `${s.memoire.utilise_go} / ${s.memoire.total_go} Go`, s.memoire.utilise_go / s.memoire.total_go],
  ];
  if (s.gpu) {
    paires.push(["GPU", `${s.gpu.charge} %, ${s.gpu.temperature} °C`, s.gpu.charge / 100]);
    paires.push(["Mémoire GPU", `${s.gpu.memoire_go} / ${s.gpu.memoire_totale_go} Go`, s.gpu.memoire_go / s.gpu.memoire_totale_go]);
  }
  for (const d of s.disques) paires.push([d.nom, `${d.libre_go} Go libres sur ${d.total_go}`, 1 - d.libre_go / d.total_go]);
  const enMarche = s.services.filter((x) => x.etat === "active").length;
  cible.append(el("div", { class: "page" },
    el("div", { class: "tete" }, el("h1", {}, "Serveur")),
    el("div", { class: "colonnes" },
      el("section", { class: "carte" }, el("h2", {}, "Machine"),
        el("div", { class: "mesures" }, paires.map(([a, b, part]) => el("div", { class: "mesure" },
          el("div", { class: "mesure-tete" }, el("span", { class: "doux" }, a), el("span", { class: "num" }, b)), jauge(part))))),
      el("section", { class: "carte" }, el("h2", {}, `Services · ${enMarche} sur ${s.services.length} en marche`),
        s.services.map((x) => el("div", { class: "ligne" },
          el("span", { class: "corps" }, x.nom), pastilleService(x.etat))))),
    el("p", { class: "doux petit" }, "Strava, l'application Android et la déconnexion sont dans ", el("a", { href: "#reglages", class: "ambre" }, "Réglages"), ".")));
}
