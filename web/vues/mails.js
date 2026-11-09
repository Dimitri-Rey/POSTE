import { api, el, fenetre, moduleActif, quand, toast, vide } from "../js/outils.js";
import { boutonMicro } from "../js/micro.js";
import { marquerVu, relancerMails, verifierMails } from "../js/veille-mails.js";

const PUBLICS = new Set(["gmail.com", "googlemail.com", "outlook.com", "outlook.fr", "hotmail.com", "hotmail.fr", "live.fr", "yahoo.com", "yahoo.fr", "orange.fr", "free.fr", "sfr.fr", "wanadoo.fr", "laposte.net", "icloud.com", "protonmail.com", "proton.me"]);

const nomExpediteur = (de) => (de.match(/^"?([^"<]+?)"?\s*</) || [null, de])[1];

function formulaireBrouillon(comptes, valeurs, surFin) {
  const compte = el("select", { "aria-label": "Depuis" },
    comptes.map((c) => el("option", { value: c.id, selected: c.id === valeurs.compte }, c.adresse)));
  const a = el("input", { placeholder: "À", value: valeurs.a || "", "aria-label": "Destinataire" });
  const sujet = el("input", { placeholder: "Objet", value: valeurs.sujet || "", "aria-label": "Objet" });
  const corps = el("textarea", { rows: 8, placeholder: "Message", "aria-label": "Message" });
  corps.value = valeurs.corps || "";
  const message = el("p", { class: "petit" });
  return el("form", {
    class: "pile",
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api("/api/mails/brouillon", { methode: "POST", corps: {
          compte: compte.value, a: a.value, sujet: sujet.value, corps: corps.value, en_reponse_a: valeurs.en_reponse_a || null,
        } });
        message.textContent = `Brouillon déposé dans ${r.depose_dans}. À toi de le relire et de l'envoyer.`;
        surFin?.();
      } catch (err) {
        message.textContent = err.message;
      }
    },
  }, compte, a, el("div", { class: "champ-micro" }, sujet, boutonMicro(sujet)), el("div", { class: "champ-micro" }, corps, boutonMicro(corps, { etiquette: "Dicter le message" })), el("button", { class: "plein" }, "Déposer en brouillon"), message,
  el("p", { class: "doux petit" }, "Poste n'envoie jamais de mail."));
}

const ouvrirLien = (url) => {
  // Dans l'APK, naviguer vers un autre site ouvre le navigateur du téléphone.
  if (window.Capacitor?.isNativePlatform?.()) location.href = url;
  else window.open(url, "_blank", "noopener");
};

// Un texte de lien qui ressemble à une adresse mais mène ailleurs : ruse classique, on demande.
function lienTrompeur(texte, url) {
  const montre = texte.trim().match(/^(?:https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,})(?:[/?#\s]|$)/i);
  if (!montre) return false;
  try {
    const vrai = new URL(url).hostname.replace(/^www\./, "");
    return montre[1].toLowerCase().replace(/^www\./, "") !== vrai;
  } catch {
    return true;
  }
}

function surCliqueLien(e, suspect, avis) {
  const lien = e.target.closest?.("a[href]");
  if (!lien) return;
  e.preventDefault();
  const url = lien.href;
  if (!/^(https?|mailto|tel):/i.test(url)) return;
  if (suspect) {
    avis.textContent = `Lien désactivé sur un mail suspect. Il mène vers : ${url}`;
    avis.hidden = false;
    return;
  }
  if (lienTrompeur(lien.textContent, url) && !confirm(`Ce lien n'ouvre pas le site affiché.\nIl mène vers : ${url}\n\nL'ouvrir quand même ?`)) return;
  ouvrirLien(url);
}

// Le mail vit dans un cadre isolé (voir politique_mail côté serveur) : cette page le dimensionne et gère ses liens.
function cadreMail(adresse, m) {
  const avis = el("p", { class: "petit alerte", hidden: true, role: "status" });
  const cadre = el("iframe", {
    class: "cadre-mail", title: "Contenu du mail", sandbox: "allow-same-origin", referrerpolicy: "no-referrer",
  });
  const ajuster = () => {
    const doc = cadre.contentDocument;
    if (!doc?.body) return;
    // Mail plus large que l'écran (souvent 600 px) : on réduit l'ensemble plutôt que de le couper.
    doc.body.style.zoom = "";
    const largeur = doc.documentElement.scrollWidth;
    const dispo = cadre.clientWidth;
    if (largeur > dispo + 1) doc.body.style.zoom = String(dispo / largeur);
    cadre.style.height = `${doc.documentElement.scrollHeight + cadre.offsetHeight - cadre.clientHeight}px`;
  };
  cadre.addEventListener("load", () => {
    const doc = cadre.contentDocument;
    if (!doc?.body) return;
    doc.addEventListener("click", (e) => surCliqueLien(e, m.analyse.niveau === "dangereux", avis));
    ajuster();
    doc.querySelectorAll("img").forEach((i) => i.addEventListener("load", ajuster));
    new ResizeObserver(ajuster).observe(cadre);
  });
  cadre.src = adresse;
  return { cadre, avis };
}

function corpsMail(compte, uid, m) {
  if (!m.a_html) return el("div", { class: "corps-mail" }, m.texte);
  const adresse = `/api/mails/${encodeURIComponent(compte)}/${uid}/html`;
  const { cadre, avis } = cadreMail(adresse, m);
  const offrirImages = m.images_distantes && m.analyse.niveau === "sain";
  const barre = m.images_distantes ? el("div", { class: "barre-images petit doux" },
    el("span", {}, m.analyse.niveau !== "sain" ? "Images bloquées : mail suspect." : "Images bloquées pour que l'expéditeur ne sache pas que tu as ouvert ce mail."),
    offrirImages ? el("button", {
      class: "lien petit",
      onclick: () => {
        barre.remove();
        cadre.src = `${adresse}?images=true`;
      },
    }, "Afficher les images") : null) : null;
  return el("div", { class: "mail-html" }, barre, cadre, avis);
}

function panneauVerdict(v) {
  if (v.niveau === "sain") return null;
  const danger = v.niveau === "dangereux";
  return el("div", { class: `alerte-mail${danger ? "" : " doute"}` },
    el("strong", {}, danger ? "Très probablement une arnaque ou du spam" : "Mail douteux, reste prudent"),
    v.raisons.map((r) => el("div", { class: "petit" }, r)),
    danger ? el("div", { class: "petit" }, "Liens désactivés et images bloquées.") : null);
}

// Rien ne part sans un « Oui » explicite. Le mail n'est jamais supprimé : il va dans Spam, et tout blocage se retire.
function actionsMail(compte, uid, m) {
  const zone = el("div", { class: "actions-mail" });
  const domaine = m.expediteur.split("@")[1] || "";
  const resultat = (noeuds) => zone.replaceChildren(...noeuds);
  const decision = (question, details, faire) => {
    const non = el("button", { onclick: dessiner }, "Non");
    const oui = el("button", {
      class: "plein",
      onclick: async () => {
        oui.disabled = true;
        non.disabled = true;
        try {
          resultat(await faire());
        } catch (err) {
          resultat([el("p", { class: "erreur" }, err.message), el("button", { onclick: dessiner }, "Revenir")]);
        }
      },
    }, "Oui");
    resultat([el("p", {}, question), details ? el("p", { class: "doux petit" }, details) : null, el("div", { class: "boutons" }, oui, non)]);
  };
  const fournisseur = () => (m.lien_fournisseur ? el("p", { class: "petit" },
    el("a", { href: m.lien_fournisseur.url, target: "_blank", rel: "noopener", class: "ambre" }, `Bloquer aussi dans ${m.lien_fournisseur.nom}`)) : null);
  const bloquer = (motif, libelle) => decision(`Bloquer ${libelle} ?`,
    "Ajout sur ton serveur Mailcow, mail actuel déplacé dans Spam, et ses prochains mails rangés dans Spam sur toutes tes boîtes.",
    async () => {
      const r = await api("/api/mails/bloques", { methode: "POST", corps: { motif, compte, uid: Number(uid) } });
      return [
        el("p", {}, `${libelle} est bloqué. Mail déplacé dans Spam.`),
        el("p", { class: r.sur_serveur ? "doux petit" : "erreur petit" }, r.sur_serveur ? "Bloqué aussi sur le serveur Mailcow." : "Le serveur Mailcow n'a pas confirmé : blocage actif dans Poste seulement."),
        fournisseur(), el("a", { href: "#mails", class: "ambre petit" }, "Retour aux mails"),
      ];
    });
  // Classement de l'expéditeur : effet immédiat sur ses mails déjà là, et règle pour les suivants.
  const regler = async (important, libelle) => {
    await api("/api/mails/importance", { methode: "PUT", corps: { motif: m.expediteur, important } });
    m.importance.choix = important;
    resultat([el("p", {}, libelle), el("button", { onclick: dessiner }, "Revenir")]);
  };
  function dessiner() {
    const choix = m.importance?.choix;
    resultat([el("div", { class: "boutons" },
      m.expediteur && choix !== true ? el("button", { onclick: () => regler(true, `Les mails de ${m.expediteur} seront toujours importants.`) }, "Toujours important") : null,
      m.expediteur && choix !== false ? el("button", { onclick: () => regler(false, `Les mails de ${m.expediteur} ne seront plus jamais importants.`) }, "Jamais important") : null,
      m.expediteur && choix != null ? el("button", { onclick: () => regler(null, "Retour au classement automatique.") }, "Classement automatique") : null,
      el("button", {
        onclick: () => decision("Déplacer ce mail dans Spam ?", null, async () => {
          await api(`/api/mails/${encodeURIComponent(compte)}/${uid}/spam`, { methode: "POST" });
          return [el("p", {}, "Mail déplacé dans Spam."), fournisseur(), el("a", { href: "#mails", class: "ambre petit" }, "Retour aux mails")];
        }),
      }, "Mettre en spam"),
      m.expediteur ? el("button", { onclick: () => bloquer(m.expediteur, m.expediteur) }, "Bloquer l'expéditeur") : null,
      domaine && !PUBLICS.has(domaine) ? el("button", { onclick: () => bloquer(`*@${domaine}`, `tout ${domaine}`) }, `Bloquer tout ${domaine}`) : null)]);
  }
  dessiner();
  return zone;
}

async function blocageListe(zone) {
  const liste = await api("/api/mails/bloques").catch(() => []);
  zone.replaceChildren(...(liste.length ? liste.map((b) => el("div", { class: "ligne" },
    el("span", { class: "corps mono" }, b.motif),
    el("span", { class: "doux petit" }, b.sur_serveur ? "Serveur + Poste" : "Poste"),
    el("button", {
      class: "lien petit",
      onclick: async () => {
        await api(`/api/mails/bloques?motif=${encodeURIComponent(b.motif)}`, { methode: "DELETE" });
        blocageListe(zone);
      },
    }, "Débloquer"))) : [vide("Aucun expéditeur bloqué.")]));
}

// L'IA rédige à partir du thème ; le texte reste modifiable, et seul l'utilisateur le dépose puis l'envoie.
function reponseIA(compte, uid, comptes, valeurs) {
  const theme = el("textarea", { rows: 2, placeholder: "De quoi doit parler la réponse ? Ex. : j'accepte, mais plutôt à 15 h", "aria-label": "Thème de la réponse" });
  const etat = el("p", { class: "petit", role: "status" });
  const resultat = el("div", {});
  const bouton = el("button", { class: "plein" }, "Générer la réponse");
  return el("div", { class: "pile" }, el("form", {
    class: "pile",
    onsubmit: async (e) => {
      e.preventDefault();
      if (!theme.value.trim()) return;
      bouton.disabled = true;
      etat.textContent = "L'IA rédige…";
      try {
        const r = await api(`/api/mails/${encodeURIComponent(compte)}/${uid}/reponse-ia`, { methode: "POST", corps: { theme: theme.value } });
        etat.textContent = "Relis et modifie si besoin. Change le thème pour en générer une autre.";
        bouton.textContent = "Générer une autre réponse";
        resultat.replaceChildren(formulaireBrouillon(comptes, { ...valeurs, corps: r.corps }));
      } catch (err) {
        etat.textContent = err.message;
      } finally {
        bouton.disabled = false;
      }
    },
  }, el("div", { class: "champ-micro" }, theme, boutonMicro(theme)), bouton, etat), resultat);
}

// Un mail → une tâche ou un rendez-vous : l'IA remplit le formulaire, rien n'est créé avant « Ajouter ».
const enLocal = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
function depuisLeMail(genre, compte, uid) {
  const tache = genre === "tache";
  const etat = el("p", { class: "doux petit", role: "status" }, "L'IA lit le mail…");
  const erreur = el("p", { class: "erreur" });
  const titre = el("input", { required: true, maxlength: 300, placeholder: tache ? "Que faut-il faire ?" : "Titre", "aria-label": "Titre", disabled: true });
  const echeance = el("input", { type: "date", "aria-label": "Échéance", disabled: true });
  const debut = el("input", { type: "datetime-local", required: true, "aria-label": "Début", disabled: true });
  const fin = el("input", { type: "datetime-local", "aria-label": "Fin", disabled: true });
  const lieu = el("input", { placeholder: "Lieu (facultatif)", "aria-label": "Lieu", maxlength: 300, disabled: true });
  const notes = el("textarea", { rows: 3, placeholder: "Notes", "aria-label": "Notes", maxlength: 5000, disabled: true });
  const ajouter = el("button", { class: "plein", disabled: true }, tache ? "Ajouter la tâche" : "Ajouter à l'agenda");
  const champ = (texte, c) => el("label", { class: "champ-etiquette" }, el("span", { class: "doux petit" }, texte), c);
  const d = fenetre(tache ? "Créer une tâche" : "Ajouter à l'agenda", el("form", {
    class: "pile",
    onsubmit: async (e) => {
      e.preventDefault();
      erreur.textContent = "";
      ajouter.disabled = true;
      try {
        if (tache) {
          await api("/api/taches", { methode: "POST", corps: { titre: titre.value.trim(), echeance: echeance.value || null, notes: notes.value } });
        } else {
          if (fin.value && fin.value <= debut.value) throw new Error("La fin doit venir après le début.");
          await api("/api/agenda", { methode: "POST", corps: { titre: titre.value.trim(), debut: debut.value, fin: fin.value || null, lieu: lieu.value.trim(), notes: notes.value } });
        }
        d.close();
        toast(tache ? "Tâche ajoutée." : "Rendez-vous ajouté.", "Voir", () => { location.hash = tache ? "#taches" : "#agenda"; });
      } catch (err) {
        erreur.textContent = err.message;
        ajouter.disabled = false;
      }
    },
  }, etat, champ("Titre", titre), ...(tache ? [champ("Échéance", echeance)] : [champ("Début", debut), champ("Fin", fin), lieu]), notes, erreur,
  el("div", { class: "boutons" }, ajouter, el("button", { type: "button", onclick: () => d.close() }, "Annuler"))));
  const remplir = (r, message) => {
    titre.value = r.titre || "";
    notes.value = r.notes || "";
    if (tache) echeance.value = r.echeance || "";
    else {
      // Sans date trouvée : demain 9 h, à vérifier.
      const depart = r.date ? new Date(`${r.date}T${r.heure || "09:00"}`) : new Date(new Date().setHours(33, 0, 0, 0));
      debut.value = enLocal(depart);
      fin.value = enLocal(new Date(depart.getTime() + (r.duree_minutes || 60) * 60e3));
      lieu.value = r.lieu || "";
    }
    [titre, echeance, debut, fin, lieu, notes, ajouter].forEach((c) => { c.disabled = false; });
    etat.textContent = message;
    titre.focus();
  };
  api(`/api/mails/${encodeURIComponent(compte)}/${uid}/proposition`, { methode: "POST", corps: { genre } })
    .then((r) => remplir(r, tache
      ? (r.echeance ? "Proposé par l'IA : relis, modifie si besoin, puis ajoute." : "Proposé par l'IA, sans échéance trouvée dans le mail.")
      : (r.date ? "Proposé par l'IA : vérifie la date et l'heure, puis ajoute." : "L'IA n'a pas trouvé de date : demain 9 h par défaut, à corriger.")))
    .catch((err) => remplir({}, `${err.message} Remplis à la main.`));
  return d;
}

// Grand écran : la liste à gauche, le mail ouvert à droite, sans recharger la liste.
const deuxVolets = () => matchMedia("(min-width: 1100px)").matches;

// Icônes du lecteur (tracés écrits ici, jamais une donnée).
const TRACES = {
  retour: '<path d="M15 5l-7 7 7 7"/>',
  repondre: '<path d="M10 8 5 12l5 4"/><path d="M5 12h9a5 5 0 0 1 5 5v1"/>',
  ia: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/>',
  plus: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  tache: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  agenda: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
  piece: '<path d="M20 11.5 12.5 19a5 5 0 0 1-7-7l8-8a3.3 3.3 0 0 1 4.7 4.7l-8 8a1.7 1.7 0 0 1-2.4-2.4l7.3-7.3"/>',
};
function icone(nom) {
  const s = el("span", { class: "icone", "aria-hidden": "true" });
  s.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${TRACES[nom]}</svg>`;
  return s;
}
const dateMail = (ts) => {
  const d = new Date(ts * 1000);
  const auj = new Date();
  const heure = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === auj.toDateString()) return `Aujourd'hui, ${heure}`;
  const hier = new Date(auj); hier.setDate(auj.getDate() - 1);
  if (d.toDateString() === hier.toDateString()) return `Hier, ${heure}`;
  return `${d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === auj.getFullYear() ? undefined : "numeric" })}, ${heure}`;
};

// Lecteur : barre d'outils, objet, expéditeur, alerte éventuelle, contenu dans une carte,
// puis les réponses à portée de pouce. Répondre et les actions s'ouvrent dans des feuilles.
async function lecture(cible, compte, uid, comptes, enVolet = false) {
  const m = await api(`/api/mails/${encodeURIComponent(compte)}/${uid}`);
  const enReponse = () => ({
    compte, a: (m.de.match(/<([^>]+)>/) || [null, m.de])[1], sujet: /^re\s*:/i.test(m.sujet) ? m.sujet : `Re: ${m.sujet}`, en_reponse_a: m.message_id,
  });
  const nom = nomExpediteur(m.de).trim();
  const adresse = (m.de.match(/<([^>]+)>/) || [null, ""])[1];
  const dangereux = m.analyse.niveau === "dangereux";
  const repondre = () => fenetre("Répondre", formulaireBrouillon(comptes, enReponse()));
  const repondreIA = () => fenetre("Réponse IA", reponseIA(compte, uid, comptes, enReponse()));
  const autres = () => fenetre("Plus d'actions", actionsMail(compte, uid, m));
  const outil = (nomIcone, etiquette, faire, extra = "") => el("button", { class: `outil-mail ${extra}`, type: "button", title: etiquette, "aria-label": etiquette, onclick: faire }, icone(nomIcone));
  cible.append(el("article", { class: `page lecture lecteur${enVolet ? " en-volet" : ""}` },
    el("div", { class: "barre-lecteur" },
      enVolet ? el("span", {}) : el("a", { href: "#mails", class: "outil-mail retour", "aria-label": "Retour aux mails", title: "Retour aux mails" }, icone("retour"), el("span", { class: "texte-retour" }, "Mails")),
      el("span", { class: "espace" }),
      dangereux ? null : outil("repondre", "Répondre", repondre),
      dangereux ? null : outil("ia", "Réponse IA", repondreIA),
      dangereux || !moduleActif("taches") ? null : outil("tache", "Créer une tâche", () => depuisLeMail("tache", compte, uid)),
      dangereux || !moduleActif("agenda") ? null : outil("agenda", "Ajouter à l'agenda", () => depuisLeMail("rdv", compte, uid)),
      outil("plus", "Plus d'actions", autres)),
    el("h1", { class: "objet-mail" }, m.sujet || "(sans objet)"),
    el("div", { class: "expediteur-mail" },
      el("span", { class: "initiale grande", "aria-hidden": "true" }, (nom.charAt(0) || "?").toUpperCase()),
      el("div", { class: "qui" },
        el("div", { class: "qui-tete" }, el("strong", {}, nom || adresse), el("span", { class: "doux petit num" }, dateMail(m.ts))),
        adresse && adresse !== nom ? el("div", { class: "doux petit" }, adresse) : null,
        m.a ? el("div", { class: "doux petit" }, `À ${m.a}`) : null,
        // Pourquoi ce mail est (ou n'est pas) dans « Mails importants » : se règle dans « ⋯ ».
        m.importance?.pourquoi ? el("div", { class: `importance-mail petit${m.importance.important ? " oui" : ""}` },
          m.importance.important ? "Important · " : "Pas important · ", m.importance.pourquoi) : null)),
    panneauVerdict(m.analyse),
    m.pieces_jointes.length ? el("div", { class: "pieces" }, m.pieces_jointes.map((p) => el("span", { class: "piece" }, icone("piece"), el("span", {}, p)))) : null,
    el("div", { class: `contenu-mail${m.a_html ? " html" : ""}` }, corpsMail(compte, uid, m)),
    dangereux ? null : el("div", { class: "reponses-mail" },
      el("button", { class: "plein", onclick: repondreIA }, icone("ia"), "Réponse IA"),
      el("button", { onclick: repondre }, icone("repondre"), "Répondre"))));
}

// Le point du jour, rédigé par l'IA : urgences, importants, bonnes et mauvaises nouvelles. Les chiffres sont comptés
// par Poste. Refait tout seul s'il date d'un autre jour ou si des mails sont arrivés depuis plus d'un quart d'heure.
const LISTES_POINT = [["urgences", "Urgent"], ["importants", "Important"], ["bonnes", "Bonnes nouvelles"], ["mauvaises", "Mauvaises nouvelles"]];
const AUTO_APRES = 15 * 60;
const nombre = (n, mot, pluriel = `${mot}s`) => `${n} ${n > 1 ? pluriel : mot}`;

function chiffresPoint(c) {
  const case_ = (periode, x) => el("div", { class: "point-chiffre" },
    el("div", { class: "point-periode" }, periode),
    el("div", { class: "point-nombre num" }, String(x.total), el("span", {}, x.total > 1 ? " mails" : " mail")),
    el("div", { class: "point-detail num" }, x.total ? [nombre(x.non_lus, "non lu", "non lus"), x.importants ? nombre(x.importants, "important") : null].filter(Boolean).join(" · ") : "rien de neuf"));
  return el("div", { class: "point-chiffres" }, case_("Aujourd'hui", c.jour), case_("7 derniers jours", c.semaine));
}

const heure = (ts) => new Date(ts * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const aujourdhui = () => new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });

function blocPoint(ouvrir) {
  const zone = el("details", {
    class: "point-mails", open: localStorage.getItem("poste-point-ferme") !== "1",
    ontoggle: () => localStorage.setItem("poste-point-ferme", zone.open ? "0" : "1"),
  });
  let dernier = null;
  let enCours = false;
  const dessiner = (message = "", erreur = false) => {
    const p = dernier?.point;
    const g = dernier?.genere_le;
    const quandFait = g ? `${new Date(g * 1000).toDateString() === new Date().toDateString() ? "" : `le ${quand(g)} `}à ${heure(g)}` : "";
    const etat = !p ? "attente" : p.urgent ? "urgent" : "calme";
    const actualiser = el("button", { class: "lien petit", type: "button", disabled: enCours, onclick: (e) => { e.preventDefault(); refaire(); } }, enCours ? "Préparation…" : "Actualiser");
    const action = (nom, etiquette, genre, e) => {
      const b = el("button", { type: "button", class: "point-action", title: etiquette, "aria-label": `${etiquette} : ${e.de}`, onclick: () => depuisLeMail(genre, e.compte, e.uid) });
      b.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TRACES[nom]}</svg>`;
      return b;
    };
    const lien = (e) => el("div", { class: "point-element" }, el("a", {
      class: `point-mail${e.lu ? "" : " non-lu"}`, href: `#mails/${e.compte}/${e.uid}`,
      onclick: (ev) => ouvrir(ev, e.compte, e.uid),
    }, el("span", { class: "point-pastille", title: e.lu ? "Lu" : "Non lu", "aria-label": e.lu ? "lu" : "non lu" }),
    el("span", { class: "point-texte" }, el("span", { class: "point-qui" }, e.de), el("span", { class: "point-note" }, e.note || e.sujet))),
    el("span", { class: "point-actions" },
      moduleActif("taches") ? action("tache", "Créer une tâche", "tache", e) : null,
      moduleActif("agenda") ? action("agenda", "Ajouter à l'agenda", "rdv", e) : null));
    zone.replaceChildren(
      el("summary", {},
        el("div", { class: "point-ligne" },
          el("span", { class: "point-tete" }, "Le point"),
          el("span", { class: "point-date" }, aujourdhui())),
        el("div", { class: `point-titre ${etat}` }, p ? p.titre : (enCours ? "Lecture des mails…" : "Pas encore de point"))),
      el("div", { class: "point-corps" },
        dernier?.chiffres ? chiffresPoint(dernier.chiffres) : null,
        p && (p.aujourdhui || p.semaine) ? el("dl", { class: "point-recit" },
          p.aujourdhui ? [el("dt", {}, "Aujourd'hui"), el("dd", {}, p.aujourdhui)] : null,
          p.semaine ? [el("dt", {}, "La semaine"), el("dd", {}, p.semaine)] : null) : null,
        p ? LISTES_POINT.filter(([cle]) => p[cle]?.length).map(([cle, titre]) => el("section", { class: `point-liste ${cle}` },
          el("h3", { class: "titre-groupe" }, titre, el("span", { class: "point-compte num" }, String(p[cle].length))), p[cle].map(lien))) : null,
        message ? el("p", { class: erreur ? "erreur" : "doux petit", role: "status" }, message) : null,
        el("div", { class: "point-pied doux petit" },
          el("span", {}, p ? `Rédigé par l'IA ${quandFait}${dernier.a_jour ? "" : " · des mails sont arrivés depuis"}` : "Rédigé par l'IA à partir des mails des 7 derniers jours"),
          actualiser)));
  };
  async function refaire() {
    if (enCours) return;
    enCours = true;
    dessiner(dernier?.point ? "Nouveau point en préparation…" : "L'IA lit les mails de la semaine…");
    try {
      dernier = await api("/api/mails/point", { methode: "POST" });
      enCours = false;
      dessiner();
    } catch (err) {
      enCours = false;
      dessiner(err.message, true);
    }
  }
  async function charger() {
    if (enCours) return;
    try {
      dernier = await api("/api/mails/point");
    } catch (err) {
      dessiner(err.message, true);
      return;
    }
    const vieux = !dernier.genere_le || new Date(dernier.genere_le * 1000).toDateString() !== new Date().toDateString()
      || Date.now() / 1000 - dernier.genere_le > AUTO_APRES;
    if (dernier.en_cours || (!dernier.a_jour && vieux)) refaire();
    else dessiner();
  }
  return { noeud: zone, charger };
}

export async function vueMails(cible) {
  const [, compteLu, uid] = location.hash.slice(1).split("/");
  const comptes = await api("/api/mails/comptes");
  const volets = deuxVolets();
  if (compteLu && uid && !volets) {
    await lecture(cible, compteLu, uid, comptes);
    return;
  }
  const voletLecture = el("div", { class: "volet-lecture" });
  let ouvert = compteLu && uid ? `${compteLu}/${uid}` : null;
  async function ouvrirDansVolet(compte, id) {
    ouvert = `${compte}/${id}`;
    liste.querySelectorAll(".mail").forEach((l) => l.classList.toggle("actif", l.dataset.cle === ouvert));
    liste.querySelector(`.mail[data-cle="${CSS.escape(ouvert)}"]`)?.classList.remove("non-lu");
    voletLecture.replaceChildren(el("p", { class: "doux" }, "Ouverture…"));
    const contenu = document.createDocumentFragment();
    try {
      await lecture(contenu, compte, id, comptes, true);
    } catch (err) {
      contenu.append(el("p", { class: "erreur" }, err.message));
    }
    if (ouvert === `${compte}/${id}`) voletLecture.replaceChildren(contenu);
  }
  const liste = el("div", {});
  const filtre = el("select", { "aria-label": "Boîte", onchange: charger },
    el("option", { value: "" }, "Toutes les boîtes"),
    comptes.map((c) => el("option", { value: c.id }, c.adresse)));
  const recherche = el("input", { type: "search", placeholder: "Chercher", "aria-label": "Chercher", onchange: charger });
  const nouveau = el("div", {});
  const zoneBloques = el("div", {});
  const point = blocPoint((e, compte, id) => {
    if (!volets || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    history.pushState(null, "", `#mails/${compte}/${id}`);
    ouvrirDansVolet(compte, id);
  });

  // Mails arrivés depuis le dernier affichage : signalés un instant, en haut de la liste.
  let affiches = null;
  async function charger() {
    const params = new URLSearchParams();
    if (filtre.value) params.set("compte", filtre.value);
    if (recherche.value) params.set("q", recherche.value);
    const mails = await api(`/api/mails?${params}`);
    const avant = affiches;
    affiches = new Set(mails.map((m) => `${m.compte}/${m.uid}`));
    liste.replaceChildren(...(mails.length ? mails.map((m) => el("a", {
      class: `ligne mail${m.lu ? "" : " non-lu"}${ouvert === `${m.compte}/${m.uid}` ? " actif" : ""}${avant && !avant.has(`${m.compte}/${m.uid}`) ? " arrive" : ""}`, href: `#mails/${m.compte}/${m.uid}`,
      "data-cle": `${m.compte}/${m.uid}`,
      onclick: (e) => {
        if (!volets || e.ctrlKey || e.metaKey) return;
        // L'adresse change sans redessiner la page : la liste garde sa place.
        e.preventDefault();
        history.pushState(null, "", `#mails/${m.compte}/${m.uid}`);
        ouvrirDansVolet(m.compte, m.uid);
      },
    },
    el("span", { class: "initiale", "aria-hidden": "true" }, (nomExpediteur(m.de).trim().charAt(0) || "?").toUpperCase()),
    el("span", { class: "corps" },
      el("span", { class: "mail-tete" }, el("span", { class: "expediteur" }, nomExpediteur(m.de)), el("span", { class: "quand num" }, quand(m.ts))),
      el("span", { class: "titre" }, m.sujet),
      el("div", { class: "doux petit compte-mail" }, m.compte),
      m.alertes.length ? el("div", { class: "alerte petit" }, "Suspect") : null))) : [vide("Aucun mail. La première synchronisation peut prendre quelques minutes.")]));
  }

  const colonneListe = el("div", { class: "colonne-liste" });
  cible.append(el("div", { class: `page mails${volets ? " deux-volets" : ""}` },
    el("div", { class: "tete" }, el("h1", {}, "Mails"),
      el("button", {
        class: "plein bouton-principal",
        onclick: () => { nouveau.replaceChildren(formulaireBrouillon(comptes, { compte: comptes[0]?.id })); nouveau.scrollIntoView({ behavior: "smooth" }); },
      }, "Nouveau brouillon")),
    nouveau,
    volets ? el("div", { class: "volets-mails" }, colonneListe, voletLecture) : colonneListe));
  // État de la synchro, et rechargement tout seul quand la liste change sur le serveur (veille-mails.js).
  const etatSynchro = el("span", { class: "doux petit" }, "Vérification des boîtes…");
  const actualiser = el("button", { class: "lien petit", type: "button", onclick: () => { etatSynchro.textContent = "Vérification des boîtes…"; relancerMails(); } }, "Vérifier maintenant");
  // La vue n'entre dans la page qu'après son retour : on ne se retire qu'une fois montée puis démontée.
  let montee = false;
  const demontee = () => { if (liste.isConnected) { montee = true; return false; } return montee; };
  const surEtat = (e) => {
    if (demontee()) { window.removeEventListener("poste:mails-etat", surEtat); return; }
    const t = e.detail.synchro_le;
    if (t) etatSynchro.textContent = `À jour à ${new Date(t * 1000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  };
  const surChange = () => {
    if (demontee()) { window.removeEventListener("poste:mails", surChange); return; }
    if (montee) { charger(); point.charger(); }
  };
  window.addEventListener("poste:mails-etat", surEtat);
  window.addEventListener("poste:mails", surChange);
  marquerVu();
  relancerMails();
  colonneListe.append(
    point.noeud,
    el("div", { class: "etat-mails" }, etatSynchro, actualiser),
    el("div", { class: "filtres" }, filtre, recherche),
    el("div", { class: "liste-carte liste-mails" }, liste),
    el("details", { class: "bloques", ontoggle: (e) => { if (e.target.open) blocageListe(zoneBloques); } },
      el("summary", {}, "Expéditeurs bloqués"), zoneBloques));
  if (volets) {
    if (ouvert) ouvrirDansVolet(compteLu, uid);
    else voletLecture.replaceChildren(vide("Choisis un mail dans la liste."));
  }
  // Venu de l'accueil (« + Brouillon ») : le formulaire est déjà ouvert.
  if (sessionStorage.getItem("poste-nouveau-brouillon")) {
    sessionStorage.removeItem("poste-nouveau-brouillon");
    nouveau.replaceChildren(formulaireBrouillon(comptes, { compte: comptes[0]?.id }));
  }
  point.charger();
  await charger();
  setTimeout(verifierMails, 0);
}
