import { api, el, fenetre, toast } from "../js/outils.js";

// Section « Sauvegardes » de Réglages : un ou plusieurs endroits, chacun avec son planning, sa rotation
// (une complète, puis des incrémentielles) et sa durée de conservation.

const JOURS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const DEFAUT = { nom: "", fournisseur: "dossier", chemin: "", options: {}, actif: true, heure: "03:00", frequence: "jours", jours: "1234567", jour_mois: 1,
  complete: "semaine", complete_jour: 7, garder: 4, secrets: false };

const ligne = (titre, aide, champ) => el("div", { class: "reglage" },
  el("div", {}, el("strong", {}, titre), aide ? el("p", { class: "doux petit" }, aide) : null), champ);
const champ = (etiquette, controle) => el("label", { class: "br-champ" }, el("span", { class: "doux petit" }, etiquette), controle);

export function taille(octets) {
  if (octets == null) return "";
  const unites = ["octets", "Ko", "Mo", "Go", "To"];
  let v = octets;
  let i = 0;
  while (v >= 1024 && i < unites.length - 1) { v /= 1024; i += 1; }
  return `${i ? v.toLocaleString("fr-FR", { maximumFractionDigits: v < 10 ? 1 : 0 }) : v} ${unites[i]}`;
}

const dateCourte = (iso) => new Date(iso).toLocaleString("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function depuis(ts) {
  const minutes = Math.round((Date.now() / 1000 - ts) / 60);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  if (minutes < 60 * 24) return `il y a ${Math.round(minutes / 60)} h`;
  return `il y a ${Math.round(minutes / 1440)} j`;
}

// Le planning en une phrase, recalculé pendant la saisie (le serveur renvoie la même une fois enregistré).
function resume(p) {
  const quand = p.frequence === "mois" ? `le ${p.jour_mois} de chaque mois à ${p.heure}`
    : p.jours.length === 7 ? `tous les jours à ${p.heure}`
      : `${[...p.jours].sort().map((j) => JOURS[j - 1].toLowerCase()).join(", ")} à ${p.heure}`;
  const pl = p.garder > 1 ? "s" : "";
  const rotation = p.complete === "toujours" ? `toujours complète · ${p.garder} sauvegarde${pl} gardée${pl}`
    : p.complete === "semaine" ? `complète le ${JOURS[p.complete_jour - 1].toLowerCase()}, incrémentielle sinon · environ ${p.garder} semaine${pl} d'historique`
      : `complète le ${p.complete_jour} du mois, incrémentielle sinon · environ ${p.garder} mois d'historique`;
  return p.jours.length || p.frequence === "mois" ? `${quand[0].toUpperCase()}${quand.slice(1)} · ${rotation}.` : "Choisis au moins un jour.";
}

// Champs propres au stockage choisi, décrits par le serveur. Les secrets ne reviennent jamais : vide = garder l'enregistré.
function champsStockage(f, p, definis, secrets) {
  return f.champs.map((c) => {
    const etiquette = c.etiquette;
    const deja = definis.includes(c.cle);
    if (c.cle !== "chemin" && c.genre !== "secret" && c.genre !== "zone" && p.options[c.cle] === undefined && c.defaut) p.options[c.cle] = c.defaut;
    if (c.cle === "chemin" && !p.chemin && c.defaut && !p.id) p.chemin = c.defaut;
    const valeur = c.cle === "chemin" ? p.chemin : (p.options[c.cle] ?? "");
    const poser = (v) => {
      if (c.genre === "secret" || c.genre === "zone") secrets[c.cle] = v;
      else if (c.cle === "chemin") p.chemin = v;
      else p.options[c.cle] = v;
    };
    let controle;
    if (c.genre === "case") {
      controle = el("input", { type: "checkbox", role: "switch", class: "interrupteur", "aria-label": etiquette, checked: valeur === "1",
        onchange: (e) => poser(e.target.checked ? "1" : "") });
      return ligne(etiquette, c.aide, controle);
    }
    if (c.genre.startsWith("liste:")) {
      controle = el("select", { "aria-label": etiquette, onchange: (e) => poser(e.target.value) },
        c.genre.slice(6).split("|").map((v) => el("option", { value: v, selected: v === valeur }, v)));
    } else if (c.genre === "zone") {
      controle = el("textarea", { "aria-label": etiquette, rows: "4", spellcheck: "false", autocomplete: "off", class: "sv-zone-texte",
        placeholder: deja ? "Enregistré : laisse vide pour le garder" : "", oninput: (e) => poser(e.target.value) });
    } else {
      controle = el("input", {
        "aria-label": etiquette, spellcheck: "false", autocomplete: c.genre === "secret" ? "new-password" : "off",
        type: c.genre === "secret" ? "password" : c.genre === "nombre" ? "number" : c.genre === "url" ? "url" : "text",
        value: c.genre === "secret" ? "" : valeur, placeholder: c.genre === "secret" && deja ? "Enregistré : laisse vide pour le garder" : "",
        required: c.cle === "chemin" && f.type === "dossier",
        oninput: (e) => poser(e.target.value),
      });
    }
    return el("label", { class: "br-champ" }, el("span", { class: "doux petit" }, etiquette), controle,
      c.aide ? el("span", { class: "doux petit sv-aide" }, c.aide) : null);
  });
}

function choisirFournisseur(fournisseurs, rclone, apres) {
  const d = fenetre("Où sauvegarder ?",
    rclone ? null : el("p", { class: "erreur petit" }, "rclone n'est pas installé sur le serveur : seul un dossier du serveur est possible (https://rclone.org/install)."),
    el("div", { class: "br-fournisseurs sv-fournisseurs" }, Object.entries(fournisseurs).map(([id, f]) =>
      el("button", { type: "button", class: "br-fournisseur", disabled: !rclone && f.type !== "dossier",
        onclick: () => { d.close(); formulaire(null, apres, id, fournisseurs); } }, f.nom))),
    el("div", { class: "boutons" }, el("button", { type: "button", onclick: () => d.close() }, "Annuler")));
}

function formulaire(depart, apres, idFournisseur, fournisseurs) {
  const p = { ...DEFAUT, ...depart, jours: depart?.jours ?? DEFAUT.jours, options: { ...(depart?.options || {}) } };
  if (idFournisseur) p.fournisseur = idFournisseur;
  const f = fournisseurs[p.fournisseur];
  if (!p.nom) p.nom = f.nom;
  const saisis = {};
  const nouveau = !depart?.id;
  const phrase = el("p", { class: "sv-resume" });
  const message = el("p", { class: "doux petit br-message", role: "status" });
  const maj = () => { phrase.textContent = resume(p); };

  const nom = el("input", { value: p.nom, required: true, maxlength: "80", oninput: (e) => { p.nom = e.target.value; } });
  const champsOu = champsStockage(f, p, depart?.secrets_definis || [], saisis);
  const heure = el("input", { type: "time", value: p.heure, required: true, oninput: (e) => { p.heure = e.target.value || "03:00"; maj(); } });

  const puces = el("div", { class: "br-puces sv-jours", role: "group", "aria-label": "Jours" }, JOURS.map((j, i) => {
    const n = String(i + 1);
    return el("button", { type: "button", class: "br-puce", "aria-pressed": String(p.jours.includes(n)), title: j, "aria-label": j,
      onclick: (e) => {
        p.jours = p.jours.includes(n) ? p.jours.replace(n, "") : [...p.jours, n].sort().join("");
        e.currentTarget.setAttribute("aria-pressed", String(p.jours.includes(n)));
        maj();
      } }, j.slice(0, 3));
  }));
  const jourMois = el("input", { type: "number", min: "1", max: "31", value: String(p.jour_mois), "aria-label": "Jour du mois",
    oninput: (e) => { p.jour_mois = Math.min(31, Math.max(1, Number(e.target.value) || 1)); maj(); } });
  const zoneJours = el("div", {}, puces);
  const zoneMois = el("div", { class: "sv-en-ligne" }, el("span", {}, "Le"), jourMois, el("span", { class: "doux petit" }, "de chaque mois (31 = dernier jour)"));
  const frequence = el("select", { "aria-label": "Fréquence", onchange: (e) => { p.frequence = e.target.value; montrer(); maj(); } },
    el("option", { value: "jours", selected: p.frequence === "jours" }, "Certains jours de la semaine"),
    el("option", { value: "mois", selected: p.frequence === "mois" }, "Un jour par mois"));

  const completeJour = el("select", { "aria-label": "Jour de la complète" });
  const remplirJourComplete = () => {
    const options = p.complete === "semaine" ? JOURS.map((j, i) => [i + 1, j]) : Array.from({ length: 31 }, (_, i) => [i + 1, `le ${i + 1}`]);
    if (p.complete === "semaine" && p.complete_jour > 7) p.complete_jour = 7;
    completeJour.replaceChildren(...options.map(([v, t]) => el("option", { value: String(v), selected: v === p.complete_jour }, t)));
    completeJour.hidden = p.complete === "toujours";
  };
  completeJour.onchange = (e) => { p.complete_jour = Number(e.target.value); maj(); };
  const complete = el("select", { "aria-label": "Sauvegarde complète", onchange: (e) => {
    p.complete = e.target.value;
    if (p.complete === "mois" && p.complete_jour > 31) p.complete_jour = 1;
    remplirJourComplete();
    garderUnite.textContent = uniteGarder();
    maj();
  } },
  el("option", { value: "semaine", selected: p.complete === "semaine" }, "Une fois par semaine"),
  el("option", { value: "mois", selected: p.complete === "mois" }, "Une fois par mois"),
  el("option", { value: "toujours", selected: p.complete === "toujours" }, "À chaque fois"));
  const uniteGarder = () => (p.complete === "toujours" ? "dernières sauvegardes" : "dernières complètes (et leurs incrémentielles)");
  const garderUnite = el("span", { class: "doux petit" }, uniteGarder());
  const garder = el("input", { type: "number", min: "1", max: "365", value: String(p.garder), "aria-label": "Nombre gardé",
    oninput: (e) => { p.garder = Math.min(365, Math.max(1, Number(e.target.value) || 1)); maj(); } });
  const secrets = el("input", { type: "checkbox", role: "switch", class: "interrupteur", "aria-label": "Clés et secrets", checked: p.secrets,
    onchange: (e) => { p.secrets = e.target.checked; } });
  const actif = el("input", { type: "checkbox", role: "switch", class: "interrupteur", "aria-label": "Sauvegardes automatiques", checked: p.actif,
    onchange: (e) => { p.actif = e.target.checked; } });

  function montrer() {
    zoneJours.hidden = p.frequence !== "jours";
    zoneMois.hidden = p.frequence !== "mois";
  }
  montrer();
  remplirJourComplete();
  maj();

  const valider = el("button", { class: "plein" }, f.type === "dossier" ? (nouveau ? "Ajouter" : "Enregistrer") : (nouveau ? "Tester et ajouter" : "Tester et enregistrer"));
  const retirer = nouveau ? null : el("button", { type: "button", class: "lien alerte", onclick: async () => {
    if (!confirm(`Retirer « ${p.nom} » ? Les sauvegardes déjà faites restent là où elles sont (dossier poste-sauvegardes)${depart.chiffre ? " ; garde le mot de passe de chiffrement pour pouvoir les relire" : ""}.`)) return;
    try {
      await api(`/api/sauvegardes/${depart.id}`, { methode: "DELETE" });
      d.close();
      toast("Endroit retiré. Les sauvegardes déjà faites restent en place.");
      apres();
    } catch (err) {
      message.className = "erreur br-message";
      message.textContent = err.message;
    }
  } }, "Retirer");

  const d = fenetre(nouveau ? "Ajouter un endroit de sauvegarde" : `Modifier « ${p.nom} »`, el("form", {
    class: "pile sv-formulaire",
    onsubmit: async (ev) => {
      ev.preventDefault();
      if (p.frequence === "jours" && !p.jours) {
        message.className = "erreur br-message";
        message.textContent = "Choisis au moins un jour.";
        return;
      }
      valider.disabled = true;
      const texte = valider.textContent;
      if (f.type !== "dossier") valider.textContent = "Connexion au stockage…";
      message.className = "doux petit br-message";
      message.textContent = "";
      try {
        const corps = { ...p, secrets_stockage: Object.fromEntries(Object.entries(saisis).filter(([, v]) => v)) };
        delete corps.id;
        for (const cle of Object.keys(corps)) if (!(cle in DEFAUT) && cle !== "secrets_stockage") delete corps[cle];
        await api(nouveau ? "/api/sauvegardes" : `/api/sauvegardes/${depart.id}`, { methode: nouveau ? "POST" : "PUT", corps });
        d.close();
        toast(nouveau ? "Endroit ajouté. Première sauvegarde au prochain créneau, ou « Sauvegarder maintenant »." : "Enregistré.");
        apres();
      } catch (err) {
        message.className = "erreur br-message";
        message.textContent = err.message;
      } finally {
        valider.disabled = false;
        valider.textContent = texte;
      }
    },
  },
  champ("Nom", nom),
  el("fieldset", { class: "sv-groupe" }, el("legend", {}, f.nom), el("p", { class: "doux petit" }, f.aide), ...champsOu),
  el("fieldset", { class: "sv-groupe" }, el("legend", {}, "Quand"),
    el("div", { class: "sv-en-ligne" }, champ("Heure", heure), champ("Fréquence", frequence)), zoneJours, zoneMois),
  el("fieldset", { class: "sv-groupe" }, el("legend", {}, "Rotation"),
    el("div", { class: "sv-en-ligne" }, champ("Sauvegarde complète", complete), champ("Jour", completeJour)),
    el("p", { class: "doux petit" }, "Complète : toutes les données. Les autres fois, incrémentielle : seulement ce qui a changé depuis la précédente, plus rapide et plus petite.")),
  el("fieldset", { class: "sv-groupe" }, el("legend", {}, "Conservation"),
    el("div", { class: "sv-en-ligne" }, el("span", {}, "Garder les"), garder, garderUnite),
    el("p", { class: "doux petit" }, "Les plus anciennes sont effacées après chaque sauvegarde réussie.")),
  ligne("Clés et secrets", "Copie aussi la clé du coffre, les jetons et la clé de signature de l'APK. Sans eux, les mots de passe des branchements sont à ressaisir après une restauration. À éviter sur un disque que d'autres peuvent lire.", secrets),
  ligne("Sauvegardes automatiques", "Coupé : seulement à la main.", actif),
  phrase, message,
  el("div", { class: "boutons" }, valider, el("button", { type: "button", onclick: () => d.close() }, "Annuler"), retirer)));
  (d.querySelector("fieldset input:not([type=checkbox]), fieldset textarea") || nom).focus();
}

function historique(e) {
  const lignes = e.sauvegardes.map((s) => {
    const recuperer = el("button", { class: "lien", onclick: async () => {
      recuperer.disabled = true;
      try {
        const r = await api(`/api/sauvegardes/${e.id}/recuperer`, { methode: "POST", corps: { archive: s.archive } });
        d.close();
        toast(`${r.fichiers} élément${r.fichiers > 1 ? "s" : ""} remis dans Fichiers › ${r.dossier}.`, "Ouvrir",
          () => { location.hash = `fichiers/d/${encodeURIComponent(r.dossier)}`; });
      } catch (err) {
        toast(err.message);
      } finally {
        recuperer.disabled = false;
      }
    } }, "Récupérer les fichiers");
    return el("div", { class: "ligne br-ligne sv-archive" },
      el("div", { class: "corps" },
        el("strong", {}, dateCourte(s.date)),
        el("div", { class: "doux petit" },
          el("span", { class: `etiquette sv-${s.type}` }, s.type === "complete" ? "Complète" : "Incrémentielle"),
          ` ${taille(s.taille)} · ${s.fichiers} fichier${s.fichiers > 1 ? "s" : ""}${s.supprimes ? ` · ${s.supprimes} supprimé${s.supprimes > 1 ? "s" : ""}` : ""}${s.secrets ? " · avec secrets" : ""}`)),
      recuperer);
  });
  const d = fenetre(`Historique · ${e.nom}`,
    el("p", { class: "doux petit" }, "« Récupérer les fichiers » remet tes Fichiers tels qu'à cette date dans un dossier à part (Fichiers › Restaurations), sans rien écraser. Pour tout remettre (base comprise), voir « Restaurer une sauvegarde » dans le README."),
    el("div", { class: "liste-carte sv-historique" }, lignes.length ? lignes : el("p", { class: "doux br-vide" }, "Aucune sauvegarde pour l'instant.")),
    el("div", { class: "boutons" }, el("button", { type: "button", onclick: () => d.close() }, "Fermer")));
}

function carte(e, recharger, fournisseurs) {
  const derniere = e.sauvegardes[0];
  let etat;
  if (e.en_cours) etat = el("span", { class: "pastille attention" }, "Sauvegarde en cours…");
  else if (e.chargement && !e.lu_le) etat = el("span", { class: "pastille neutre" }, "Lecture du stockage…");
  else if (e.erreur) etat = el("span", { class: "erreur" }, e.erreur);
  else if (derniere) etat = el("span", { class: "pastille ok" }, `Dernière ${depuis(new Date(derniere.date).getTime() / 1000)} · ${derniere.type === "complete" ? "complète" : "incrémentielle"} · ${taille(derniere.taille)}`);
  else etat = el("span", { class: "pastille neutre" }, "Aucune sauvegarde pour l'instant");
  const prochaine = !e.actif ? "Automatique coupé : seulement à la main."
    : e.prochaine ? `Prochaine : ${dateCourte(e.prochaine)} · ${e.prochaine_complete ? "complète" : "incrémentielle"}` : "";
  const lancer = async (complete) => {
    try {
      await api(`/api/sauvegardes/${e.id}/lancer`, { methode: "POST", corps: { complete } });
      toast(complete ? "Sauvegarde complète lancée." : "Sauvegarde lancée.");
      recharger();
    } catch (err) {
      toast(err.message);
    }
  };
  return el("div", { class: "sv-carte" },
    el("div", { class: "sv-tete" },
      el("div", { class: "corps" }, el("strong", {}, e.nom, e.chiffre ? el("span", { class: "etiquette sv-chiffre", title: "Chiffrées avant de partir" }, "Chiffrées") : null),
        el("div", { class: "doux petit" }, `${e.description}${e.libre != null ? ` · ${taille(e.libre)} libres` : ""}`)),
      el("button", { class: "lien", title: `Endroit n° ${e.id}`, onclick: () => formulaire(e, recharger, null, fournisseurs) }, "Modifier")),
    el("p", { class: "petit sv-plan" }, e.resume),
    el("div", { class: "sv-etat" }, etat, prochaine ? el("span", { class: "doux petit" }, prochaine) : null),
    el("div", { class: "boutons" },
      el("button", { disabled: e.en_cours || !e.joignable, onclick: () => lancer(false) }, "Sauvegarder maintenant"),
      el("button", { disabled: e.en_cours || !e.joignable, onclick: () => lancer(true) }, "Complète maintenant"),
      el("button", { class: "lien", disabled: !e.sauvegardes.length, onclick: () => historique(e) },
        `Historique (${e.sauvegardes.length})`)));
}

export async function blocSauvegardes(cible) {
  const zone = el("div", { class: "liste-carte sv-zone" });
  let suivi = null;
  async function dessiner() {
    let donnees;
    try {
      donnees = await api("/api/sauvegardes");
      donneesConnues = donnees;
    } catch (err) {
      zone.replaceChildren(el("p", { class: "erreur" }, err.message));
      return;
    }
    zone.replaceChildren(
      ...(donnees.endroits.length ? donnees.endroits.map((e) => carte(e, dessiner, donnees.fournisseurs))
        : [el("p", { class: "doux br-vide" }, "Aucun endroit de sauvegarde. Disque externe, NAS Synology, partage réseau, Google Drive, kDrive, Nextcloud, S3, SFTP…")]),
      el("p", { class: "doux petit sv-contenu" }, "Copié : la base de Poste (tâches, agenda, mails classés, réglages), tes Fichiers, les documents joints et poste.toml. Pas copié : draw.io, l'APK et l'index de recherche, qui se reconstruisent."));
    // Une sauvegarde en cours : on suit jusqu'à la fin, tant que la page est affichée.
    // (La page n'est insérée qu'après le premier dessin : on vérifie au moment de relire.)
    clearTimeout(suivi);
    if (donnees.endroits.some((e) => e.en_cours || e.chargement)) suivi = setTimeout(() => { if (zone.isConnected) dessiner(); }, 2000);
  }
  let donneesConnues = null;
  cible.append(el("section", {}, el("h2", { class: "h2-lien" }, "Sauvegardes",
    el("button", { class: "lien", onclick: async () => {
      donneesConnues = donneesConnues || await api("/api/sauvegardes");
      choisirFournisseur(donneesConnues.fournisseurs, donneesConnues.rclone, dessiner);
    } }, "+ Ajouter un endroit")), zone));
  await dessiner();
}
