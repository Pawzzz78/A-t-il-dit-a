/**
 * Génération automatique des résumés : toute vidéo indexée (transcrite, hors Shorts) reçoit son résumé en arrière-plan.
 *
 *  - Une vidéo est « à résumer » uniquement si elle n'a PAS encore de résumé : un résumé existant n'est jamais refait
 *    automatiquement (ni si la transcription change, ni si les consignes évoluent). Les plus récentes d'abord.
 *  - Délai de grâce de 3 minutes après la dernière modification : pas de résumé pendant que tu corriges la transcription.
 *  - Échec : nouvelle tentative espacée (30 min, 1 h, 2 h, 4 h), puis abandon après 5 tentatives (visible dans l'admin).
 *  - Clé refusée ou crédits épuisés : tout s'arrête un moment au lieu d'insister ; 3 échecs d'affilée arrêtent aussi la passe.
 *  - Coût borné : plafond quotidien (SUMMARY_DAILY_CAP, 500 par défaut) et mise en pause possible depuis l'admin.
 */
import { createBudget } from './budget.js';
import { SHORT_MAX_S } from './constants.js';
import { pool } from './db.js';
import { LlmError, completeWithOpenRouter, llmConfigured } from './openrouter.js';
import { getSetting, recordLlmError, setSetting } from './settings.js';
import { generateSummary } from './summaries.js';
import { summaryModel } from './summarize.js';

const LOCK_ID = 727003;
const MAX_ATTEMPTS = 5;
const HOUR = 3600 * 1000;

export const summaryAutoConfig = () => ({
  dailyCap: Number(process.env.SUMMARY_DAILY_CAP) || 500,
  perCycle: Number(process.env.SUMMARY_PER_CYCLE) || 5,
  graceMinutes: 3,
  cycleBudgetMs: 4 * 60 * 1000,
});

const budget = createBudget(() => ({ perIpHourly: Number.MAX_SAFE_INTEGER, dailyCap: summaryAutoConfig().dailyCap }));

export const summariesPaused = async () => (await getSetting('summaries_paused', false)) === true;

/** Les résumés automatiques sont-ils actifs ? (clé OpenRouter configurée et pas en pause) */
export async function summariesActive() {
  return llmConfigured() && !(await summariesPaused());
}

const INDEXED_SQL = `v.norm_text <> '' AND (v.duration_s IS NULL OR v.duration_s > ${SHORT_MAX_S})`;
// « à résumer » = aucun résumé en base. Un résumé existant (automatique ou corrigé à la main) n'est jamais repris.
const MISSING_SQL = 's.video_id IS NULL';

/** Prochaine vidéo à résumer (une seule), ou undefined. `graceMinutes: 0` ignore le délai de grâce. */
async function nextDue(graceMinutes, idPrefix = null) {
  const { rows } = await pool.query(
    `SELECT v.id, v.youtube_id, v.text_hash FROM videos v
     LEFT JOIN video_summaries s ON s.video_id = v.id
     WHERE ${INDEXED_SQL} AND ${MISSING_SQL}
       AND v.updated_at <= now() - $1 * interval '1 minute'
       AND v.summary_attempts < ${MAX_ATTEMPTS}
       AND (v.summary_next_at IS NULL OR v.summary_next_at <= now())
       AND ($2::text IS NULL OR v.youtube_id LIKE $2 || '%')
     ORDER BY v.published_at DESC NULLS LAST, v.id DESC LIMIT 1`,
    [graceMinutes, idPrefix],
  );
  return rows[0];
}

/**
 * Une passe : résume les vidéos en attente (au plus `perCycle`, dans la limite de temps). Renvoie les compteurs.
 * `deps.graceMinutes` : 0 pour le bouton « Lancer maintenant ». `deps.complete` (faux modèle), `deps.idPrefix`
 * (limite la passe aux vidéos dont l'id commence ainsi) et `deps.perCycle` servent aux tests.
 */
export async function runSummaryCycle(deps = {}) {
  const complete = deps.complete ?? completeWithOpenRouter;
  const cfg = summaryAutoConfig();
  if (!deps.complete && !llmConfigured()) return { skipped: "pas de clé OpenRouter" };
  if (await summariesPaused()) return { skipped: 'en pause' };
  const cooldown = await getSetting('summary_cooldown_until', null);
  if (cooldown && new Date(cooldown) > new Date()) return { skipped: 'suspendu après une erreur' };

  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID]);
    if (!rows[0].locked) return { skipped: 'déjà en cours' };

    const out = { done: 0, failed: 0, stopped: null };
    const started = Date.now();
    let streak = 0; // échecs d'affilée
    while (out.done + out.failed < (deps.perCycle ?? cfg.perCycle) && Date.now() - started < cfg.cycleBudgetMs) {
      const video = await nextDue(deps.graceMinutes ?? cfg.graceMinutes, deps.idPrefix);
      if (!video) break;
      if (!budget.take('auto')) {
        out.stopped = { code: 'cap', message: `plafond quotidien atteint (${cfg.dailyCap} résumés)` };
        break;
      }
      try {
        await generateSummary(video, { complete });
        out.done++;
        streak = 0;
        await setSetting('llm_last_error', null).catch(() => {});
      } catch (e) {
        const code = e instanceof LlmError ? e.code : 'upstream';
        await recordLlmError('résumé', summaryModel(), e.message);
        console.warn(`Résumé impossible (${video.youtube_id}) : ${e.message}`);
        if (code === 'auth' || code === 'quota') {
          // problème général (clé, crédits) : inutile d'insister sur les autres vidéos
          await setSetting('summary_cooldown_until', new Date(Date.now() + (code === 'quota' ? 1 : 3) * HOUR).toISOString());
          out.stopped = { code, message: e.message };
          break;
        }
        await pool.query(
          `UPDATE videos SET summary_attempts = summary_attempts + 1, summary_error = $2,
             summary_next_at = now() + (30 * power(2, summary_attempts) * interval '1 minute')
           WHERE id = $1 AND text_hash = $3`,
          [video.id, String(e.message).slice(0, 300), video.text_hash],
        );
        out.failed++;
        if (++streak >= 3) {
          out.stopped = { code: 'streak', message: `3 échecs d'affilée : ${e.message}` };
          break;
        }
      }
    }
    return out;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

/** Remet à zéro les tentatives d'une vidéo (bouton « Réessayer » de l'admin). */
export async function retrySummary(videoId) {
  const { rowCount } = await pool.query(
    `UPDATE videos SET summary_attempts = 0, summary_next_at = NULL, summary_error = NULL WHERE id = $1`,
    [videoId],
  );
  return rowCount > 0;
}

/** Vue d'ensemble pour l'admin. */
export async function summariesOverview() {
  const [{ rows: counts }, { rows: failed }, paused, cooldown] = await Promise.all([
    pool.query(
      `SELECT
         count(*) FILTER (WHERE s.video_id IS NOT NULL)::int AS ready,
         count(*) FILTER (WHERE ${MISSING_SQL} AND v.summary_attempts < ${MAX_ATTEMPTS})::int AS waiting,
         count(*) FILTER (WHERE ${MISSING_SQL} AND v.summary_attempts >= ${MAX_ATTEMPTS})::int AS failed
       FROM videos v LEFT JOIN video_summaries s ON s.video_id = v.id WHERE ${INDEXED_SQL}`,
    ),
    pool.query(
      `SELECT v.id, v.title, v.summary_error, v.summary_attempts FROM videos v
       LEFT JOIN video_summaries s ON s.video_id = v.id
       WHERE ${INDEXED_SQL} AND ${MISSING_SQL} AND v.summary_attempts >= ${MAX_ATTEMPTS}
       ORDER BY v.published_at DESC NULLS LAST LIMIT 50`,
    ),
    summariesPaused(),
    getSetting('summary_cooldown_until', null),
  ]);
  return {
    configured: llmConfigured(),
    paused,
    cooldown_until: cooldown && new Date(cooldown) > new Date() ? cooldown : null,
    model: summaryModel(),
    ...counts[0],
    failed_list: failed,
  };
}

export function resetAutoSummaryState() {
  budget.reset();
}

/** Planificateur : une passe toutes les 2 minutes (désactivable avec SUMMARY_AUTO=false). */
export function startSummaryScheduler() {
  if (process.env.SUMMARY_AUTO === 'false') return;
  const tick = () => runSummaryCycle().catch((e) => console.error(`résumés : ${e.message}`));
  setTimeout(tick, 45_000).unref();
  setInterval(tick, 2 * 60_000).unref();
}
