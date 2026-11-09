import json

from poste.modules import ia_bureau


def test_le_relais_est_refuse_hors_de_la_machine(client):
    # Le client de test se présente comme « testserver », jamais comme l'adresse locale de Poste.
    assert client.post("/v1/chat/completions", json={"messages": []}).status_code == 403
    assert client.get("/v1/models").status_code == 403


def recherche(cherche, remplace="x"):
    return {"name": ".uno:ExecuteSearch", "arguments": {"SearchItem.SearchString": {"type": "string", "value": cherche}, "SearchItem.ReplaceString": {"type": "string", "value": remplace}, "SearchItem.Command": {"type": "long", "value": "3"}}}


def test_seules_les_commandes_listees_passent():
    bon = {"name": ".uno:InsertText", "arguments": {"Text": {"type": "string", "value": "x"}}}
    assert ia_bureau.commandes_permises(json.dumps({"UnoCommand": bon}))[0]["Command"] == ".uno:InsertText"
    for mauvais in (".uno:Save", ".uno:OpenFromWriter", "macro:///x", ".uno:CloseDoc", "vnd.sun.star.script:x"):
        assert ia_bureau.commandes_permises(json.dumps({"UnoCommand": {"name": mauvais, "arguments": {}}})) is None
    assert ia_bureau.commandes_permises("pas du json") is None
    assert ia_bureau.commandes_permises(json.dumps({"UnoCommand": {"name": ".uno:InsertText", "arguments": {"Text": "brut"}}})) is None


def test_une_commande_interdite_bloque_tout_le_lot():
    assert ia_bureau.commandes_permises(json.dumps({"UnoCommands": [recherche("a"), {"name": ".uno:CloseDoc", "arguments": {}}]})) is None
    assert ia_bureau.commandes_permises(json.dumps({"UnoCommands": []})) is None
    assert ia_bureau.commandes_permises(json.dumps({"UnoCommands": [recherche("a")] * 101})) is None
    assert len(ia_bureau.commandes_permises(json.dumps({"UnoCommands": [recherche("a"), recherche("b")]}))) == 2


def test_les_espaces_de_la_selection_sont_retirees():
    args = ia_bureau.commandes_permises(json.dumps({"UnoCommand": recherche(" Bonjoure a tous ", " Bonjour à tous ")}))[0]["Args"]
    assert args["SearchItem.SearchString"]["value"] == "Bonjoure a tous" and args["SearchItem.ReplaceString"]["value"] == "Bonjour à tous"
    assert ia_bureau.commandes_permises(json.dumps({"UnoCommand": recherche("   ")})) is None


def test_les_commandes_de_la_page_demandent_une_connexion(client):
    assert client.get("/api/espace/bureau/commandes", params={"vue": "x"}).status_code == 401


def test_la_consigne_explique_le_remplacement_dans_word():
    assert ".uno:ExecuteSearch" in ia_bureau.CONSIGNE and "French" in ia_bureau.CONSIGNE and "only the wrong word" in ia_bureau.CONSIGNE


def test_la_page_ne_recoit_rien_sans_commande_en_attente(connecte):
    assert connecte.get("/api/espace/bureau/commandes", params={"vue": "v1"}).json() == []
    assert connecte.post("/api/espace/bureau/commandes/inconnue/fait").json() == {"ok": True}
