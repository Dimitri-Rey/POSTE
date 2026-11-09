"""Stockages des sauvegardes : configuration rclone de chaque fournisseur, et vrais échanges WebDAV, SFTP, FTP, S3
(serveurs lancés en local par « rclone serve », avec mot de passe), chiffrement, erreurs lisibles."""
import json
import shutil
import socket
import subprocess
import time
from datetime import datetime

import pytest

from poste.modules import sauvegardes as s
from poste.modules import stockages as st

pytestmark = pytest.mark.skipif(shutil.which("rclone") is None, reason="rclone absent")


def test_configuration_de_chaque_fournisseur():
    p, chemin = st.configuration("webdav", {"url": "https://123.connect.kdrive.infomaniak.com", "utilisateur": "moi@exemple.fr", "chemin": "Sauvegardes/Poste"},
                                 {"mot_de_passe": "secret"})
    assert p["type"] == "webdav" and p["user"] == "moi@exemple.fr" and p["pass"] != "secret" and chemin == "Sauvegardes/Poste"
    with pytest.raises(st.ErreurStockage, match="majuscules"):
        st.configuration("webdav", {"url": "https://NUMERO.connect.kdrive.infomaniak.com", "utilisateur": "x"}, {"mot_de_passe": "x"})
    p, chemin = st.configuration("smb", {"hote": "nas.local", "partage": "sauvegardes", "utilisateur": "camille", "domaine": "EXEMPLE",
                                         "chemin": "poste"}, {"mot_de_passe": "x"})
    assert p["domain"] == "EXEMPLE" and p["port"] == "445" and chemin == "sauvegardes/poste"
    p, _ = st.configuration("smb", {"hote": "srv", "partage": "p", "kerberos": "1"}, {})
    assert p["use_kerberos"] == "true" and "pass" not in p
    p, _ = st.configuration("sftp", {"hote": "nas", "utilisateur": "u"}, {"cle_privee": "-----BEGIN KEY-----\nabc\n-----END KEY-----\n"})
    assert p["key_pem"] == "-----BEGIN KEY-----\\nabc\\n-----END KEY-----" and "pass" not in p
    with pytest.raises(st.ErreurStockage, match="mot de passe ou une clé"):
        st.configuration("sftp", {"hote": "nas", "utilisateur": "u"}, {})
    p, chemin = st.configuration("s3", {"fournisseur": "Other", "endpoint": "https://s3.exemple", "compartiment": "seau", "cle_acces": "AK", "chemin": "poste"},
                                 {"cle_secrete": "SK"})
    assert p["no_check_bucket"] == "true" and chemin == "seau/poste"
    sortie = 'Paste the following into your remote machine --->\n{"access_token":"a","token_type":"Bearer","refresh_token":"r","expiry":"2026"}\n<---End paste'
    p, _ = st.configuration("drive", {}, {"jeton": sortie})
    assert json.loads(p["token"])["refresh_token"] == "r" and p["scope"] == "drive"
    with pytest.raises(st.ErreurStockage, match="Jeton"):
        st.configuration("dropbox", {}, {"jeton": "n'importe quoi"})
    p, _ = st.configuration("rclone", {}, {"config_rclone": "[onedrive]\ntype = onedrive\ndrive_id = abc\ndrive_type = personal\n"})
    assert p == {"type": "onedrive", "drive_id": "abc", "drive_type": "personal"}
    with pytest.raises(st.ErreurStockage, match="enveloppe"):
        st.configuration("rclone", {}, {"config_rclone": "[x]\ntype = crypt\nremote = y:"})
    with pytest.raises(st.ErreurStockage, match=r"\.\."):
        st.configuration("webdav", {"url": "https://a.b", "utilisateur": "u", "chemin": "../../etc"}, {"mot_de_passe": "x"})
    with pytest.raises(st.ErreurStockage, match="manquant"):
        st.configuration("ftp", {"hote": "h"}, {})
    # Chaque fournisseur proposé a un type géré, et ses champs secrets sont bien des secrets.
    for f in st.FOURNISSEURS.values():
        assert f["type"] in st.TYPES
        assert all((g in ("secret", "zone")) == (c in st.SECRETS) for c, _, g, _, _ in f["champs"])


def _port() -> int:
    with socket.socket() as so:
        so.bind(("127.0.0.1", 0))
        return so.getsockname()[1]


@pytest.fixture
def serveur(tmp_path_factory):
    """Lance « rclone serve <protocole> » sur un dossier vide, avec identifiant et mot de passe."""
    lances = []

    def lancer(protocole: str, *options: str):
        dossier = tmp_path_factory.mktemp(f"serveur-{protocole}")
        port = _port()
        proc = subprocess.Popen(["rclone", "serve", protocole, str(dossier), "--addr", f"127.0.0.1:{port}", *options],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={"PATH": "/usr/bin:/bin", "HOME": str(dossier)})
        lances.append(proc)
        for _ in range(100):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.1)
        return dossier, port
    yield lancer
    for proc in lances:
        proc.terminate()
        proc.wait(5)


@pytest.fixture
def donnees(tmp_path, monkeypatch):
    racine = tmp_path / "donnees"
    (racine / "espace").mkdir(parents=True)
    (racine / "espace" / "devis.md").write_text("# Devis")
    import sqlite3
    sqlite3.connect(racine / "poste.db").execute("CREATE TABLE t (x)").connection.close()
    monkeypatch.setattr(s, "_racine_donnees", racine)
    monkeypatch.setattr(s, "_base", racine / "poste.db")
    return racine


PLAN = {"heure": "03:00", "frequence": "jours", "jours": "1234567", "jour_mois": 1, "complete": "semaine", "complete_jour": 7,
        "garder": 2, "secrets": 0, "actif": 1}


def _cycle(plan, secrets, racine, tmp_path):
    """Complète, incrémentielle, rotation, restauration : le même parcours sur chaque stockage."""
    s._secrets = lambda ident, fournis=None: secrets  # noqa: E731 - pas de coffre dans ces tests
    f1 = s.sauvegarder(plan, datetime(2026, 11, 1, 3))
    (racine / "espace" / "devis.md").write_text("# Devis v2")
    f2 = s.sauvegarder(plan, datetime(2026, 11, 2, 3))
    assert (f1["type"], f2["type"]) == ("complete", "incrementielle")
    for jour in (8, 15):
        s.sauvegarder(plan, datetime(2026, 11, jour, 3))
    restantes = s.lister(s.stockage_de(plan, secrets), s._cache(plan))
    assert [f["date"][:10] for f in restantes] == ["2026-11-08", "2026-11-15"]  # 2 chaînes gardées
    cible = tmp_path / f"remis-{plan['id']}"
    s.restaurer(s.stockage_de(plan, secrets), restantes[-1]["archive"], cible, prefixe="donnees/espace/", cache=s._cache(plan))
    assert (cible / "devis.md").read_text() == "# Devis v2"
    return restantes


def test_webdav_sftp_ftp_s3_pour_de_vrai(serveur, donnees, tmp_path, monkeypatch):
    original = s._secrets
    try:
        dav, port = serveur("webdav", "--user", "camille", "--pass", "mdp-webdav")
        plan = {**PLAN, "id": 901, "fournisseur": "webdav", "chemin": "Sauvegardes",
                "options": {"url": f"http://127.0.0.1:{port}", "utilisateur": "camille"}}
        _cycle(plan, {"mot_de_passe": "mdp-webdav"}, donnees, tmp_path)
        assert sorted(p.name for p in (dav / "Sauvegardes" / "poste-sauvegardes").iterdir())[0].startswith("poste-20261108")

        sftp, port = serveur("sftp", "--user", "camille", "--pass", "mdp-sftp")
        plan = {**PLAN, "id": 902, "fournisseur": "sftp", "chemin": "nas/poste", "options": {"hote": "127.0.0.1", "port": str(port), "utilisateur": "camille"}}
        _cycle(plan, {"mot_de_passe": "mdp-sftp"}, donnees, tmp_path)
        assert len(list((sftp / "nas" / "poste" / "poste-sauvegardes").glob("*.tar.gz"))) == 2

        _, port = serveur("ftp", "--user", "camille", "--pass", "mdp-ftp")
        plan = {**PLAN, "id": 903, "fournisseur": "ftp", "chemin": "", "options": {"hote": "127.0.0.1", "port": str(port), "utilisateur": "camille", "tls": ""}}
        _cycle(plan, {"mot_de_passe": "mdp-ftp"}, donnees, tmp_path)

        seau, port = serveur("s3", "--auth-key", "CLEACCES,clesecrete")
        (seau / "seau").mkdir()
        plan = {**PLAN, "id": 904, "fournisseur": "s3", "chemin": "poste",
                "options": {"fournisseur": "Rclone", "endpoint": f"http://127.0.0.1:{port}", "compartiment": "seau", "cle_acces": "CLEACCES"}}
        _cycle(plan, {"cle_secrete": "clesecrete"}, donnees, tmp_path)
    finally:
        s._secrets = original


def test_chiffrement_rien_de_lisible_chez_le_fournisseur(serveur, donnees, tmp_path):
    original = s._secrets
    try:
        dav, port = serveur("webdav", "--user", "u", "--pass", "p")
        plan = {**PLAN, "id": 905, "fournisseur": "kdrive", "chemin": "Sauvegardes", "options": {"url": f"http://127.0.0.1:{port}", "utilisateur": "u"}}
        secrets = {"mot_de_passe": "p", "chiffrement": "phrase de chiffrement"}
        _cycle(plan, secrets, donnees, tmp_path)
        chez_lui = [p for p in dav.rglob("*") if p.is_file()]
        assert chez_lui and not any("poste" in p.name or p.name.endswith(".json") for p in chez_lui)
        assert not any(b"Devis" in p.read_bytes() or b'"archive"' in p.read_bytes() for p in chez_lui)
        # Mauvais mot de passe : rien ne se relit (et rien n'est effacé).
        s.vider_cache(905)
        mauvais = s.stockage_de(plan, {"mot_de_passe": "p", "chiffrement": "autre chose"})
        assert s.lister(mauvais) == []
        assert len([p for p in dav.rglob("*") if p.is_file()]) == len(chez_lui)
    finally:
        s._secrets = original


def test_erreurs_lisibles(serveur, donnees):
    _, port = serveur("webdav", "--user", "u", "--pass", "bon")
    plan = {"id": 906, "fournisseur": "webdav", "chemin": "", "options": {"url": f"http://127.0.0.1:{port}", "utilisateur": "u"}}
    with pytest.raises(st.ErreurStockage, match="Identifiants refusés"):
        s.stockage_de(plan, {"mot_de_passe": "mauvais"}).preparer()
    plan["options"]["url"] = f"http://127.0.0.1:{_port()}"
    with pytest.raises(st.ErreurStockage, match="refuse la connexion"):
        s.stockage_de(plan, {"mot_de_passe": "bon"}).preparer()
    plan["options"]["url"] = "http://hote-qui-n-existe-pas.invalid"
    with pytest.raises(st.ErreurStockage, match="introuvable"):
        s.stockage_de(plan, {"mot_de_passe": "bon"}).preparer()


def test_routes_stockage_distant(connecte, serveur, tmp_path):
    dav, port = serveur("webdav", "--user", "u", "--pass", "p")
    r = connecte.post("/api/sauvegardes/tester", json={"nom": "NC", "fournisseur": "nextcloud", "options": {"url": f"http://127.0.0.1:{port}", "utilisateur": "u"},
                                                        "secrets_stockage": {"mot_de_passe": "p"}})
    assert "/remote.php/dav/files/" in r.json()["detail"]
    corps = {"nom": "NAS", "fournisseur": "webdav", "chemin": "Poste", "options": {"url": f"http://127.0.0.1:{port}", "utilisateur": "u"},
             "secrets_stockage": {"mot_de_passe": "faux"}}
    r = connecte.post("/api/sauvegardes/tester", json=corps)
    assert r.status_code == 422 and "Identifiants refusés" in r.json()["detail"]
    assert connecte.post("/api/sauvegardes", json=corps).status_code == 422  # rien d'enregistré si ça ne marche pas
    assert connecte.post("/api/sauvegardes", json={**corps, "options": {**corps["options"], "inconnu": "x"}}).status_code == 422
    assert connecte.post("/api/sauvegardes", json={**corps, "secrets_stockage": {"autre": "x"}}).status_code == 422
    corps["secrets_stockage"] = {"mot_de_passe": "p", "chiffrement": "phrase"}
    e = connecte.post("/api/sauvegardes", json=corps).json()
    assert e["secrets_definis"] == ["chiffrement", "mot_de_passe"] and e["chiffre"] and e["description"].startswith("Autre WebDAV · 127.0.0.1")
    assert "p" not in json.dumps({k: v for k, v in e.items() if k not in ("resume", "description", "fournisseur_nom", "nom", "chemin")}).split('"')
    connecte.post(f"/api/sauvegardes/{e['id']}/lancer", json={})
    for _ in range(200):
        e = connecte.post(f"/api/sauvegardes/{e['id']}/actualiser").json()
        if not e["en_cours"] and e["sauvegardes"]:
            break
        time.sleep(0.1)
    assert e["erreur"] == "" and e["sauvegardes"][0]["type"] == "complete"
    # Modifier sans retaper les mots de passe : on garde ceux du coffre.
    corps["secrets_stockage"] = {}
    assert connecte.put(f"/api/sauvegardes/{e['id']}", json={**corps, "garder": 9}).json()["garder"] == 9
    assert connecte.put(f"/api/sauvegardes/{e['id']}", json={**corps, "fournisseur": "kdrive"}).status_code == 422
    r = connecte.post(f"/api/sauvegardes/{e['id']}/recuperer", json={"archive": e["sauvegardes"][0]["archive"]}).json()
    assert r["fichiers"] >= 0
    from poste import coffre
    assert connecte.delete(f"/api/sauvegardes/{e['id']}").json() == {"ok": True}
    assert not coffre.defini(f"sauvegarde:{e['id']}:mot_de_passe")
    assert [p for p in dav.rglob("*") if p.is_file()]  # les sauvegardes restent chez le fournisseur
    assert "google" in connecte.get("/api/sauvegardes").json()["fournisseurs"]


@pytest.mark.skipif(not __import__("os").environ.get("POSTE_SMB_ESSAI"), reason="POSTE_SMB_ESSAI=hôte:port absent")
def test_partage_smb_pour_de_vrai(donnees, tmp_path):
    """Avec un Samba de test : podman run -d --rm --name poste-test-samba -p 127.0.0.1:1445:445 docker.io/dperson/samba -p
    -u "camille;mdp-smb" -s "sauvegardes;/share;yes;no;no;camille", puis POSTE_SMB_ESSAI=127.0.0.1:1445."""
    import os
    hote, port = os.environ["POSTE_SMB_ESSAI"].split(":")
    original = s._secrets
    try:
        plan = {**PLAN, "id": 907, "fournisseur": "synology", "chemin": "poste",
                "options": {"hote": hote, "port": port, "partage": "sauvegardes", "utilisateur": "camille"}}
        _cycle(plan, {"mot_de_passe": "mdp-smb"}, donnees, tmp_path)
        with pytest.raises(st.ErreurStockage, match="Identifiants refusés"):
            s.stockage_de(plan, {"mot_de_passe": "faux"}).preparer()
    finally:
        s._secrets = original
