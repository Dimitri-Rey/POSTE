# Contributing · Contribuer

Thank you for your interest in Poste. · Merci de ton intérêt pour Poste.

## Before you start · Avant de commencer

- Open an issue to discuss a feature before writing it. Bug reports with steps to reproduce are very welcome.
- Ouvre un ticket pour discuter d'une fonction avant de l'écrire. Les signalements de bugs avec les étapes pour les reproduire sont les bienvenus.

## Ground rules · Règles du projet

- **Poste never sends an email.** Pull requests that add sending will not be merged. · **Poste n'envoie jamais de mail.** Une contribution qui ajoute l'envoi ne sera pas acceptée.
- No frontend framework and no build step: plain ES modules in `web/`. · Pas de framework ni d'étape de construction côté interface : des modules ES dans `web/`.
- Every change comes with a test: `tests/test_*.py` for the API, a Playwright walkthrough (`tests/*.cjs`) for the interface. · Chaque changement vient avec un test.
- The code and the interface are written in French; issues and pull requests can be in English or French. · Le code et l'interface sont en français ; tickets et contributions en anglais ou en français.

## Running the tests · Lancer les tests

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest
.venv/bin/python -m pytest -q tests
PLAYWRIGHT=<playwright-core> CHROME=<chromium> node tests/sites.cjs /tmp/captures
```

By contributing, you agree that your contribution is licensed under the AGPL-3.0. · En contribuant, tu acceptes que ta contribution soit sous licence AGPL-3.0.
