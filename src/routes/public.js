import { Router } from 'express';
import { pool } from '../db.js';
import { normalize } from '../normalize.js';
import { LIMITS, buildExcerpt, findApprox, findExact, maxSpanFor, queryTokens } from '../search.js';
import { watchUrl } from '../youtube.js';

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

async function runSearch(rawQuery) {
  const nq = normalize(rawQuery);
  const [{ n: videoCount }] = (await pool.query('SELECT count(*)::int AS n FROM videos WHERE norm_text <> $1', [''])).rows;

  const toResults = async (rows, locate, type) => {
    const segs = await loadSegments(rows.map((r) => r.id));
    const results = [];
    for (const v of rows) {
      const ranges = locate(v.norm_text);
      if (!ranges.length) continue;
      const matches = [];
      for (const range of ranges.slice(0, LIMITS.maxMatchesPerVideo)) {
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
  };

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
    res.json({ query: q, ...(await runSearch(q)) });
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
