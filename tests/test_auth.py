from conftest import MDP


def test_tout_est_protege_sans_session(client):
    assert client.get("/api/accueil").status_code == 401
    assert client.get("/api/serveur").status_code == 401


def test_premiere_visite_cree_le_mot_de_passe_une_seule_fois(client):
    assert client.get("/api/auth/etat").json().items() >= {"initialise": False, "connecte": False}.items()
    assert client.post("/api/auth/creer", json={"mot_de_passe": "court"}).status_code == 422
    assert client.post("/api/auth/creer", json={"mot_de_passe": MDP}).status_code == 200
    assert client.get("/api/auth/etat").json().items() >= {"initialise": True, "connecte": True}.items()
    assert client.post("/api/auth/creer", json={"mot_de_passe": "autre-mot-de-passe"}).status_code == 409


def test_connexion_deconnexion_et_limite_des_essais(connecte):
    connecte.post("/api/auth/deconnexion")
    connecte.cookies.clear()
    assert connecte.get("/api/accueil").status_code == 401
    assert connecte.post("/api/auth/connexion", json={"mot_de_passe": MDP}).status_code == 200
    assert connecte.get("/api/accueil").status_code == 200
    connecte.post("/api/auth/deconnexion")
    connecte.cookies.clear()
    for _ in range(5):
        assert connecte.post("/api/auth/connexion", json={"mot_de_passe": "faux-faux-faux"}).status_code == 401
    assert connecte.post("/api/auth/connexion", json={"mot_de_passe": MDP}).status_code == 429


def test_hote_et_origine_etrangers_refuses(connecte):
    assert connecte.get("/api/auth/etat", headers={"host": "evil.example"}).status_code == 400
    r = connecte.post("/api/auth/deconnexion", headers={"origin": "https://evil.example"})
    assert r.status_code == 403


def test_cookie_de_session_durci(client):
    r = client.post("/api/auth/creer", json={"mot_de_passe": MDP})
    entete = r.headers["set-cookie"].lower()
    assert "httponly" in entete and "samesite=strict" in entete
    assert "content-security-policy" in r.headers


def test_requetes_simultanees_sans_erreur(connecte):
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(12) as pool:
        codes = list(pool.map(lambda _: connecte.get("/api/hermes/habitudes").status_code, range(60)))
    assert set(codes) == {200}


def test_jeton_agent_limite_aux_routes_prevues(connecte, tmp_path):
    jeton = (tmp_path / "agent").read_text()
    connecte.cookies.clear()
    h = {"x-poste-agent": jeton}
    assert connecte.get("/api/taches", headers=h).status_code == 200
    assert connecte.post("/api/taches", headers=h, json={"titre": "x"}).status_code == 201
    assert connecte.get("/api/taches", headers={"x-poste-agent": "faux"}).status_code == 401
    # Jamais ses propres confirmations, habitudes, modèle, suppressions ni notifications.
    assert connecte.post("/api/hermes/executions/r/decision", headers=h, json={"choix": "once"}).status_code == 401
    assert connecte.delete("/api/hermes/habitudes/x", headers=h).status_code == 401
    assert connecte.post("/api/hermes/modele", headers=h, json={"modele": "rapide"}).status_code == 401
    assert connecte.delete("/api/taches/1", headers=h).status_code == 401
    assert connecte.get("/api/notifications/config", headers=h).status_code == 401
    assert connecte.get("/telecharger/poste.apk", headers=h).status_code == 401


def test_etat_donne_la_version_sans_session(client):
    from poste import __version__
    assert client.get("/api/auth/etat").json()["version"] == __version__


def test_le_mail_html_peut_s_afficher_dans_poste(client):
    # Régression 1.17 à 1.29 : frame-src sans 'self' bloquait le cadre du mail HTML (ERR_BLOCKED_BY_CSP).
    politique = client.get("/api/auth/etat").headers["content-security-policy"]
    cadres = next(d for d in politique.split(";") if d.strip().startswith("frame-src")).split()
    assert "'self'" in cadres and "'none'" not in cadres
