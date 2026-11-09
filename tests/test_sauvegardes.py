"""Sauvegardes : planning, complète puis incrémentielles, restauration, rotation, échecs, accès."""
import json
import os
import sqlite3
import time
from datetime import datetime
from pathlib import Path

import pytest

from poste.modules import sauvegardes as s

PLAN = {"id": 1, "nom": "Disque", "heure": "03:00", "frequence": "jours", "jours": "1234567", "jour_mois": 1,
        "complete": "semaine", "complete_jour": 7, "garder": 4, "secrets": 0, "actif": 1}


def test_planning_jours_et_mois():
    # Mercredi 2026-11-04 à 10 h
    mercredi = datetime(2026, 11, 4, 10, 0)
    assert s.dernier_creneau(PLAN, mercredi) == datetime(2026, 11, 4, 3, 0)
    assert s.prochain_creneau(PLAN, mercredi) == datetime(2026, 11, 5, 3, 0)
    assert s.debut_du_cycle(PLAN, mercredi) == datetime(2026, 11, 1, 3, 0)  # dimanche
    lundi_jeudi = {**PLAN, "jours": "14"}
    assert s.dernier_creneau(lundi_jeudi, mercredi) == datetime(2026, 11, 2, 3, 0)
    assert s.prochain_creneau(lundi_jeudi, mercredi) == datetime(2026, 11, 5, 3, 0)
    # « Le 31 » de chaque mois : le dernier jour des mois plus courts.
    mensuel = {**PLAN, "frequence": "mois", "jour_mois": 31, "complete": "mois", "complete_jour": 31}
    assert s.prochain_creneau(mensuel, mercredi) == datetime(2026, 11, 30, 3, 0)
    assert s.dernier_creneau(mensuel, mercredi) == datetime(2026, 10, 31, 3, 0)
    assert s.debut_du_cycle({**PLAN, "complete": "toujours"}, mercredi) == mercredi
    assert "dimanche" in s.resume(PLAN) and "4 semaines" in s.resume(PLAN)
    assert s.resume(mensuel).startswith("Le 31 de chaque mois")


@pytest.fixture
def donnees(tmp_path, monkeypatch):
    racine = tmp_path / "donnees"
    (racine / "espace" / "Projets").mkdir(parents=True)
    cnx = sqlite3.connect(racine / "poste.db")
    cnx.execute("PRAGMA journal_mode=WAL")
    cnx.execute("CREATE TABLE t (x)")
    cnx.execute("INSERT INTO t VALUES ('avant')")
    cnx.commit()
    cnx.close()
    (racine / "espace" / "a.txt").write_text("un")
    (racine / "espace" / "Projets" / "b.txt").write_text("deux")
    monkeypatch.setattr(s, "_racine_donnees", racine)
    monkeypatch.setattr(s, "_base", racine / "poste.db")
    endroit = tmp_path / "disque"
    endroit.mkdir()
    return racine, endroit


def _toucher(chemin: Path, texte: str) -> None:
    chemin.write_text(texte)
    os.utime(chemin, ns=(time.time_ns() + 10**9, time.time_ns() + 10**9))


def test_complete_puis_incrementielles_et_restauration(donnees, tmp_path):
    racine, endroit = donnees
    plan = {**PLAN, "chemin": str(endroit)}
    lundi = datetime(2026, 11, 2, 3, 0)
    f1 = s.sauvegarder(plan, lundi)
    assert f1["type"] == "complete"  # aucune encore : la première est toujours complète
    _toucher(racine / "espace" / "a.txt", "un modifié")
    (racine / "espace" / "c.txt").write_text("trois")
    f2 = s.sauvegarder(plan, datetime(2026, 11, 3, 3, 0))
    assert f2["type"] == "incrementielle" and f2["parent"] == f1["archive"] and f2["chaine"] == f1["archive"]
    assert f2["fichiers"] == 3  # a modifié, c nouveau, et la base (toujours copiée)
    (racine / "espace" / "Projets" / "b.txt").unlink()
    f3 = s.sauvegarder(plan, datetime(2026, 11, 4, 3, 0))
    assert f3["supprimes"] == 1 and f3["fichiers"] == 1
    # Restaurer la dernière : l'état actuel, suppression comprise.
    cible = tmp_path / "remis"
    s.restaurer(endroit / s.SOUS_DOSSIER, f3["archive"], cible)
    assert (cible / "donnees/espace/a.txt").read_text() == "un modifié"
    assert (cible / "donnees/espace/c.txt").read_text() == "trois"
    assert not (cible / "donnees/espace/Projets/b.txt").exists()
    assert sqlite3.connect(cible / "donnees/poste.db").execute("SELECT x FROM t").fetchone()[0] == "avant"
    # Restaurer la première : l'état d'alors.
    cible1 = tmp_path / "remis1"
    s.restaurer(endroit / s.SOUS_DOSSIER, f1["archive"], cible1, prefixe="donnees/espace/")
    assert (cible1 / "a.txt").read_text() == "un" and (cible1 / "Projets/b.txt").exists() and not (cible1 / "c.txt").exists()
    # Le dimanche, une nouvelle chaîne commence.
    f4 = s.sauvegarder(plan, datetime(2026, 11, 8, 3, 0))
    assert f4["type"] == "complete" and f4["chaine"] == f4["archive"]
    assert not list((endroit / s.SOUS_DOSSIER).glob("*.partiel"))
    assert oct((endroit / s.SOUS_DOSSIER / f4["archive"]).stat().st_mode)[-3:] == "600"


def test_rotation_garde_les_n_dernieres_chaines(donnees):
    racine, endroit = donnees
    plan = {**PLAN, "chemin": str(endroit), "garder": 2}
    jours = [datetime(2026, 11, d, 3, 0) for d in (1, 2, 8, 9, 15, 16)]  # dimanches 1, 8, 15
    for j in jours:
        s.sauvegarder(plan, j)
    restantes = s.lister(endroit / s.SOUS_DOSSIER)
    assert [f["date"][:10] for f in restantes] == ["2026-11-08", "2026-11-09", "2026-11-15", "2026-11-16"]
    assert [f["type"] for f in restantes] == ["complete", "incrementielle", "complete", "incrementielle"]
    assert len(list((endroit / s.SOUS_DOSSIER).glob("*.json"))) == 4


def test_toujours_complete_et_changement_de_secrets(donnees):
    racine, endroit = donnees
    plan = {**PLAN, "chemin": str(endroit), "complete": "toujours"}
    assert s.sauvegarder(plan, datetime(2026, 11, 2, 3))["type"] == "complete"
    assert s.sauvegarder(plan, datetime(2026, 11, 3, 3))["type"] == "complete"
    plan = {**plan, "complete": "semaine"}
    assert s.sauvegarder(plan, datetime(2026, 11, 4, 3))["type"] == "incrementielle"
    # Ajouter les secrets change le contenu : on repart d'une complète.
    assert s.sauvegarder({**plan, "secrets": 1}, datetime(2026, 11, 5, 3))["type"] == "complete"


def test_endroits_refuses(donnees, tmp_path):
    racine, endroit = donnees
    assert "en dehors" in str(pytest.raises(s.ErreurSauvegarde, s.verifier_endroit, str(racine / "espace")).value)
    for mauvais in ("relatif/dossier", str(tmp_path / "absent"), str(racine), str(racine / "espace"), "/"):
        with pytest.raises(s.ErreurSauvegarde):
            s.verifier_endroit(mauvais)
    assert s.verifier_endroit(str(endroit)) == endroit.resolve()


def _attendre(client, ident, delai=20):
    fin = time.time() + delai
    while time.time() < fin:
        e = next(x for x in client.get("/api/sauvegardes").json()["endroits"] if x["id"] == ident)
        if not e["en_cours"]:
            return e
        time.sleep(0.1)
    raise AssertionError("sauvegarde jamais finie")


def test_parcours_par_les_routes(connecte, tmp_path, tmp_path_factory, monkeypatch):
    from poste.modules import notifications
    envois = []
    monkeypatch.setattr(notifications, "envoyer", lambda *a, **k: envois.append(k.get("type_")) or True)
    espace = tmp_path / "espace"
    espace.mkdir(exist_ok=True)
    (espace / "note.md").write_text("bonjour")
    # Ailleurs que dans les données de Poste (tmp_path), qui sont refusées.
    endroit = tmp_path_factory.mktemp("usb")
    corps = {"nom": "Clé USB", "chemin": str(endroit), "heure": "02:30", "jours": "7531", "complete": "semaine", "complete_jour": 7, "garder": 3}
    assert connecte.post("/api/sauvegardes", json={**corps, "chemin": "pas/absolu"}).status_code == 422
    assert connecte.post("/api/sauvegardes", json={**corps, "complete_jour": 9}).status_code == 422
    e = connecte.post("/api/sauvegardes", json=corps).json()
    assert e["jours"] == "1357" and e["sauvegardes"] == [] and e["prochaine"] and e["prochaine_complete"]
    assert connecte.post(f"/api/sauvegardes/{e['id']}/lancer", json={}).status_code == 202
    e = _attendre(connecte, e["id"])
    assert e["erreur"] == "" and len(e["sauvegardes"]) == 1 and e["sauvegardes"][0]["type"] == "complete"
    assert "etat" not in e["sauvegardes"][0] and e["derniere_reussite"]
    # Fichier perdu, puis récupéré dans Fichiers › Restaurations
    (espace / "note.md").unlink()
    archive = e["sauvegardes"][0]["archive"]
    r = connecte.post(f"/api/sauvegardes/{e['id']}/recuperer", json={"archive": archive}).json()
    assert (espace / r["dossier"] / "note.md").read_text() == "bonjour"
    assert connecte.post(f"/api/sauvegardes/{e['id']}/recuperer", json={"archive": archive}).status_code == 422  # déjà là
    assert connecte.post(f"/api/sauvegardes/{e['id']}/recuperer", json={"archive": "../../etc/passwd"}).status_code == 422
    # Disque débranché : erreur visible et notification « sauvegardes »
    endroit.rename(endroit.with_name("usb-parti"))
    connecte.post(f"/api/sauvegardes/{e['id']}/lancer", json={})
    e = _attendre(connecte, e["id"])
    assert "n'existe pas" in e["erreur"] and not e["joignable"] and envois == ["sauvegardes"]
    # Modifier, retirer (les archives restent sur le disque)
    endroit.with_name("usb-parti").rename(endroit)
    e = connecte.put(f"/api/sauvegardes/{e['id']}", json={**corps, "actif": False}).json()
    assert not e["actif"] and e["prochaine"] is None
    assert connecte.delete(f"/api/sauvegardes/{e['id']}").json() == {"ok": True}
    assert list((endroit / s.SOUS_DOSSIER).glob("*.tar.gz"))


def test_planificateur_lance_ce_qui_est_du(connecte, tmp_path_factory, monkeypatch):
    from poste.modules import notifications
    monkeypatch.setattr(notifications, "envoyer", lambda *a, **k: True)  # jamais de vraie notification
    endroit = tmp_path_factory.mktemp("nas")
    e = connecte.post("/api/sauvegardes", json={"nom": "NAS", "chemin": str(endroit), "heure": "03:00"}).json()
    # Juste ajouté : rien avant le prochain créneau.
    assert s.lancer_dues(datetime.now()) == []
    # Serveur éteint à l'heure prévue : rattrapé au créneau suivant manqué.
    demain = datetime.fromisoformat(e["prochaine"])
    assert s.lancer_dues(demain.replace(minute=5)) == [e["id"]]
    e = _attendre(connecte, e["id"])
    assert e["erreur"] == "" and len(e["sauvegardes"]) == 1
    assert s.lancer_dues(demain.replace(minute=6)) == []


def test_hermes_n_a_pas_acces_aux_sauvegardes(connecte, tmp_path):
    jeton = (tmp_path / "agent").read_text()
    connecte.cookies.clear()
    h = {"x-poste-agent": jeton}
    assert connecte.get("/api/sauvegardes", headers=h).status_code == 401
    assert connecte.post("/api/sauvegardes", headers=h, json={"nom": "x", "chemin": "/tmp"}).status_code == 401


def test_secrets_seulement_sur_demande(donnees, tmp_path, monkeypatch):
    racine, endroit = donnees
    config = tmp_path / "config"
    config.mkdir()
    (config / "poste.toml").write_text("[profil]\n")
    (config / "jeton-agent").write_text("secret")
    monkeypatch.setattr(s.reglages, "chemin", lambda: config / "poste.toml")
    noms = lambda secrets: {a for a, _ in s._sources(secrets)}
    assert "config/poste.toml" in noms(False) and not any(n.startswith("config/secrets/") for n in noms(False))
    assert "config/secrets/jeton-agent" in noms(True)
