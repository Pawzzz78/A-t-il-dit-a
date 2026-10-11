/**
 * « Tendances » : combien de fois un mot ou une expression est prononcé dans les vidéos indexées, mois par mois.
 *
 *  - Base : vidéos indexées (transcrites, hors Shorts) ET datées ET non traduites automatiquement (une traduction ne
 *    donne pas les mots réellement prononcés). Les vidéos exclues sont comptées et signalées à l'écran.
 *  - Comptage : mots entiers, pluriel compris (« migrant » trouve « migrants »), sans accents ni casse.
 *  - Deux mesures : nombre de mentions, et fréquence pour 10 000 mots prononcés (comparable d'un mois à l'autre
 *    même si le nombre de vidéos varie).
 *  - Résultats mis en cache (5 min, invalidés quand une vidéo change) ; calcul limité par visiteur.
 */
import { createBudget } from './budget.js';
import { SHORT_MAX_S } from './constants.js';
import { pool } from './db.js';
import { HttpError } from './http-error.js';
import { normalize } from './normalize.js';
import { isStopWord } from './trend-stopwords.js';

export const MAX_TERMS = 4;
const MAX_TERM_CHARS = 60;
const MAX_TERM_WORDS = 6;
const TOP_VIDEOS = 8;
const CACHE_TTL_MS = 5 * 60 * 1000;
const YEAR_VIEW_AFTER_MONTHS = 60; // au-delà de 5 ans d'historique : une barre par année

const INDEXED = `norm_text <> '' AND (duration_s IS NULL OR duration_s > ${SHORT_MAX_S})`;
const ELIGIBLE = `${INDEXED} AND NOT translated AND published_at IS NOT NULL`;
const WORDS_SQL = `(length(norm_text) - length(replace(norm_text, ' ', '')) + 1)`;

const budget = createBudget(() => ({ perIpHourly: 120, dailyCap: 30000 }));
export const resetTrendsState = () => {
  budget.reset();
  cache.clear();
};

// --- cache -------------------------------------------------------------------------

const cache = new Map(); // clé -> { at, value } | { promise }
async function remember(key, compute) {
  const hit = cache.get(key);
  if (hit?.promise) return hit.promise;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const promise = compute().then(
    (value) => {
      cache.set(key, { at: Date.now(), value });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return value;
    },
    (e) => {
      cache.delete(key);
      throw e;
    },
  );
  cache.set(key, { promise });
  return promise;
}

/** Empreinte des données : change dès qu'une vidéo est ajoutée, retirée ou modifiée. */
async function dataVersion() {
  const { rows } = await pool.query(`SELECT count(*)::int AS n, max(updated_at) AS m FROM videos WHERE ${INDEXED}`);
  return `${rows[0].n}:${rows[0].m?.toISOString?.() ?? ''}`;
}

// --- termes ------------------------------------------------------------------------

/** « Immigration, Dette publique » -> [{ label, norm }] ; lève une 400 si la saisie est inutilisable. */
export function parseTerms(q) {
  const seen = new Set();
  const terms = [];
  for (const part of String(q ?? '').split(/[,;\n]/)) {
    const label = part.trim().replace(/\s+/g, ' ');
    const norm = normalize(label);
    if (!norm || seen.has(norm)) continue;
    if (norm.length < 2) throw new HttpError(400, 'Chaque mot doit faire au moins 2 caractères.');
    if (norm.length > MAX_TERM_CHARS || norm.split(' ').length > MAX_TERM_WORDS) {
      throw new HttpError(400, `Une expression ne peut pas dépasser ${MAX_TERM_WORDS} mots.`);
    }
    seen.add(norm);
    terms.push({ label: label.slice(0, MAX_TERM_CHARS), norm });
  }
  if (!terms.length) throw new HttpError(400, 'Saisis un mot ou une expression.');
  if (terms.length > MAX_TERMS) throw new HttpError(400, `${MAX_TERMS} mots ou expressions au maximum (sépare-les par des virgules).`);
  return terms;
}

/** Expression régulière Postgres : mots entiers, pluriel inclus. `norm` ne contient que des lettres, chiffres et espaces. */
export const termPattern = (norm) => `\\m${norm}(?:s|x)?\\M`;

// --- périodes ----------------------------------------------------------------------

/** Mois « 2024-03 » entre deux mois inclus. */
export function monthsBetween(first, last) {
  const out = [];
  let [y, m] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) [y, m] = [y + 1, 1];
  }
  return out;
}

async function loadBase(version) {
  return remember(`base|${version}`, async () => {
    const [{ rows: perMonth }, { rows: extra }] = await Promise.all([
      pool.query(
        `SELECT to_char(published_at, 'YYYY-MM') AS month, count(*)::int AS videos, sum(${WORDS_SQL})::bigint AS words
         FROM videos WHERE ${ELIGIBLE} GROUP BY 1 ORDER BY 1`,
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE translated)::int AS translated,
                count(*) FILTER (WHERE NOT translated AND published_at IS NULL)::int AS undated
         FROM videos WHERE ${INDEXED}`,
      ),
    ]);
    const byMonth = new Map(perMonth.map((r) => [r.month, { videos: r.videos, words: Number(r.words) }]));
    const months = perMonth.length ? monthsBetween(perMonth[0].month, perMonth.at(-1).month) : [];
    const yearly = months.length > YEAR_VIEW_AFTER_MONTHS;
    const keyOf = (month) => (yearly ? month.slice(0, 4) : month);
    const periods = new Map();
    for (const month of months) {
      const k = keyOf(month);
      const p = periods.get(k) ?? { key: k, videos: 0, words: 0 };
      const d = byMonth.get(month);
      if (d) {
        p.videos += d.videos;
        p.words += d.words;
      }
      periods.set(k, p);
    }
    return {
      granularity: yearly ? 'year' : 'month',
      keyOf,
      periods: [...periods.values()],
      videos: perMonth.reduce((n, r) => n + r.videos, 0),
      words: perMonth.reduce((n, r) => n + Number(r.words), 0),
      translated: extra[0].translated,
      undated: extra[0].undated,
    };
  });
}

async function loadTerm(version, term, base) {
  return remember(`term|${version}|${term.norm}`, async () => {
    const { rows } = await pool.query(
      `SELECT youtube_id, title, to_char(published_at, 'YYYY-MM-DD') AS published_at, regexp_count(norm_text, $1)::int AS n
       FROM videos WHERE ${ELIGIBLE} AND norm_text ~ $1`,
      [termPattern(term.norm)],
    );
    const points = new Map(base.periods.map((p) => [p.key, { mentions: 0, videos: 0 }]));
    let mentions = 0;
    for (const r of rows) {
      const pt = points.get(base.keyOf(r.published_at.slice(0, 7)));
      pt.mentions += r.n;
      pt.videos += 1;
      mentions += r.n;
    }
    const dates = rows.map((r) => r.published_at).sort();
    let peak = null;
    base.periods.forEach((p) => {
      const m = points.get(p.key).mentions;
      if (m > 0 && (!peak || m > peak.mentions)) peak = { key: p.key, mentions: m };
    });
    return {
      mentions,
      videos: rows.length,
      per10k: base.words ? (mentions / base.words) * 10000 : 0,
      first: dates[0] ?? null,
      last: dates.at(-1) ?? null,
      peak,
      points: base.periods.map((p) => {
        const pt = points.get(p.key);
        return { mentions: pt.mentions, videos: pt.videos, per10k: p.words ? (pt.mentions / p.words) * 10000 : null };
      }),
      top_videos: rows
        .sort((a, b) => b.n - a.n || b.published_at.localeCompare(a.published_at))
        .slice(0, TOP_VIDEOS)
        .map((r) => ({ youtube_id: r.youtube_id, title: r.title, published_at: r.published_at, mentions: r.n })),
    };
  });
}

/** Tendances d'un à quatre mots : { granularity, periods, series, base }. */
export async function getTrends(q, { ip = 'local' } = {}) {
  const terms = parseTerms(q);
  const version = await dataVersion();
  const needsCompute = !cache.get(`base|${version}`) || terms.some((t) => !cache.get(`term|${version}|${t.norm}`));
  if (needsCompute && !budget.take(ip)) throw new HttpError(429, 'Trop de recherches pour le moment : réessaie dans quelques minutes.');
  const base = await loadBase(version);
  const series = await Promise.all(terms.map(async (t) => ({ term: t.label, ...(await loadTerm(version, t, base)) })));
  return {
    granularity: base.granularity,
    periods: base.periods,
    series,
    base: { videos: base.videos, words: base.words, translated_excluded: base.translated, undated_excluded: base.undated },
  };
}

// --- mots les plus prononcés ---------------------------------------------------------

/** Mots les plus prononcés (hors mots-outils) : [{ word, mentions, videos }]. */
export async function getTopWords({ ip = 'local', limit = 36 } = {}) {
  const version = await dataVersion();
  const key = `words|${version}`;
  if (!cache.get(key) && !budget.take(ip)) throw new HttpError(429, 'Trop de recherches pour le moment : réessaie dans quelques minutes.');
  return remember(key, async () => {
    const { rows } = await pool.query(
      `SELECT w AS word, count(*)::int AS mentions, count(DISTINCT id)::int AS videos
       FROM (SELECT id, regexp_split_to_table(norm_text, ' ') AS w FROM videos WHERE ${ELIGIBLE}) t
       WHERE length(w) >= 5 AND w !~ '^[0-9]+$'
       GROUP BY w ORDER BY mentions DESC LIMIT 1500`,
    );
    // « idée » et « idées » comptent ensemble : on garde la forme la plus fréquente
    const merged = new Map();
    for (const r of rows) {
      if (isStopWord(r.word)) continue;
      const root = r.word.replace(/[sx]$/, '');
      const cur = merged.get(root);
      if (!cur) merged.set(root, { ...r });
      else {
        cur.mentions += r.mentions;
        cur.videos = Math.max(cur.videos, r.videos);
      }
    }
    const top = [...merged.values()].sort((a, b) => b.mentions - a.mentions).slice(0, limit);
    return restoreAccents(top);
  });
}

const ACCENTS = { a: 'aàâä', c: 'cç', e: 'eéèêë', i: 'iîï', o: 'oôö', u: 'uùûü', y: 'yÿ' };

/** Motif Postgres qui reconnaît un mot normalisé avec toutes ses graphies accentuées possibles. */
export function accentPattern(word) {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === 'o' && word[i + 1] === 'e') {
      out += '(?:oe|œ|o[éèêë])';
      i++;
    } else if (c === 'a' && word[i + 1] === 'e') {
      out += '(?:ae|æ|a[éèêë])';
      i++;
    } else out += ACCENTS[c] ? `[${ACCENTS[c]}]` : c;
  }
  return out;
}

/**
 * Le texte indexé n'a plus d'accents (« securite ») : on retrouve la graphie réelle la plus fréquente dans les
 * transcriptions (« sécurité ») pour l'affichage, en un seul passage sur les segments.
 */
async function restoreAccents(words) {
  if (!words.length) return words;
  try {
    const pattern = `(${words.map((w) => `\\m${accentPattern(w.word)}\\M`).join('|')})`;
    const { rows } = await pool.query(
      `SELECT m[1] AS form, count(*)::int AS n FROM segments, regexp_matches(text, $1, 'gi') AS m GROUP BY 1`,
      [pattern],
    );
    const best = new Map(); // mot normalisé -> graphie la plus fréquente
    for (const r of rows) {
      const form = r.form.toLowerCase();
      const norm = normalize(form);
      if (!best.get(norm) || r.n > best.get(norm).n) best.set(norm, { form, n: r.n });
    }
    return words.map((w) => ({ ...w, word: best.get(w.word)?.form ?? w.word }));
  } catch {
    return words; // pas d'accents plutôt qu'une erreur
  }
}
