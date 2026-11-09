// Taille du texte propre à chaque appareil : tout Poste est mis à l'échelle d'un coup.
export const PREF_TAILLE = "poste-taille-texte";
export const TAILLES = { normale: ["Normale", 1], grande: ["Grande", 1.1], tres: ["Très grande", 1.2] };

export function appliquerTaille() {
  const [, echelle] = TAILLES[localStorage.getItem(PREF_TAILLE)] || TAILLES.normale;
  document.documentElement.style.zoom = echelle === 1 ? "" : String(echelle);
  // Les unités d'écran grandissent avec le zoom : le CSS les divise par ce facteur (--haut, --large).
  document.documentElement.style.setProperty("--zoom", String(echelle));
}
