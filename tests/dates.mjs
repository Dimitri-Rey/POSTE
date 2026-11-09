// Ajout rapide de l'agenda : dates en français courant. node tests/dates.mjs
import { analyser } from "../web/js/dates.js";
const ref = new Date(2026, 10, 5, 10, 15); // jeudi 5 novembre 2026, 10:15
const cas = [
  ["demain 14h appel Dupont", "2026-11-06T14:00", "appel Dupont"],
  ["lundi 9h30 dentiste", "2026-11-09T09:30", "dentiste"],
  ["jeudi réunion", "2026-11-12T09:00", "réunion"],
  ["le 12 à 18h vélo", "2026-11-12T18:00", "vélo"],
  ["24/12 réveillon", "2026-12-24T09:00", "réveillon"],
  ["3 janvier 10h vœux", "2027-01-03T10:00", "vœux"],
  ["15 nov. 8h course", "2026-11-15T08:00", "course"],
  ["aujourd'hui 16h appel banque", "2026-11-05T16:00", "appel banque"],
  ["9h café", "2026-11-06T09:00", "café"],
  ["après-demain 7h train", "2026-11-07T07:00", "train"],
  ["ce soir resto", "2026-11-05T19:00", "resto"],
  ["acheter du pain", null, null],
];
let ko = 0;
for (const [t, d, titre] of cas) {
  const r = analyser(t, ref);
  const ok = d === null ? r === null : r && r.debut === d && r.titre === titre;
  if (!ok) { ko++; console.log("KO", t, JSON.stringify(r)); }
}
console.log(ko ? `${ko} échec(s)` : `${cas.length} cas ok`);
process.exit(ko ? 1 : 0);
