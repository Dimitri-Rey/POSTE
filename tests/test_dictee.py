"""Dictée en direct : découpage du flux, sécurité et protocole de la WebSocket."""
import numpy as np
import pytest
from starlette.websockets import WebSocketDisconnect

from poste.modules import dictee


def son(secondes, volume):
    alea = np.random.default_rng(0).uniform(-1, 1, int(secondes * dictee.FREQ))
    return (alea * volume * 32767).astype(np.int16).tobytes()


def test_partiels_puis_phrase_figee_a_la_pause():
    seg = dictee.Segmenteur(lambda extrait: f"phrase de {extrait.size // dictee.FREQ} s")
    evenements = []
    for _ in range(4):
        seg.ajouter(son(0.5, 0.3))
        evenements += seg.etape()
    assert [e["type"] for e in evenements] == ["partiel"] * 3
    for _ in range(2):
        seg.ajouter(son(0.5, 0.001))
        evenements += seg.etape()
    assert evenements[-1] == {"type": "final", "texte": "phrase de 2 s"}
    assert seg.terminer() == []


def test_silence_ni_transcrit_ni_accumule():
    seg = dictee.Segmenteur(lambda _: pytest.fail("le silence ne doit pas être retranscrit"))
    for _ in range(10):
        seg.ajouter(son(0.5, 0.001))
        assert seg.etape() == []
    assert seg._tampon.size <= 4 * dictee.FREQ


def _refuse(client, **options):
    with pytest.raises(WebSocketDisconnect) as refus:
        with client.websocket_connect("/api/dictee", **options):
            pass
    assert refus.value.code == 1008


def test_refuse_sans_session(client, origine):
    _refuse(client, headers={"origin": origine})


def test_refuse_une_autre_origine_ou_aucune(connecte):
    _refuse(connecte, headers={"origin": "https://ailleurs.example"})
    _refuse(connecte)


def test_dictee_complete(connecte, monkeypatch, origine):
    monkeypatch.setattr(dictee, "moteur_pret", lambda: None)
    monkeypatch.setattr(dictee, "reconnaitre", lambda s: "bonjour Hermes")
    with connecte.websocket_connect("/api/dictee", headers={"origin": origine}) as ws:
        assert ws.receive_json() == {"type": "pret"}
        ws.send_bytes(son(1, 0.3))
        ws.send_text("fin")
        recus = []
        while not recus or recus[-1]["type"] != "fin":
            recus.append(ws.receive_json())
    assert {"type": "final", "texte": "bonjour Hermes"} in recus


def test_moteur_absent_signale(connecte, monkeypatch, origine):
    def absent():
        raise dictee.HTTPException(503, "Moteur de dictée indisponible sur le serveur")
    monkeypatch.setattr(dictee, "moteur_pret", absent)
    with connecte.websocket_connect("/api/dictee", headers={"origin": origine}) as ws:
        assert ws.receive_json()["type"] == "erreur"
