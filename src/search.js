import { normalize, normalizeWithMap } from './normalize.js';

const STOPWORDS = new Set(
  ('le la les l un une des de du d et ou a à au aux en dans sur sous par pour que qu qui quoi ' +
    'ce cet cette ces se s sa son ses ne n pas plus il elle ils elles on nous vous je j tu ' +
    'me m te t y est sont etait ete etre avoir ai as ont avait c mais donc or ni car si ' +
    // attribution (« il a dit que… », « selon Lisnard ») : ne fait pas partie des mots à retrouver
    'lisnard david dit disait dire selon aurait')
    .split(' '),
);

export const LIMITS = {
  maxVideos: 30,
  maxMatchesPerVideo: 5,
  maxTopicMatchesPerVideo: 3,
  contextBefore: 1,
  contextAfter: 1,
};

/** Racine très simple : retire le pluriel pour tolérer "idée"/"idées". */
export function stem(word) {
  return word.length > 3 && /[sx]$/.test(word) ? word.slice(0, -1) : word;
}

export function queryTokens(normQuery) {
  const all = normQuery.split(' ').filter(Boolean);
  const significant = all.filter((w) => !STOPWORDS.has(w));
  const tokens = significant.length >= 2 ? significant : all;
  return [...new Set(tokens.map(stem))];
}

/** Occurrences de la requête normalisée dans le texte, en respectant les limites de mots. */
export function findExact(normText, normQuery, max = Infinity) {
  const hits = [];
  if (!normQuery) return hits;
  let from = 0;
  while (hits.length < max) {
    const idx = normText.indexOf(normQuery, from);
    if (idx === -1) break;
    const end = idx + normQuery.length;
    const okLeft = idx === 0 || normText[idx - 1] === ' ';
    const okRight = end === normText.length || normText[end] === ' ';
    if (okLeft && okRight) {
      hits.push({ start: idx, end });
      from = end;
    } else {
      from = idx + 1;
    }
  }
  return hits;
}

/**
 * Fenêtres (début/fin de caractères) où tous les mots de la requête apparaissent
 * à moins de `maxSpan` mots les uns des autres.
 */
export function findApprox(normText, tokens, maxSpan) {
  if (tokens.length < 2) return [];
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(normText))) words.push({ stem: stem(m[0]), start: m.index, end: m.index + m[0].length });

  const wanted = new Map(tokens.map((t, i) => [t, i]));
  const events = [];
  words.forEach((w, i) => {
    const k = wanted.get(w.stem);
    if (k !== undefined) events.push({ pos: i, k });
  });

  const counts = new Array(tokens.length).fill(0);
  let have = 0;
  let left = 0;
  const found = [];
  for (let right = 0; right < events.length; right++) {
    if (counts[events[right].k]++ === 0) have++;
    while (have === tokens.length) {
      const span = events[right].pos - events[left].pos + 1;
      if (span <= maxSpan) found.push({ first: events[left].pos, last: events[right].pos, span });
      if (--counts[events[left].k] === 0) have--;
      left++;
    }
  }
  found.sort((a, b) => a.span - b.span || a.first - b.first);
  const taken = [];
  for (const f of found) {
    if (taken.some((t) => f.first <= t.last + 3 && f.last >= t.first - 3)) continue;
    taken.push(f);
  }
  taken.sort((a, b) => a.first - b.first);
  return taken.map((f) => ({ start: words[f.first].start, end: words[f.last].end }));
}

/** Index (dans `segments`) du segment qui contient la position `pos` du texte normalisé. */
function segmentAt(segments, pos) {
  let lo = 0;
  let hi = segments.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].norm_start <= pos) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** Plages [début, fin[ à surligner dans le texte d'origine d'un segment. */
function marksFor(segText, from, to) {
  const { text, map } = normalizeWithMap(segText);
  if (!text) return [];
  const a = Math.max(from, 0);
  const b = Math.min(to, text.length);
  if (a >= b) return [];
  const last = b - 1;
  let origEnd = map[last] + String.fromCodePoint(segText.codePointAt(map[last])).length;
  while (origEnd < segText.length && /\p{M}/u.test(segText[origEnd])) origEnd++;
  return [[map[a], origEnd]];
}

/**
 * Transforme une plage du texte normalisé en un extrait lisible :
 * segments concernés + un segment de contexte avant/après, avec les plages à surligner.
 */
export function buildExcerpt(segments, range, { before = LIMITS.contextBefore, after = LIMITS.contextAfter } = {}) {
  const live = segments.filter((s) => s.norm_start >= 0);
  const first = segmentAt(live, range.start);
  const last = segmentAt(live, Math.max(range.end - 1, range.start));
  if (first === -1) return null;
  const from = Math.max(0, first - before);
  const to = Math.min(live.length - 1, last + after);
  const out = [];
  for (let i = from; i <= to; i++) {
    const seg = live[i];
    const localStart = range.start - seg.norm_start;
    const localEnd = range.end - seg.norm_start;
    const inside = i >= first && i <= last;
    out.push({
      text: seg.text,
      start_ms: seg.start_ms,
      marks: inside ? marksFor(seg.text, localStart, localEnd) : [],
    });
  }
  return { start_ms: live[first].start_ms, segments: out };
}

export function maxSpanFor(tokenCount) {
  return Math.max(12, tokenCount * 4);
}

export { normalize };
