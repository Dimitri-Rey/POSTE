import { api, el } from "./outils.js";

// Première visite : choix du mot de passe. Ensuite : connexion.
export function ecranConnexion(initialise, suite) {
  const erreur = el("p", { class: "erreur", role: "alert" });
  const champ = el("input", {
    type: "password", required: true, autofocus: true, "aria-label": "Mot de passe",
    placeholder: initialise ? "Mot de passe" : "Choisis un mot de passe (10 caractères ou plus)",
    autocomplete: initialise ? "current-password" : "new-password",
  });
  const bouton = el("button", { class: "plein" }, initialise ? "Entrer" : "Créer et entrer");
  const formulaire = el("form", {
    onsubmit: async (e) => {
      e.preventDefault();
      bouton.disabled = true;
      erreur.textContent = "";
      try {
        await api(initialise ? "/api/auth/connexion" : "/api/auth/creer", {
          methode: "POST", corps: { mot_de_passe: champ.value },
        });
        suite();
      } catch (err) {
        erreur.textContent = err.message;
        bouton.disabled = false;
      }
    },
  }, el("h1", {}, "Poste"), champ, bouton, erreur);
  return el("div", { class: "seuil" }, formulaire);
}
