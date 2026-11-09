// Onde de la dictée, comme dans l'application Claude : des barres qui défilent et suivent le volume de la voix.
// creerOnde() renvoie { element, niveau(v), arreter() } ; niveau() reçoit le volume (RMS, 0 à 1) à chaque instant.
import { el } from "./outils.js";

const BARRES = 32;
const PAS_MS = 70;

export function creerOnde({ barres = BARRES } = {}) {
  const element = el("div", { class: "onde", "aria-hidden": "true" });
  const traits = Array.from({ length: barres }, () => el("i", {}));
  element.append(...traits);
  const valeurs = new Array(barres).fill(0);
  let courant = 0;
  let pic = 0;
  // Le volume de la parole est faible (0,02 à 0,2) : racine carrée et gain pour qu'une voix normale remplisse la barre.
  const niveau = (v) => { pic = Math.max(pic, Math.min(1, Math.sqrt(v) * 2.4)); };
  const minuteur = setInterval(() => {
    courant = pic > courant ? pic : courant * 0.55 + pic * 0.45;
    pic = 0;
    valeurs.shift();
    valeurs.push(courant);
    traits.forEach((t, i) => { t.style.transform = `scaleY(${Math.max(0.08, valeurs[i])})`; });
    element.classList.toggle("parle", courant > 0.12);
  }, PAS_MS);
  return { element, niveau, arreter: () => { clearInterval(minuteur); element.remove(); } };
}
