import { Router } from 'express';
import { pool } from '../db.js';
import { normalize } from '../normalize.js';
import { interpretQuery, isQuestionLike } from '../query-understanding.js';
import { LIMITS, buildExcerpt, findApprox, findExact, maxSpanFor, queryTokens } from '../search.js';
import { HttpError } from '../http-error.js';
import { getSummary, summariesEnabled } from '../summaries.js';
import { parseYoutubeId, watchUrl } from '../youtube.js';

export const publicRouter = Router();

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

const VIDEO_COLS = 'id, youtube_id, title, channel, published_at, thumbnail_url, translated, original_lang, norm_text';

function presentVideo(v) {
  return {
    id: v.id,
    youtube_id: v.youtube_id,
    title: v.title,
    channel: v.channel,
    published_at: v.published_at,
    thumbnail_url: v.thumbnail_url,
    translated: Boolean(v.translated),
    original_lang: v.original_lang ?? null,
  };
}

async function loadSegments(videoIds) {
  if (!videoIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT video_id, text, start_ms, norm_start FROM segments
     WHERE video_id = ANY($1) AND norm_start >= 0 ORDER BY video_id, position`,
    [videoIds],
  );
  const byVideo = new Map();
  for (const r of rows) {
    if (!byVideo.has(r.video_id)) byVideo.set(r.video_id, []);
    byVideo.get(r.video_id).push(r);
  }
  return byVideo;
}

async function toResults(rows, locate, type, perVideo = LIMITS.maxMatchesPerVideo) {
  const segs = await loadSegments(rows.map((r) => r.id));
  const results = [];
  for (const v of rows) {
    const ranges = locate(v.norm_text);
    if (!ranges.length) continue;
    const matches = [];
    for (const range of ranges.slice(0, perVideo)) {
      const excerpt = buildExcerpt(segs.get(v.id) ?? [], range);
      if (excerpt) {
        matches.push({
          type,
          start_ms: excerpt.start_ms,
          url: watchUrl(v.youtube_id, excerpt.start_ms),
          segments: excerpt.segments,
        });
      }
    }
    if (matches.length) results.push({ video: presentVideo(v), total_matches: ranges.length, matches });
  }
  return results;
}

/** Fusionne les plages qui se chevauchent (plusieurs variantes d'un même mot au même endroit). */
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Mots normalisés à chercher : chaque mot-clé, plus son pluriel / singulier s'il tient en un mot. */
export function expandTerms(keywords) {
  const terms = new Set();
  for (const k of keywords) {
    const n = normalize(k);
    if (n.length < 3) continue;
    terms.add(n);
    if (!n.includes(' ')) {
      if (n.length > 3 && n.endsWith('s')) terms.add(n.slice(0, -1));
      else terms.add(`${n}s`);
    }
  }
  return [...terms];
}

/** Recherche par sujet : on cherche les mots-clés (et variantes) dans les transcriptions. */
async function topicSearch(interpreted, videoCount) {
  const terms = expandTerms(interpreted.keywords);
  const info = { intent: 'topic', keywords: interpreted.keywords, source: interpreted.source };
  if (!terms.length) return { verdict: 'none', video_count: videoCount, results: [], interpreted: info };
  const limit = LIMITS.maxVideos;
  const rows = (
    await pool.query(
      `SELECT ${VIDEO_COLS} FROM videos WHERE norm_text LIKE ANY ($1::text[])
       ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $2`,
      [terms.map((t) => `%${escapeLike(t)}%`), limit + 1],
    )
  ).rows;
  const truncated = rows.length > limit;
  const results = await toResults(
    rows.slice(0, limit),
    (t) => mergeRanges(terms.flatMap((term) => findExact(t, term))),
    'topic',
    LIMITS.maxTopicMatchesPerVideo,
  );
  const verdict = !results.length ? 'none' : results.some((r) => !r.video.translated) ? 'topic' : 'translated';
  return {
    verdict,
    video_count: videoCount,
    results,
    interpreted: info,
    topic: {
      total_matches: results.reduce((n, r) => n + r.total_matches, 0),
      shown_videos: results.length,
      truncated,
    },
  };
}

export async function runSearch(rawQuery, { interpret = interpretQuery, ip } = {}) {
  const nq = normalize(rawQuery);
  const [{ n: videoCount }] = (await pool.query('SELECT count(*)::int AS n FROM videos WHERE norm_text <> $1', [''])).rows;

  // 1. Citation mot pour mot (cas d'une phrase qui circule) : aucun appel au modèle.
  const exactRows = (
    await pool.query(
      `SELECT ${VIDEO_COLS} FROM videos WHERE norm_text LIKE $1
       ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $2`,
      [`%${escapeLike(nq)}%`, LIMITS.maxVideos],
    )
  ).rows;
  const exact = await toResults(exactRows, (t) => findExact(t, nq), 'exact');
  if (exact.length) {
    // Une phrase retrouvée uniquement dans une traduction automatique n'est pas ce qui a été prononcé.
    const verdict = exact.some((r) => !r.video.translated) ? 'exact' : 'translated';
    return { verdict, video_count: videoCount, results: exact };
  }

  // 2. Une question (« a-t-il déjà parlé de X ? ») : on cherche X, pas toute la phrase.
  const questionLike = isQuestionLike(rawQuery);
  if (questionLike) {
    const it = await interpret(rawQuery, { ip });
    if (it.intent === 'topic' && it.keywords.length) return topicSearch(it, videoCount);
  }

  // 3. Tous les mots de la saisie, proches les uns des autres.
  const tokens = queryTokens(nq);
  if (tokens.length >= 2) {
    const span = maxSpanFor(tokens.length);
    const approxRows = (
      await pool.query(
        `SELECT ${VIDEO_COLS} FROM videos WHERE norm_text LIKE ALL ($1::text[])
         ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $2`,
        [tokens.map((t) => `%${escapeLike(t)}%`), LIMITS.maxVideos],
      )
    ).rows;
    const approx = await toResults(approxRows, (t) => findApprox(t, tokens, span), 'approx');
    if (approx.length) return { verdict: 'approx', video_count: videoCount, results: approx };
  }

  // 4. Rien trouvé et la saisie ne ressemblait pas à une question (« lisnard nucléaire ») :
  //    le modèle peut y voir un sujet. On n'accepte que son verdict, jamais le repli sans modèle.
  if (!questionLike) {
    const it = await interpret(rawQuery, { ip });
    if (it.source === 'llm' && it.intent === 'topic' && it.keywords.length) return topicSearch(it, videoCount);
  }
  return { verdict: 'none', video_count: videoCount, results: [] };
}

publicRouter.get(
  '/search',
  ah(async (req, res) => {
    const q = String(req.query.q ?? '').trim().slice(0, 300);
    if (normalize(q).length < 3) {
      return res.status(400).json({ error: 'Saisis au moins 3 caractères.' });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ query: q, ...(await runSearch(q, { ip: req.ip })) });
  }),
);

/** Dernières vidéos par date de publication (chaînes suivies ET vidéos ajoutées à la main), avec transcription. */
publicRouter.get(
  '/latest',
  ah(async (req, res) => {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 5, 1), 12);
    const { rows } = await pool.query(
      `SELECT youtube_id, title, channel, published_at, thumbnail_url, duration_s, translated, original_lang, lang
       FROM videos WHERE norm_text <> ''
       ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $1`,
      [limit],
    );
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ videos: rows, summaries_enabled: summariesEnabled() });
  }),
);

/** Résumé IA d'une vidéo (POST : peut déclencher une génération payante, jamais par simple préchargement). */
publicRouter.post(
  '/summary/:youtubeId',
  ah(async (req, res) => {
    const id = parseYoutubeId(req.params.youtubeId);
    if (!id) throw new HttpError(404, 'Vidéo introuvable.');
    res.set('Cache-Control', 'no-store');
    res.json(await getSummary(id, { ip: req.ip }));
  }),
);

publicRouter.get(
  '/stats',
  ah(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*)::int FROM videos WHERE norm_text <> '') AS videos,
              (SELECT count(*)::int FROM segments) AS segments`,
    );
    res.json(rows[0]);
  }),
);

publicRouter.get(
  '/health',
  ah(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }),
);

// eslint-disable-next-line no-unused-vars
publicRouter.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  console.error(err);
  res.status(500).json({ error: 'Erreur interne.' });
});
