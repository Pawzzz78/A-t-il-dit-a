/**
 * Résumés de vidéos : générés à la demande, stockés en base, servis ensuite sans aucun appel au modèle.
 * Un résumé est régénéré seulement si la transcription a changé depuis sa création.
 * Coût borné : un seul appel par vidéo et par version de transcription (même si plusieurs visiteurs cliquent
 * en même temps), plafond par visiteur et plafond quotidien pour les générations.
 */
import { createBudget } from './budget.js';
import { pool } from './db.js';
import { HttpError } from './http-error.js';
import { LlmError, completeWithOpenRouter, llmConfigured } from './openrouter.js';
import { recordLlmError } from './settings.js';
import { PROMPT_VERSION, summarizeTranscript, summaryModel } from './summarize.js';

const budget = createBudget(() => ({
  perIpHourly: Number(process.env.SUMMARY_PER_IP_HOURLY) || 10,
  dailyCap: Number(process.env.SUMMARY_DAILY_CAP) || 100,
}));

const inflight = new Map(); // `${youtubeId}:${hash}` -> Promise

export const summariesEnabled = llmConfigured;

export function resetSummaryState() {
  budget.reset();
  inflight.clear();
}

async function generate(video, { complete }) {
  const { rows: segments } = await pool.query(
    'SELECT start_ms, text FROM segments WHERE video_id = $1 ORDER BY position',
    [video.id],
  );
  const model = summaryModel();
  let markdown;
  try {
    markdown = await summarizeTranscript(segments, { complete, model });
  } catch (e) {
    if (e instanceof LlmError) {
      console.warn(`Résumé impossible (${video.youtube_id}) : ${e.message}`);
      await recordLlmError('résumé', model, e.message);
      throw new HttpError(502, 'Le résumé est momentanément indisponible, réessaie plus tard.');
    }
    throw e;
  }
  const { rows } = await pool.query(
    `INSERT INTO video_summaries (video_id, content, model, source_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (video_id) DO UPDATE
       SET content = EXCLUDED.content, model = EXCLUDED.model, source_hash = EXCLUDED.source_hash, created_at = now()
     RETURNING created_at`,
    [video.id, markdown, model, video.hash],
  );
  return { markdown, model, created_at: rows[0].created_at, cached: false };
}

/** Renvoie le résumé de la vidéo (depuis la base, ou en le générant). */
export async function getSummary(youtubeId, { ip = 'anon', complete = completeWithOpenRouter } = {}) {
  const { rows } = await pool.query(
    `SELECT id, youtube_id, lang, translated, original_lang, md5(norm_text) AS hash, norm_text <> '' AS has_text
     FROM videos WHERE youtube_id = $1`,
    [youtubeId],
  );
  const video = rows[0];
  if (!video) throw new HttpError(404, 'Vidéo introuvable.');
  // transcription + version des consignes : un résumé écrit avec d'anciennes consignes est régénéré au prochain clic
  video.hash = `${video.hash}:${PROMPT_VERSION}`;
  if (!video.has_text) throw new HttpError(409, "La transcription de cette vidéo n'est pas encore disponible.");

  const flags = { translated: video.translated, original_lang: video.original_lang, lang: video.lang };

  const { rows: cached } = await pool.query(
    'SELECT content, model, source_hash, created_at FROM video_summaries WHERE video_id = $1',
    [video.id],
  );
  if (cached[0] && cached[0].source_hash === video.hash) {
    return { markdown: cached[0].content, model: cached[0].model, created_at: cached[0].created_at, cached: true, ...flags };
  }

  if (complete === completeWithOpenRouter && !llmConfigured()) {
    throw new HttpError(503, "Les résumés ne sont pas activés sur ce site.");
  }

  const key = `${video.youtube_id}:${video.hash}`;
  let pending = inflight.get(key);
  if (!pending) {
    if (!budget.take(ip)) throw new HttpError(429, 'Trop de résumés demandés pour le moment, réessaie plus tard.');
    pending = generate(video, { complete }).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return { ...(await pending), ...flags };
}
