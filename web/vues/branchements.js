import { api, el, fenetre, moduleActif, quand, toast } from "../js/outils.js";

// Branchements de Poste, réglés depuis la page Réglages : boîtes mail, agendas, IA, dictée, notifications, modules.
// Les mots de passe partent au serveur (coffre chiffré) et n'en reviennent jamais : on sait seulement s'ils sont définis.

const ligne = (titre, aide, champ) => el("div", { class: "reglage" },
  el("div", {}, el("strong", {}, titre), aide ? el("p", { class: "doux petit" }, aide) : null), champ);

const interrupteur = (etiquette, coche, auChangement) => el("input", {
  type: "checkbox", role: "switch", class: "interrupteur", "aria-label": etiquette, checked: coche, onchange: auChangement,
});

const champ = (etiquette, attributs = {}) => el("label", { class: "br-champ" }, el("span", { class: "doux petit" }, etiquette),
  el("input", { "aria-label": etiquette, autocomplete: "off", ...attributs }));
const valeur = (label) => label.querySelector("input").value.trim();

// Un bouton qui attend la réponse : désactivé et « … » pendant l'essai, puis le message dans la zone prévue.
async function attendre(bouton, message, action) {
  const texte = bouton.textContent;
  bouton.disabled = true;
  bouton.textContent = "Connexion…";
  message.className = "doux petit br-message";
  message.textContent = "";
  try {
    return await action();
  } catch (err) {
    message.className = "erreur br-message";
    message.textContent = err.message;
    return null;
  } finally {
    bouton.disabled = false;
    bouton.textContent = texte;
  }
}

function choixPrereglage(titre, prereglages, choisir) {
  const d = fenetre(titre, el("div", { class: "br-fournisseurs" }, Object.entries(prereglages).map(([id, p]) =>
    el("button", { type: "button", class: "br-fournisseur", onclick: () => { d.close(); choisir(id, p); } }, p.nom))),
  el("div", { class: "boutons" }, el("button", { type: "button", onclick: () => d.close() }, "Annuler")));
}

// --- Comptes mail ---------------------------------------------------------------------------------------------------

function ajouterCompte(prereglages, apres) {
  choixPrereglage("Ajouter une boîte mail", prereglages, (id, p) => {
    const adresse = champ("Adresse mail", { type: "email", required: true, placeholder: "toi@exemple.fr", autocomplete: "email" });
    const mdp = champ("Mot de passe", { type: "password", required: true, autocomplete: "new-password" });
    const nom = champ("Nom affiché (facultatif)", { placeholder: p.nom === "Autre serveur IMAP" ? "Pro, Perso…" : p.nom });
    const hote = champ("Serveur IMAP", { value: p.hote, required: true, placeholder: "imap.exemple.fr", spellcheck: "false" });
    const port = champ("Port", { type: "number", value: String(p.port), min: "1", max: "65535" });
    const utilisateur = champ("Identifiant, s'il diffère de l'adresse", { spellcheck: "false" });
    const serveur = el("details", { class: "br-avance", open: !p.hote }, el("summary", {}, "Réglages du serveur"), hote, port, utilisateur);
    const message = el("p", { class: "doux petit br-message", role: "status" });
    const valider = el("button", { class: "plein" }, "Tester et ajouter");
    const d = fenetre(`Boîte ${p.nom}`, el("form", {
      class: "pile",
      onsubmit: async (ev) => {
        ev.preventDefault();
        const fait = await attendre(valider, message, () => api("/api/connecteurs/mails", { methode: "POST", corps: {
          nom: valeur(nom), adresse: valeur(adresse), mot_de_passe: mdp.querySelector("input").value,
          hote: valeur(hote), port: Number(valeur(port)) || 993, utilisateur: valeur(utilisateur),
        } }));
        if (!fait) return;
        d.close();
        toast("Boîte ajoutée. Les mails arrivent dans un instant.");
        apres();
      },
    }, el("p", { class: "doux petit" }, p.aide), adresse, mdp, nom, serveur, message,
    el("p", { class: "doux petit" }, "Poste lit les mails et dépose des brouillons ; il n'envoie jamais rien. Le mot de passe est chiffré sur le serveur."),
    el("div", { class: "boutons" }, valider, el("button", { type: "button", onclick: () => d.close() }, "Annuler"))));
    adresse.querySelector("input").focus();
  });
}

function blocComptes(etat, recharger) {
  const lignes = etat.comptes.map((c) => el("div", { class: "ligne br-ligne" },
    el("div", { class: "corps" }, el("strong", {}, c.nom || c.adresse), el("div", { class: "doux petit" }, c.nom && c.nom !== c.adresse ? `${c.adresse} · ${c.hote}` : c.hote)),
    c.origine === "fichier" ? el("span", { class: "doux petit" }, "Fichier de configuration")
      : el("button", { class: "lien alerte", onclick: async () => {
        if (!confirm(`Retirer la boîte ${c.adresse} de Poste ? Les mails restent sur le serveur.`)) return;
        await api(`/api/connecteurs/mails/${encodeURIComponent(c.id)}`, { methode: "DELETE" });
        toast("Boîte retirée.");
        recharger();
      } }, "Retirer")));
  return el("section", {}, el("h2", { class: "h2-lien" }, "Boîtes mail",
    el("button", { class: "lien", onclick: () => ajouterCompte(etat.prereglages.mails, recharger) }, "+ Ajouter")),
  el("div", { class: "liste-carte" }, lignes.length ? lignes
    : el("p", { class: "doux br-vide" }, "Aucune boîte branchée. Gmail, Outlook, iCloud, Infomaniak, OVHcloud ou tout serveur IMAP.")));
}

// --- Agendas --------------------------------------------------------------------------------------------------------

function ajouterAgenda(prereglages, apres) {
  choixPrereglage("Brancher un agenda", prereglages, (id, p) => {
    const caldav = p.type === "caldav";
    const nom = champ("Nom", { value: p.nom, required: true });
    const url = champ(caldav ? "Adresse du serveur CalDAV" : "Lien iCal (.ics ou webcal://)",
      { value: p.url, required: true, type: "url", spellcheck: "false", placeholder: caldav ? "https://…" : "https://…/basic.ics" });
    const utilisateur = champ("Identifiant", { required: caldav, autocomplete: "username", spellcheck: "false" });
    const mdp = champ("Mot de passe", { type: "password", required: caldav, autocomplete: "new-password" });
    const acces = caldav ? [utilisateur, mdp] : [el("details", { class: "br-avance" }, el("summary", {}, "Lien protégé par un mot de passe"), utilisateur, mdp)];
    const message = el("p", { class: "doux petit br-message", role: "status" });
    const valider = el("button", { class: "plein" }, "Tester et brancher");
    const d = fenetre(`Agenda ${p.nom}`, el("form", {
      class: "pile",
      onsubmit: async (ev) => {
        ev.preventDefault();
        const fait = await attendre(valider, message, () => api("/api/connecteurs/agendas", { methode: "POST", corps: {
          nom: valeur(nom), type: p.type, url: valeur(url), utilisateur: valeur(utilisateur), mot_de_passe: mdp.querySelector("input").value,
        } }));
        if (!fait) return;
        d.close();
        toast(`Agenda branché : ${fait.evenements} événement${fait.evenements > 1 ? "s" : ""}.`);
        apres();
      },
    }, el("p", { class: "doux petit" }, p.aide), nom, url, ...acces, message,
    el("p", { class: "doux petit" }, "Lecture seule : les événements s'affichent dans l'Agenda et se mettent à jour tous les quarts d'heure."),
    el("div", { class: "boutons" }, valider, el("button", { type: "button", onclick: () => d.close() }, "Annuler"))));
    url.querySelector("input").focus();
  });
}

function blocAgendas(etat, recharger) {
  const lignes = etat.agendas.map((a) => {
    const message = el("span", { class: a.erreur ? "erreur" : "doux petit" },
      a.erreur || `${a.evenements} événement${a.evenements > 1 ? "s" : ""}${a.synchro_le ? ` · à jour ${quand(a.synchro_le)}` : ""}`);
    const actualiser = el("button", { class: "lien", onclick: async () => {
      const fait = await attendre(actualiser, message, () => api(`/api/connecteurs/agendas/${a.id}/actualiser`, { methode: "POST" }));
      if (fait) recharger();
    } }, "Actualiser");
    return el("div", { class: "ligne br-ligne" },
      el("div", { class: "corps" }, el("strong", {}, a.nom), el("div", { class: "doux petit" }, `${a.type === "ics" ? "iCal" : "CalDAV"} · ${a.hote}`), message),
      el("span", { class: "br-actions" }, actualiser, el("button", { class: "lien alerte", onclick: async () => {
        if (!confirm(`Débrancher l'agenda « ${a.nom} » ? Ses événements disparaissent de Poste, pas de l'agenda d'origine.`)) return;
        await api(`/api/connecteurs/agendas/${a.id}`, { methode: "DELETE" });
        toast("Agenda débranché.");
        recharger();
      } }, "Retirer")));
  });
  return el("section", {}, el("h2", { class: "h2-lien" }, "Agendas",
    el("button", { class: "lien", onclick: () => ajouterAgenda(etat.prereglages.agendas, recharger) }, "+ Brancher")),
  el("div", { class: "liste-carte" }, lignes.length ? lignes
    : el("p", { class: "doux br-vide" }, "L'agenda de Poste fonctionne seul. Tu peux aussi y voir Google Agenda, Outlook, iCloud, Nextcloud ou Fastmail.")));
}

// --- IA, dictée, notifications --------------------------------------------------------------------------------------

const MOTEURS_IA = [
  ["Ollama", "http://127.0.0.1:11434"], ["LM Studio", "http://127.0.0.1:1234"], ["vLLM", "http://127.0.0.1:8000"],
  ["llama.cpp", "http://127.0.0.1:8080"], ["LiteLLM", "http://127.0.0.1:4000"], ["OpenAI", "https://api.openai.com"],
];

function blocIA(etat) {
  const ia = etat.ia;
  const adresse = champ("Adresse du service", { value: ia.adresse, type: "url", spellcheck: "false" });
  const liste = el("datalist", { id: "br-modeles" });
  const modele = champ("Modèle (vide : le premier proposé)", { value: ia.modele, list: "br-modeles", spellcheck: "false" });
  const cle = champ("Clé d'API (si le service en demande une)", { type: "password", autocomplete: "new-password", placeholder: ia.cle ? "Clé enregistrée" : "" });
  const preset = el("div", { class: "br-puces" }, MOTEURS_IA.map(([nom, url]) => el("button", {
    type: "button", class: "br-puce", onclick: () => { adresse.querySelector("input").value = url; },
  }, nom)));
  const message = el("p", { class: "doux petit br-message", role: "status" });
  const effacer = ia.cle ? el("button", { type: "button", class: "lien alerte", onclick: async () => {
    await api("/api/connecteurs/ia", { methode: "PUT", corps: { adresse: valeur(adresse), modele: valeur(modele), cle: "" } });
    effacer.remove();
    cle.querySelector("input").placeholder = "";
    toast("Clé effacée.");
  } }, "Effacer la clé") : null;
  const valider = el("button", { class: "plein" }, "Enregistrer et tester");
  return el("section", {}, el("h2", {}, "Intelligence artificielle"), el("form", {
    class: "liste-carte bloc-libre pile",
    onsubmit: async (ev) => {
      ev.preventDefault();
      const fait = await attendre(valider, message, async () => {
        const saisie = cle.querySelector("input").value;
        await api("/api/connecteurs/ia", { methode: "PUT", corps: { adresse: valeur(adresse), modele: valeur(modele), ...(saisie ? { cle: saisie } : {}) } });
        return api("/api/connecteurs/ia/tester", { methode: "POST" });
      });
      if (!fait) return;
      cle.querySelector("input").value = "";
      liste.replaceChildren(...fait.modeles.map((m) => el("option", { value: m })));
      message.className = "petit br-message ok";
      message.textContent = `Connecté : ${fait.modeles.length} modèle${fait.modeles.length > 1 ? "s" : ""} (${fait.modeles.slice(0, 3).join(", ")}${fait.modeles.length > 3 ? "…" : ""}).`;
    },
  }, el("p", { class: "doux petit" }, "Pour les rédactions courtes (réponses aux mails, aide à l'écriture). Tout service compatible OpenAI convient, sur ta machine ou en ligne."),
  preset, adresse, modele, liste, cle, message, el("div", { class: "boutons" }, valider, effacer)));
}

function blocDictee(etat, recharger) {
  const dic = etat.dictee;
  const adresse = champ("Adresse du service de transcription", { value: dic.adresse, type: "url", spellcheck: "false" });
  const modele = champ("Modèle (facultatif, ex. Systran/faster-whisper-small)", { value: dic.modele, spellcheck: "false" });
  const message = el("p", { class: "doux petit br-message", role: "status" });
  const actif = interrupteur("Dictée vocale", dic.actif, async (e) => {
    await api("/api/connecteurs/dictee", { methode: "PUT", corps: { actif: e.target.checked, adresse: valeur(adresse), modele: valeur(modele) } });
    toast(e.target.checked ? "Dictée activée : les micros apparaissent après rechargement." : "Dictée coupée.", "Recharger", () => location.reload());
  });
  const valider = el("button", { class: "plein" }, "Enregistrer et tester");
  return el("section", {}, el("h2", {}, "Dictée vocale"), el("form", {
    class: "liste-carte bloc-libre pile",
    onsubmit: async (ev) => {
      ev.preventDefault();
      const fait = await attendre(valider, message, async () => {
        await api("/api/connecteurs/dictee", { methode: "PUT", corps: { adresse: valeur(adresse), modele: valeur(modele) } });
        return api("/api/connecteurs/dictee/tester", { methode: "POST" });
      });
      if (!fait) return;
      message.className = "petit br-message ok";
      message.textContent = "Le service de transcription répond.";
    },
  }, ligne("Micro à côté des champs", "Le son part vers ton service de transcription (compatible OpenAI : Speaches, whisper.cpp, Parakeet…), jamais ailleurs.", actif),
  adresse, modele, message, el("div", { class: "boutons" }, valider)));
}

function blocNotifications(etat) {
  const n = etat.notifications;
  const adresse = champ("Serveur ntfy", { value: n.adresse, type: "url", spellcheck: "false", placeholder: "https://ntfy.sh" });
  const sujet = champ("Sujet (lettres, chiffres, - et _)", { value: n.sujet, spellcheck: "false", pattern: "[A-Za-z0-9_\\-]+" });
  const jeton = champ("Jeton d'accès (facultatif)", { type: "password", autocomplete: "new-password", placeholder: n.jeton ? "Jeton enregistré" : "" });
  const publique = champ("Adresse vue par le téléphone (si différente)", { value: n.adresse_publique, type: "url", spellcheck: "false" });
  const message = el("p", { class: "doux petit br-message", role: "status" });
  const actif = interrupteur("Notifications", n.actif, async (e) => {
    await api("/api/connecteurs/notifications", { methode: "PUT", corps: { actif: e.target.checked, adresse: valeur(adresse), sujet: valeur(sujet), adresse_publique: valeur(publique) } });
    toast(e.target.checked ? "Notifications activées." : "Notifications coupées.");
  });
  const valider = el("button", { class: "plein" }, "Enregistrer et envoyer un essai");
  return el("section", {}, el("h2", {}, "Notifications sur le téléphone"), el("form", {
    class: "liste-carte bloc-libre pile",
    onsubmit: async (ev) => {
      ev.preventDefault();
      const fait = await attendre(valider, message, async () => {
        const saisie = jeton.querySelector("input").value;
        await api("/api/connecteurs/notifications", { methode: "PUT", corps: {
          adresse: valeur(adresse), sujet: valeur(sujet), adresse_publique: valeur(publique), ...(saisie ? { jeton: saisie } : {}),
        } });
        return api("/api/connecteurs/notifications/tester", { methode: "POST" });
      });
      if (!fait) return;
      jeton.querySelector("input").value = "";
      message.className = "petit br-message ok";
      message.textContent = "Essai envoyé : regarde ton téléphone.";
    },
  }, ligne("Nouveaux mails, rappels, alertes", "Par ntfy : installe l'application ntfy et abonne-toi au même sujet. Un sujet sur ntfy.sh est public : choisis un nom difficile à deviner.", actif),
  adresse, sujet, jeton, publique, message, el("div", { class: "boutons" }, valider)));
}

// --- Ce que l'on reçoit -------------------------------------------------------------------------------------------

// Section « Notifications » de Réglages : tout couper, ou choisir type par type. Le branchement ntfy est plus bas.
export async function blocAlertes(cible) {
  let prefs;
  try {
    prefs = await api("/api/connecteurs/alertes");
  } catch (err) {
    cible.append(el("section", {}, el("h2", {}, "Notifications"), el("p", { class: "erreur" }, err.message)));
    return;
  }
  const carte = el("div", { class: "liste-carte alertes" });
  const regler = async (corps, message) => {
    try {
      prefs = await api("/api/connecteurs/alertes", { methode: "PUT", corps });
      toast(message);
    } catch (err) {
      toast(err.message);
    }
    dessiner();
  };
  function dessiner() {
    if (!prefs.branche) {
      carte.replaceChildren(el("p", { class: "doux petit br-vide" },
        "Les notifications ne sont pas encore branchées : règle le serveur ntfy plus bas, dans « Notifications sur le téléphone »."));
      return;
    }
    carte.replaceChildren(
      ligne("Recevoir les notifications", "Tant que Poste est ouvert à l'écran du téléphone, rien ne s'affiche : la notification arrive dès que tu l'as quitté.",
        interrupteur("Recevoir les notifications", prefs.recevoir, (e) => regler({ recevoir: e.target.checked },
          e.target.checked ? "Notifications activées." : "Plus aucune notification."))),
      ...prefs.types.map((t) => {
        const r = ligne(t.nom, t.aide, interrupteur(t.nom, t.actif, (e) => regler({ [t.id]: e.target.checked },
          `${t.nom} : ${e.target.checked ? "activé" : "coupé"}.`)));
        if (!prefs.recevoir) {
          r.classList.add("eteint");
          r.querySelector("input").disabled = true;
        }
        return r;
      }));
  }
  dessiner();
  cible.append(el("section", {}, el("h2", {}, "Notifications"), carte));
}

// Le point des mails : notification du matin (heure, taille) et carte en haut de l'accueil.
const TAILLES_POINT = [["petit", "Petit", "La phrase clé seule : « Rien d'urgent aujourd'hui »."],
  ["moyen", "Moyen", "La phrase clé, puis les mails urgents et importants."],
  ["grand", "Grand", "Tout le point : la journée, la semaine, les urgences, les importants, les bonnes et les mauvaises nouvelles."]];

export async function blocPointMails(cible) {
  if (!moduleActif("mails")) return;
  let r;
  try {
    r = await api("/api/mails/point/reglages");
  } catch (err) {
    cible.append(el("section", {}, el("h2", {}, "Point des mails"), el("p", { class: "erreur" }, err.message)));
    return;
  }
  const carte = el("div", { class: "liste-carte" });
  const regler = async (corps, message) => {
    try {
      r = await api("/api/mails/point/reglages", { methode: "PUT", corps });
      if (message) toast(message);
    } catch (err) {
      toast(err.message);
    }
    dessiner();
  };
  function dessiner() {
    const heure = el("input", {
      type: "time", value: r.heure, "aria-label": "Heure du point", step: 300, disabled: !r.actif,
      onchange: (e) => { if (/^\d{2}:\d{2}$/.test(e.target.value)) regler({ heure: e.target.value }, `Point envoyé chaque jour à ${e.target.value.replace(":", " h ")}.`); },
    });
    const aide = TAILLES_POINT.find(([v]) => v === r.taille)[2];
    const taille = el("div", { class: "segments", role: "group", "aria-label": "Taille du point" },
      TAILLES_POINT.map(([v, nom]) => el("button", {
        type: "button", class: v === r.taille ? "actif" : "", "aria-pressed": String(v === r.taille),
        onclick: () => { if (v !== r.taille) regler({ taille: v }); },
      }, nom)));
    const heureLigne = ligne("Heure", "Chaque jour, l'IA relit tes mails puis t'envoie le point.", heure);
    if (!r.actif) heureLigne.classList.add("eteint");
    carte.replaceChildren(
      ligne("Point du matin sur le téléphone", "Une notification qui dit s'il y a une urgence aujourd'hui, à l'heure choisie.",
        interrupteur("Point du matin sur le téléphone", r.actif, (e) => regler({ actif: e.target.checked },
          e.target.checked ? "Point du matin activé." : "Plus de point du matin."))),
      heureLigne,
      ligne("Taille", aide, taille),
      ligne("Sur l'accueil", "Le point du jour en haut de l'accueil, à la même taille.",
        interrupteur("Point des mails sur l'accueil", r.accueil, (e) => regler({ accueil: e.target.checked },
          e.target.checked ? "Le point s'affiche sur l'accueil." : "Le point n'est plus sur l'accueil."))));
  }
  dessiner();
  cible.append(el("section", {}, el("h2", {}, "Point des mails"), carte));
}

// --- Modules --------------------------------------------------------------------------------------------------------

const MODULES = [
  ["mails", "Mails", "Lecture des boîtes et brouillons."],
  ["agenda", "Agenda", ""],
  ["taches", "Tâches", ""],
  ["fichiers", "Fichiers", "Espace de fichiers sur le serveur."],
  ["serveur", "Serveur", "État de la machine : disques, services, températures."],
  ["hermes", "Assistant Hermes", "Agent Hermes installé à part (voir poste.exemple.toml)."],
  ["collabora", "Word, Excel, PowerPoint", "Collabora Online installé à part."],
  ["drawio", "Diagrammes", "draw.io installé à part."],
  ["sport", "Sport", "Activités Strava."],
];

function blocModules(etat) {
  return el("section", {}, el("h2", {}, "Modules"), el("div", { class: "liste-carte" },
    el("p", { class: "doux petit br-vide" }, "Un module coupé disparaît du menu et de l'accueil. Les services à part se règlent dans poste.toml."),
    MODULES.map(([id, nom, aide]) => ligne(nom, aide, interrupteur(nom, etat.modules[id], async (e) => {
      await api("/api/connecteurs/modules", { methode: "PUT", corps: { [id]: e.target.checked } });
      toast(`${nom} ${e.target.checked ? "activé" : "coupé"}.`, "Recharger", () => location.reload());
    })))));
}

// --- Sites intégrés -------------------------------------------------------------------------------------------------

function ajouterSite(apres) {
  const nom = champ("Nom dans le menu", { required: true, maxlength: 40, placeholder: "CRM, Wiki, Supervision…" });
  const adresse = champ("Adresse", { required: true, type: "url", spellcheck: "false", placeholder: "https://…" });
  const message = el("p", { class: "doux petit br-message", role: "status" });
  const valider = el("button", { class: "plein" }, "Ajouter");
  const d = fenetre("Ajouter un site", el("form", {
    class: "pile",
    onsubmit: async (ev) => {
      ev.preventDefault();
      const fait = await attendre(valider, message, () => api("/api/sites", { methode: "POST", corps: { nom: valeur(nom), adresse: valeur(adresse) } }));
      if (!fait) return;
      d.close();
      toast(`« ${fait.nom} » ajouté au menu.`, "Recharger", () => location.reload());
      apres();
    },
  }, el("p", { class: "doux petit" }, "Une application web que tu utilises déjà (CRM, wiki, supervision, domotique…) s'ouvre alors dans Poste, depuis le menu. Certains sites refusent d'être affichés dans une autre page : ils restent blancs, et s'ouvrent dans un onglet."),
  nom, adresse, message, el("div", { class: "boutons" }, valider, el("button", { type: "button", onclick: () => d.close() }, "Annuler"))));
  nom.querySelector("input").focus();
}

function blocSites(sites, recharger) {
  const lignes = sites.map((s) => el("div", { class: "ligne br-ligne" },
    el("div", { class: "corps" }, el("strong", {}, s.nom), el("div", { class: "doux petit" }, s.adresse)),
    el("span", { class: "br-actions" }, el("button", { class: "lien alerte", onclick: async () => {
      if (!confirm(`Retirer « ${s.nom} » du menu ?`)) return;
      await api(`/api/sites/${s.id}`, { methode: "DELETE" });
      toast("Site retiré.", "Recharger", () => location.reload());
      recharger();
    } }, "Retirer"))));
  return el("section", {}, el("h2", { class: "h2-lien" }, "Sites intégrés",
    el("button", { class: "lien", onclick: () => ajouterSite(recharger) }, "+ Ajouter")),
  el("div", { class: "liste-carte" }, lignes.length ? lignes
    : el("p", { class: "doux br-vide" }, "Ajoute au menu les applications web que tu utilises déjà : elles s'ouvrent dans Poste.")));
}

export async function blocsBranchements(cible) {
  const zone = el("div", { class: "br-zone" });
  async function dessiner() {
    const [etat, sites] = await Promise.all([api("/api/connecteurs"), api("/api/sites").catch(() => [])]);
    zone.replaceChildren(...[
      moduleActif("mails") ? blocComptes(etat, dessiner) : null,
      moduleActif("agenda") ? blocAgendas(etat, dessiner) : null,
      blocIA(etat),
      blocDictee(etat, dessiner),
      blocNotifications(etat),
      blocSites(sites, dessiner),
      blocModules(etat),
    ].filter(Boolean));
  }
  cible.append(zone);
  try {
    await dessiner();
  } catch (err) {
    zone.replaceChildren(el("p", { class: "erreur" }, err.message));
  }
}
