// Dates en français courant pour l'ajout rapide : « demain 14h appel Dupont », « lundi 9h30 dentiste »,
// « le 12 à 18h vélo », « 24/12 réveillon ». Sans heure : 9 h. Renvoie null si aucune date n'est reconnue.

const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MOIS_COURTS = ["janv", "févr", "mars", "avr", "mai", "juin", "juil", "août", "sept", "oct", "nov", "déc"];
const sansAccent = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "");

const deux = (n) => String(n).padStart(2, "0");
export const isoLocal = (d) => `${d.getFullYear()}-${deux(d.getMonth() + 1)}-${deux(d.getDate())}T${deux(d.getHours())}:${deux(d.getMinutes())}`;
export const jourIso = (d) => isoLocal(d).slice(0, 10);

function numeroMois(mot) {
  const m = sansAccent(mot.toLowerCase()).replace(/\.$/, "");
  const i = MOIS.findIndex((x) => sansAccent(x) === m);
  if (i >= 0) return i;
  return MOIS_COURTS.findIndex((x) => m.length >= 3 && sansAccent(x).startsWith(m));
}

export function analyser(texte, maintenant = new Date()) {
  let reste = ` ${texte.trim()} `;
  let jour = null;
  const prendre = (motif, faire) => {
    const m = reste.match(motif);
    if (!m) return false;
    faire(m);
    reste = reste.replace(m[0], " ");
    return true;
  };
  const base = new Date(maintenant.getFullYear(), maintenant.getMonth(), maintenant.getDate());
  const decale = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); return d; };

  prendre(/\s(après-demain|apres-demain|aujourd'hui|aujourd’hui|ce soir|demain)\s/i, (m) => {
    const mot = sansAccent(m[1].toLowerCase());
    jour = mot.startsWith("apres") ? decale(2) : mot === "demain" ? decale(1) : decale(0);
  })
  || prendre(/\s(?:le\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s/i, (m) => {
    const an = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : base.getFullYear();
    jour = new Date(an, Number(m[2]) - 1, Number(m[1]));
    if (!m[3] && jour < base) jour.setFullYear(an + 1);
  })
  || prendre(/\s(?:le\s+)?(\d{1,2})(?:er)?\s+([a-zéû]{3,9}\.?)\s/i, (m) => {
    const mois = numeroMois(m[2]);
    if (mois < 0) return;
    jour = new Date(base.getFullYear(), mois, Number(m[1]));
    if (jour < base) jour.setFullYear(base.getFullYear() + 1);
  })
  || prendre(/\s(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(?:\s+prochain)?\s/i, (m) => {
    const cible = JOURS.indexOf(m[1].toLowerCase());
    const ecart = (cible - base.getDay() + 7) % 7 || 7;
    jour = decale(ecart);
  })
  || prendre(/\sle\s+(\d{1,2})(?:er)?\s/i, (m) => {
    jour = new Date(base.getFullYear(), base.getMonth(), Number(m[1]));
    if (jour < base) jour.setMonth(jour.getMonth() + 1);
  });

  let heure = null;
  prendre(/\s(?:à|a|vers)?\s*(\d{1,2})\s*(?:h|:)\s*(\d{2})?\s/i, (m) => {
    const h = Number(m[1]), mn = Number(m[2] || 0);
    if (h < 24 && mn < 60) heure = [h, mn];
  });
  if (!heure && /\sce soir\s/i.test(` ${texte} `)) heure = [19, 0];
  if (!jour && !heure) return null;
  const jourDonne = Boolean(jour);
  if (!jour) jour = decale(0);
  const debut = new Date(jour);
  debut.setHours(...(heure || [9, 0]), 0, 0);
  // Une heure seule, déjà passée aujourd'hui : c'est demain.
  if (!jourDonne && debut < maintenant) debut.setDate(debut.getDate() + 1);
  const titre = reste.replace(/\s+/g, " ").replace(/^\s*(?:à|a|le|pour)\s+/i, "").trim();
  return { debut: isoLocal(debut), titre, heureDonnee: Boolean(heure) };
}
