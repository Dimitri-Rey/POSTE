import { api, el } from "./outils.js";

// Arrivée des mails à l'écran : le serveur veille les boîtes (IMAP IDLE) ; ici on regarde toutes les 20 s une empreinte
// minuscule de la liste, on pose une pastille sur « Mails », et on prévient la page ouverte pour qu'elle se recharge.
// Au retour dans l'application (téléphone), on demande en plus une vérification immédiate des boîtes.
export const PREF_VU = "poste-mails-vu";
const PERIODE = 20000;
let jeton = null;

const maintenant = () => String(Date.now() / 1000);

function poserPastille(n) {
  for (const lien of document.querySelectorAll('a[href="#mails"]')) {
    let p = lien.querySelector(".pastille-nb");
    if (!n) { p?.remove(); lien.removeAttribute("aria-label"); continue; }
    if (!p) { p = el("span", { class: "pastille-nb", "aria-hidden": "true" }); (lien.querySelector(".nav-icone") || lien).append(p); }
    p.textContent = n > 99 ? "99+" : String(n);
    lien.setAttribute("aria-label", `Mails, ${n} nouveau${n > 1 ? "x" : ""}`);
  }
}

// La page Mails est ouverte : tout ce qui est arrivé jusqu'ici est « vu ».
export function marquerVu() {
  localStorage.setItem(PREF_VU, maintenant());
  poserPastille(0);
}

export async function verifierMails() {
  if (document.hidden) return null;
  const surMails = location.hash.startsWith("#mails");
  if (surMails) localStorage.setItem(PREF_VU, maintenant());
  const e = await api(`/api/mails/etat?depuis=${localStorage.getItem(PREF_VU) || maintenant()}`).catch(() => null);
  if (!e) return null;
  poserPastille(surMails ? 0 : e.nouveaux);
  const change = jeton !== null && e.jeton !== jeton;
  jeton = e.jeton;
  window.dispatchEvent(new CustomEvent("poste:mails-etat", { detail: e }));
  if (change) window.dispatchEvent(new CustomEvent("poste:mails", { detail: e }));
  return e;
}

// Demande au serveur de relire les boîtes tout de suite, puis regarde le résultat quelques secondes après.
export function relancerMails() {
  api("/api/mails/synchroniser", { methode: "POST" }).catch(() => {});
  for (const delai of [3000, 8000]) setTimeout(verifierMails, delai);
}

export function demarrerVeilleMails() {
  if (!localStorage.getItem(PREF_VU)) localStorage.setItem(PREF_VU, maintenant());
  verifierMails();
  setInterval(verifierMails, PERIODE);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    verifierMails();
    relancerMails();
  });
}
