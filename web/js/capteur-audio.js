// AudioWorklet de la dictée (dictee.js) : ramène le micro à 16 kHz mono et envoie au fil principal
// des morceaux de 100 ms en PCM 16 bits, transmis tels quels au serveur.

const SORTIE_HZ = 16000;
const MORCEAU = SORTIE_HZ / 10;

class CapteurAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pas = sampleRate / SORTIE_HZ; // ex. 3 pour un micro à 48 kHz
    this.position = 0; // position du prochain échantillon de sortie, en échantillons d'entrée
    this.somme = 0;
    this.compte = 0;
    this.sortie = new Int16Array(MORCEAU);
    this.rempli = 0;
  }

  process(entrees) {
    const canal = entrees[0]?.[0];
    if (!canal) return true;
    for (let i = 0; i < canal.length; i++) {
      // Moyenne des échantillons d'entrée de chaque intervalle : sous-échantillonnage avec un filtre simple.
      this.somme += canal[i];
      this.compte += 1;
      this.position -= 1;
      if (this.position > 0) continue;
      this.position += this.pas;
      const valeur = Math.max(-1, Math.min(1, this.somme / this.compte));
      this.somme = 0;
      this.compte = 0;
      this.sortie[this.rempli++] = valeur < 0 ? valeur * 0x8000 : valeur * 0x7fff;
      if (this.rempli === MORCEAU) {
        this.port.postMessage(this.sortie.buffer, [this.sortie.buffer]);
        this.sortie = new Int16Array(MORCEAU);
        this.rempli = 0;
      }
    }
    return true;
  }
}

registerProcessor("capteur-audio", CapteurAudio);
