/**
 * Synchronisation automatique des chaînes YouTube.
 *
 *  1. Découverte : liste les uploads d'une chaîne (API YouTube) et met les vidéos inconnues
 *     en file d'attente (sync_status = 'pending'). Au 1er passage on liste tout l'historique,
 *     ensuite seulement les nouveautés (≈ 1 requête/jour).
 *  2. Traitement : récupère la transcription des vidéos en attente (Supadata, mode native).
 *
 * Garanties : on n'écrit JAMAIS sur une vidéo déjà présente. Une transcription n'est posée que
 * sur une vidéo créée par la synchro, encore en attente, sans aucun segment et jamais éditée,
 * sous verrou de ligne. Les vidéos ajoutées à la main (sync_status NULL), celles déjà transcrites
 * (automatiquement ou corrigées à la main) ne sont ni relues ni modifiées.
 */
import { pool, replaceSegments, withTransaction } from './db.js';
import { TranscriptError, fetchTranscript, supadataConfigured } from './transcripts.js';
import { iterateUploads, youtubeApiConfigured } from './youtube.js';

const LOCK_ID = 727001;
const HOUR = 3600 * 1000;

export const syncConfig = () => ({
  intervalHours: Number(process.env.SYNC_INTERVAL_HOURS) || 24,
  batch: Number(process.env.SYNC_BATCH) || 25,
  tickMinutes: 5,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- réglages ----------------------------------------------------------------------

export async function getSetting(key, fallback) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : fallback;
}

export async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

/** Par défaut le traitement est en pause : rien n'est facturé tant que tu n'as pas cliqué sur « Démarrer ». */
export const isPaused = async () => (await getSetting('processing_paused', true)) !== false;

// --- 1. découverte -----------------------------------------------------------------

async function unknownIds(ids) {
  const { rows } = await pool.query(
    `SELECT youtube_id FROM videos WHERE youtube_id = ANY($1)
     UNION SELECT youtube_id FROM excluded_videos WHERE youtube_id = ANY($1)`,
    [ids],
  );
  const known = new Set(rows.map((r) => r.youtube_id));
  return ids.filter((id) => !known.has(id));
}

/** Met en file d'attente les vidéos de la chaîne qu'on ne connaît pas encore. Renvoie { added, skipped }. */
export async function discoverChannel(channel, deps = {}) {
  const iterate = deps.iterateUploads ?? iterateUploads;
  const full = !channel.backfilled_at;
  const intervalMs = syncConfig().intervalHours * HOUR;
  let added = 0;
  let skipped = 0;
  try {
    for await (const page of iterate({ playlistId: channel.uploads_playlist_id, unknownIds })) {
      let handled = 0;
      for (const v of page.details) {
        if (v.live) continue; // direct en cours / à venir : on le reprendra plus tard
        if (channel.min_duration_s > 0 && (v.duration_s ?? 0) < channel.min_duration_s) {
          await pool.query(
            `INSERT INTO excluded_videos (youtube_id, reason) VALUES ($1, 'too_short') ON CONFLICT DO NOTHING`,
            [v.youtube_id],
          );
          skipped++;
          handled++;
          continue;
        }
        // La liste d'exclusion est vérifiée ici même : une vidéo supprimée à la main ne revient jamais.
        const { rowCount } = await pool.query(
          `INSERT INTO videos (youtube_id, title, channel, published_at, thumbnail_url, lang, source,
                               sync_status, sync_next_at, channel_id, duration_s)
           SELECT $1, $2, $3, $4, $5, 'fr', 'supadata', 'pending', now(), $6, $7
           WHERE NOT EXISTS (SELECT 1 FROM excluded_videos WHERE youtube_id = $1)
           ON CONFLICT (youtube_id) DO NOTHING`,
          [
            v.youtube_id,
            (v.title || v.youtube_id).slice(0, 300),
            (v.channel || channel.title || '').slice(0, 200),
            v.published_at,
            v.thumbnail_url ?? `https://i.ytimg.com/vi/${v.youtube_id}/hqdefault.jpg`,
            v.channel_id ?? channel.youtube_channel_id,
            v.duration_s,
          ],
        );
        if (rowCount) added++;
        handled++;
      }
      // Passage quotidien : on s'arrête dès qu'une page ne contient plus rien de nouveau.
      if (!full && handled === 0) break;
    }
    await pool.query(
      `UPDATE channels SET last_discovery_at = now(), last_discovery_error = NULL,
         backfilled_at = COALESCE(backfilled_at, now()), discovery_due_at = now() + $2 * interval '1 millisecond'
       WHERE id = $1`,
      [channel.id, intervalMs],
    );
  } catch (e) {
    await pool.query(
      `UPDATE channels SET last_discovery_error = $2, discovery_due_at = now() + interval '1 hour' WHERE id = $1`,
      [channel.id, String(e.message).slice(0, 500)],
    );
    throw e;
  }
  return { added, skipped };
}

// --- 2. traitement de la file ------------------------------------------------------

function retryPlan(code, attempts, publishedAt) {
  const ageDays = publishedAt ? (Date.now() - new Date(publishedAt).getTime()) / 86400000 : Infinity;
  if (code === 'unavailable') {
    // Les sous-titres automatiques arrivent parfois quelques heures après la mise en ligne :
    // on réessaie les vidéos récentes (6 h, 12 h, 24 h, 48 h) ; une vidéo ancienne sans sous-titres n'en aura pas.
    const max = ageDays <= 3 ? 5 : 1;
    return attempts >= max ? { failed: true } : { delayMs: 6 * HOUR * 2 ** (attempts - 1) };
  }
  return attempts >= 5 ? { failed: true } : { delayMs: HOUR * attempts };
}

/** Traite jusqu'à `limit` vidéos en attente. */
export async function processPending({ limit, fetchFn = fetchTranscript, gapMs = 1100 } = {}) {
  const result = { done: 0, retry: 0, failed: 0, skipped: 0, stopped: null };
  const { rows } = await pool.query(
    `SELECT id, youtube_id, published_at, sync_attempts, lang FROM videos
     WHERE sync_status = 'pending' AND sync_next_at <= now()
     ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $1`,
    [limit],
  );
  for (const v of rows) {
    try {
      const t = await fetchFn(v.youtube_id, v.lang || 'fr');
      const applied = await withTransaction(async (c) => {
        const { rows: cur } = await c.query(
          `SELECT sync_status, edited, (SELECT count(*) FROM segments WHERE video_id = $1)::int AS n
           FROM videos WHERE id = $1 FOR UPDATE`,
          [v.id],
        );
        // Quelqu'un est passé par là (édition, suppression, import manuel) : on ne touche à rien.
        if (!cur[0] || cur[0].sync_status !== 'pending' || cur[0].edited || cur[0].n > 0) return false;
        await replaceSegments(c, v.id, t.segments, { edited: false, source: 'supadata' });
        await c.query(
          `UPDATE videos SET sync_status = 'done', sync_error = NULL, sync_next_at = NULL, lang = $2 WHERE id = $1`,
          [v.id, t.lang],
        );
        return true;
      });
      if (applied) result.done++;
      else result.skipped++;
    } catch (e) {
      const code = e instanceof TranscriptError ? e.code : 'upstream';
      if (code === 'quota' || code === 'auth' || code === 'config') {
        result.stopped = { code, message: e.message };
        break;
      }
      const attempts = v.sync_attempts + 1;
      const plan = retryPlan(code, attempts, v.published_at);
      if (plan.failed) {
        await pool.query(
          `UPDATE videos SET sync_status = 'failed', sync_attempts = $2, sync_error = $3, sync_next_at = NULL
           WHERE id = $1 AND sync_status = 'pending'`,
          [v.id, attempts, String(e.message).slice(0, 300)],
        );
        result.failed++;
      } else {
        await pool.query(
          `UPDATE videos SET sync_attempts = $2, sync_error = $3, sync_next_at = now() + $4 * interval '1 millisecond'
           WHERE id = $1 AND sync_status = 'pending'`,
          [v.id, attempts, String(e.message).slice(0, 300), plan.delayMs],
        );
        result.retry++;
      }
    }
    if (gapMs) await sleep(gapMs); // l'offre gratuite Supadata est limitée à 1 requête/seconde
  }
  return result;
}

// --- cycle complet -----------------------------------------------------------------

/** Une passe : découverte des chaînes échues, puis traitement d'un lot de la file. */
export async function runCycle(deps = {}) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID]);
    if (!rows[0].locked) return { skipped: 'déjà en cours' };
    const out = { discovered: 0, errors: [] };

    if (deps.iterateUploads || youtubeApiConfigured()) {
      const { rows: due } = await pool.query(
        'SELECT * FROM channels WHERE enabled AND discovery_due_at <= now() ORDER BY id',
      );
      for (const ch of due) {
        try {
          out.discovered += (await discoverChannel(ch, deps)).added;
        } catch (e) {
          out.errors.push(`${ch.title || ch.youtube_channel_id} : ${e.message}`);
        }
      }
    }

    const cooldown = await getSetting('cooldown_until', null);
    if (!(await isPaused()) && (deps.fetchFn || supadataConfigured()) && !(cooldown && new Date(cooldown) > new Date())) {
      out.processing = await processPending({ limit: syncConfig().batch, fetchFn: deps.fetchFn, gapMs: deps.gapMs });
      if (out.processing.stopped) {
        const { code, message } = out.processing.stopped;
        await setSetting('cooldown_until', new Date(Date.now() + (code === 'quota' ? 1 : 6) * HOUR).toISOString());
        await setSetting('last_error', `${new Date().toISOString()} — ${message}`);
        out.errors.push(message);
      } else if (out.processing.done) {
        await setSetting('last_error', null);
      }
    }
    return out;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

export function startScheduler() {
  if (process.env.SYNC_ENABLED === 'false') return;
  const tick = () => runCycle().catch((e) => console.error(`sync : ${e.message}`));
  setTimeout(tick, 30_000).unref();
  setInterval(tick, syncConfig().tickMinutes * 60_000).unref();
}

// --- vue d'ensemble pour l'admin ---------------------------------------------------

export async function overview() {
  const [{ rows: channels }, { rows: counts }, { rows: failed }, paused, cooldown, lastError] = await Promise.all([
    pool.query(`SELECT c.*, (SELECT count(*)::int FROM videos v WHERE v.channel_id = c.youtube_channel_id) AS video_count
                FROM channels c ORDER BY c.id`),
    pool.query(`SELECT coalesce(sync_status, 'manual') AS status, count(*)::int AS n FROM videos GROUP BY 1`),
    pool.query(`SELECT id, youtube_id, title, sync_error, sync_attempts FROM videos
                WHERE sync_status = 'failed' ORDER BY published_at DESC NULLS LAST LIMIT 100`),
    isPaused(),
    getSetting('cooldown_until', null),
    getSetting('last_error', null),
  ]);
  const byStatus = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  return {
    keys: { youtube: youtubeApiConfigured(), supadata: supadataConfigured() },
    paused,
    cooldown_until: cooldown && new Date(cooldown) > new Date() ? cooldown : null,
    last_error: lastError,
    interval_hours: syncConfig().intervalHours,
    counts: { pending: byStatus.pending ?? 0, done: byStatus.done ?? 0, failed: byStatus.failed ?? 0, manual: byStatus.manual ?? 0 },
    channels,
    failed,
  };
}
