/**
 * Résumés de vidéos, stockés en base.
 *
 * - Ils sont générés AUTOMATIQUEMENT en arrière-plan (auto-summaries.js) dès qu'une vidéo est transcrite, jamais à
 *   la demande d'un visiteur : le public ne fait que lire un résumé déjà prêt (aucun coût ni appel au modèle).
 * - Un résumé est lié à l'empreinte de la transcription (videos.text_hash) et à la version des consignes :
 *   si la transcription est corrigée, ou les consignes améliorées, il est régénéré en arrière-plan. En attendant,
 *   un résumé écrit avec d'anciennes consignes reste affiché ; un résumé d'une ancienne transcription ne l'est plus.
 */
import { pool } from './db.js';
import { HttpError } from './http-error.js';
import { completeWithOpenRouter } from './openrouter.js';
import { PROMPT_VERSION, summarizeTranscript, summaryModel } from './summarize.js';

/** Empreinte attendue d'un résumé à jour : transcription + version des consignes. */
export const currentSourceHash = (textHash) => `${textHash}:${PROMPT_VERSION}`;

/**
 * Fragment SQL : la vidéo a un résumé affichable (même transcription ; la version des consignes importe peu).
 * `v` = alias de la table videos.
 */
export const HAS_SUMMARY_SQL = (v = 'videos') =>
  `EXISTS (SELECT 1 FROM video_summaries s WHERE s.video_id = ${v}.id AND split_part(s.source_hash, ':', 1) = ${v}.text_hash)`;

/** Lecture publique : renvoie le résumé stocké, ou une erreur claire. Ne génère jamais rien. */
export async function getStoredSummary(youtubeId) {
  const { rows } = await pool.query(
    `SELECT v.id, v.lang, v.translated, v.original_lang, v.text_hash, v.norm_text <> '' AS has_text,
            s.content, s.model, s.created_at, s.source_hash
     FROM videos v LEFT JOIN video_summaries s ON s.video_id = v.id
     WHERE v.youtube_id = $1`,
    [youtubeId],
  );
  const v = rows[0];
  if (!v) throw new HttpError(404, 'Vidéo introuvable.');
  if (!v.has_text) throw new HttpError(409, "La transcription de cette vidéo n'est pas encore disponible.");
  if (!v.content || String(v.source_hash).split(':')[0] !== v.text_hash) {
    throw new HttpError(404, "Le résumé de cette vidéo n'est pas encore prêt : il sera disponible dans quelques minutes.", { pending: true });
  }
  return { markdown: v.content, model: v.model, created_at: v.created_at, translated: v.translated, original_lang: v.original_lang, lang: v.lang };
}

const inflight = new Map(); // `${videoId}:${hash}` -> Promise : une seule génération à la fois par vidéo

/**
 * Génère et stocke le résumé d'une vidéo { id, youtube_id, text_hash }. Lève LlmError si le modèle échoue.
 * Deux appels simultanés pour la même vidéo (travail de fond + bouton de l'admin) ne font qu'un seul appel au modèle.
 */
export function generateSummary(video, { complete = completeWithOpenRouter } = {}) {
  const key = `${video.id}:${video.text_hash}`;
  const running = inflight.get(key);
  if (running) return running;
  const promise = (async () => {
    const { rows: segments } = await pool.query('SELECT start_ms, text FROM segments WHERE video_id = $1 ORDER BY position', [video.id]);
    const model = summaryModel();
    const markdown = await summarizeTranscript(segments, { complete, model });
    const { rows } = await pool.query(
      `INSERT INTO video_summaries (video_id, content, model, source_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (video_id) DO UPDATE
         SET content = EXCLUDED.content, model = EXCLUDED.model, source_hash = EXCLUDED.source_hash, created_at = now()
       RETURNING created_at`,
      [video.id, markdown, model, currentSourceHash(video.text_hash)],
    );
    await pool.query(
      'UPDATE videos SET summary_attempts = 0, summary_next_at = NULL, summary_error = NULL WHERE id = $1 AND text_hash = $2',
      [video.id, video.text_hash],
    );
    return { markdown, model, created_at: rows[0].created_at };
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Bouton « Régénérer » de l'admin : régénère tout de suite le résumé d'une vidéo. */
export async function regenerateNow(videoId, { complete } = {}) {
  const { rows } = await pool.query(
    `SELECT id, youtube_id, text_hash, norm_text <> '' AS has_text FROM videos WHERE id = $1`,
    [videoId],
  );
  if (!rows[0]) throw new HttpError(404, 'Vidéo introuvable.');
  if (!rows[0].has_text) throw new HttpError(409, "Cette vidéo n'a pas de transcription à résumer.");
  return generateSummary(rows[0], { complete });
}

export function resetSummaryState() {
  inflight.clear();
}
