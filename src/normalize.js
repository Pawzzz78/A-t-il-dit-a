// Normalisation utilisée pour l'indexation ET pour les requêtes :
// minuscules, sans accents ni ponctuation, espaces simples.
// "L'économie, c'est quoi ?" -> "l economie c est quoi"

const MARKS = /\p{M}/u;
const WORD_CHAR = /[\p{L}\p{N}]/u;

const LIGATURES = { 'œ': 'oe', 'æ': 'ae', 'ß': 'ss' };

/**
 * Normalise `input` et renvoie aussi, pour chaque caractère du texte normalisé,
 * l'index du caractère correspondant dans `input` (utile pour surligner).
 */
export function normalizeWithMap(input) {
  const src = String(input ?? '');
  let out = '';
  const map = [];
  let pendingSpace = false;
  let i = 0;
  for (const ch of src) {
    const origIdx = i;
    i += ch.length;
    const lowered = ch.toLowerCase();
    const expanded = LIGATURES[lowered] ?? lowered;
    const base = expanded.normalize('NFD');
    for (const c of base) {
      if (MARKS.test(c)) continue;
      if (WORD_CHAR.test(c)) {
        if (pendingSpace && out.length > 0) {
          out += ' ';
          map.push(origIdx);
        }
        pendingSpace = false;
        out += c;
        for (let k = 0; k < c.length; k++) map.push(origIdx);
      } else {
        pendingSpace = true;
      }
    }
  }
  return { text: out, map };
}

export function normalize(input) {
  return normalizeWithMap(input).text;
}

/**
 * Construit le texte normalisé d'une vidéo à partir de ses segments.
 * Renvoie le texte complet et, pour chaque segment, la position de son début
 * dans ce texte (-1 si le segment est vide une fois normalisé).
 */
export function buildIndex(segments) {
  const parts = [];
  const offsets = [];
  let cursor = 0;
  for (const seg of segments) {
    const n = normalize(seg.text);
    if (!n) {
      offsets.push(-1);
      continue;
    }
    if (parts.length > 0) cursor += 1; // séparateur
    offsets.push(cursor);
    parts.push(n);
    cursor += n.length;
  }
  return { normText: parts.join(' '), offsets };
}
