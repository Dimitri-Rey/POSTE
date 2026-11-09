import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "api"))
# Les tests ne lisent jamais les réglages de la machine : ils ont les leurs.
os.environ["POSTE_CONFIG"] = str(Path(__file__).with_name("reglages-test.toml"))
# Ni la clé du coffre de la machine : une clé jetable par session de tests.
os.environ["POSTE_CLE"] = str(Path(os.environ.get("TMPDIR", "/tmp")) / f"poste-cle-test-{os.getpid()}")

from poste.app import creer  # noqa: E402
from poste.config import Config  # noqa: E402

MDP = "un-mot-de-passe-solide"


@pytest.fixture
def client(tmp_path):
    config = Config(base=tmp_path / "t.db", hotes=("testserver",), origines=("http://testserver",), cookie_secure=False, taches_de_fond=False, jeton_agent=tmp_path / "agent")
    return TestClient(creer(config))


@pytest.fixture
def connecte(client):
    assert client.post("/api/auth/creer", json={"mot_de_passe": MDP}).status_code == 200
    return client


@pytest.fixture
def origine():
    return "http://testserver"


@pytest.fixture(autouse=True)
def reglages_interface_remis_a_zero():
    """Les réglages faits dans l'interface sont globaux : chaque test repart de reglages-test.toml."""
    yield
    from poste import reglages
    reglages.poser_surcharges({})
