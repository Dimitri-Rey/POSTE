// Bouton micro à poser à côté de n'importe quel champ : la dictée locale (comme dans Hermes) écrit
// à l'endroit du curseur, en direct. Un second appui arrête. Rien ne sort de la machine.
import { el, moduleActif } from "./outils.js";
import { dicter, dicteePossible } from "./dictee.js";
import { creerOnde } from "./onde.js";

const ICONE_MICRO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
const ICONE_STOP = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/></svg>';

export function boutonMicro(champ, { etiquette = "Dicter" } = {}) {
  const bouton = el("button", { type: "button", class: "micro", title: etiquette, "aria-label": etiquette, hidden: !dicteePossible() || !moduleActif("dictee") });
  bouton.innerHTML = ICONE_MICRO;
  let dictee = null;
  let indication = champ.placeholder;
  const montrer = (actif) => {
    bouton.innerHTML = actif ? ICONE_STOP : ICONE_MICRO;
    bouton.classList.toggle("actif", actif);
    bouton.setAttribute("aria-label", actif ? "Arrêter la dictée" : etiquette);
    bouton.title = actif ? "Arrêter la dictée" : etiquette;
  };
  bouton.addEventListener("click", async () => {
    if (dictee) {
      dictee.arreter();
      return;
    }
    // Le texte dicté s'insère au curseur (après une éventuelle sélection) : la dictée n'efface jamais rien.
    const position = champ.selectionEnd ?? champ.value.length;
    const avant = champ.value.slice(0, position);
    const apres = champ.value.slice(position);
    indication = champ.placeholder;
    montrer(true);
    // L'onde prend une ligne entière sous le champ, le temps de la dictée (le champ garde toute sa largeur).
    const onde = creerOnde({ barres: 56 });
    const parent = bouton.parentElement;
    parent?.classList.add("dicte");
    parent?.append(onde.element);
    champ.placeholder = "Connexion au micro…";
    let termine = false;
    dictee = { arreter() {} };
    const enCours = await dicter({
      texte: (t) => {
        const gauche = avant && !/\s$/.test(avant) ? `${avant} ` : avant;
        const droite = apres && !/^\s/.test(apres) ? ` ${apres}` : apres;
        champ.value = gauche + t + droite;
        const curseur = (gauche + t).length;
        champ.setSelectionRange?.(curseur, curseur);
        champ.dispatchEvent(new Event("input", { bubbles: true }));
      },
      etat: (m) => {
        // Vue quittée : le micro ne doit jamais rester ouvert.
        if (!bouton.isConnected) dictee?.arreter();
        if (!champ.value) champ.placeholder = m;
        bouton.title = m;
      },
      erreur: (m) => {
        champ.placeholder = m;
        bouton.classList.add("en-erreur");
        setTimeout(() => { bouton.classList.remove("en-erreur"); champ.placeholder = indication; }, 5000);
      },
      niveau: onde.niveau,
      fin: () => {
        onde.arreter();
        parent?.classList.remove("dicte");
        termine = true;
        dictee = null;
        montrer(false);
        if (!bouton.classList.contains("en-erreur")) champ.placeholder = indication;
        champ.focus();
      },
    });
    // Une erreur immédiate (micro refusé) a déjà tout terminé avant le retour de dicter().
    if (!termine) dictee = enCours;
  });
  return bouton;
}
