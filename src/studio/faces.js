/**
 * Visages d'une interview, pour le cadrage automatique du mode plein écran.
 *
 * L'admin lance (ou le dépôt de la vidéo lance) une analyse : un thread décode la vidéo en petite définition, détecte les
 * visages une fois par seconde et repère les changements de plan. Le résultat est enregistré dans la table `video_faces` ;
 * ensuite chaque clip n'a plus qu'à lire ces données pour calculer la trajectoire du cadre (public/js/framing.js), sans aucun
 * calcul lourd. Une seule analyse tourne à la fois.
 */
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { pool } from '../db.js';
import { HttpError } from '../http-error.js';
import { videoFilePath } from '../media.js';
import { framingForClip } from '../../public/js/framing.js';

// définition de travail : le grand côté de l'image d'analyse fait maxSide pixels (un visage doit y mesurer ~20 px, soit environ 5 %
// de la largeur de l'image d'origine) ; une image par seconde, une toutes les deux secondes au-delà de 30 minutes de vidéo
export const FACES = { fps: 1, longFps: 0.5, longAfterS: 30 * 60, maxSide: 384, threshold: 0.6, model: 'yunet-2023mar' };

const MODEL = new URL('./models/face_detection_yunet_2023mar.onnx', import.meta.url);

/** Le cadrage automatique est disponible (STUDIO_FACES=off pour le couper). */
export const facesEnabled = () => process.env.STUDIO_FACES !== 'off' && existsSync(MODEL);

const stampOf = (video) => `${video.file_name}|${video.file_size}|${video.file_uploaded_at instanceof Date ? video.file_uploaded_at.toISOString() : video.file_uploaded_at}`;

const live = new Map(); // videoId → { status: 'queued' | 'running', progress }
const queue = [];
let running = null;

/** Retire de la file d'attente et arrête l'analyse d'une vidéo (fichier supprimé ou remplacé). */
export function cancelAnalysis(videoId) {
  const i = queue.findIndex((j) => j.video.id === videoId);
  if (i >= 0) queue.splice(i, 1);
  live.delete(videoId);
  if (running?.video.id === videoId) running.worker.terminate();
}

function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  const { video } = job;
  const state = live.get(video.id);
  if (state) state.status = 'running';
  const aspect = video.file_width && video.file_height ? video.file_width / video.file_height : 16 / 9;
  const fps = video.file_duration_s > FACES.longAfterS ? FACES.longFps : FACES.fps;
  const worker = new Worker(new URL('./faces-worker.js', import.meta.url), {
    workerData: { file: videoFilePath(video.file_name), aspect, duration: video.file_duration_s, fps, maxSide: FACES.maxSide, threshold: FACES.threshold },
  });
  running = { video, worker };
  let finished = false;
  const finish = async (result) => {
    if (finished) return;
    finished = true;
    running = null;
    const wasLive = live.delete(video.id);
    try {
      if (wasLive) await save(video, aspect, fps, result);
    } catch (e) {
      console.error(`Visages : enregistrement impossible (${e.message})`);
    }
    pump();
  };
  worker.on('message', (m) => {
    if (m.progress !== undefined) {
      const s = live.get(video.id);
      if (s) s.progress = m.progress;
    } else finish(m);
  });
  worker.on('error', (e) => finish({ error: e.message }));
  worker.on('exit', (code) => finish({ error: code ? `Analyse interrompue (code ${code}).` : 'Analyse interrompue.' }));
}

async function save(video, aspect, fps, result) {
  if (result.error) {
    console.error(`Visages de ${video.youtube_id} : ${result.error}`);
    await pool.query(
      `INSERT INTO video_faces (video_id, status, content, error, file_stamp, analyzed_at) VALUES ($1, 'failed', NULL, $2, $3, now())
       ON CONFLICT (video_id) DO UPDATE SET status = 'failed', content = NULL, error = $2, file_stamp = $3, analyzed_at = now()`,
      [video.id, String(result.error).slice(0, 500), stampOf(video)],
    );
    return;
  }
  const content = { fps, aspect: Math.round(aspect * 1000) / 1000, model: FACES.model, cuts: result.cuts, frames: result.frames };
  await pool.query(
    `INSERT INTO video_faces (video_id, status, content, error, file_stamp, analyzed_at) VALUES ($1, 'ready', $2, NULL, $3, now())
     ON CONFLICT (video_id) DO UPDATE SET status = 'ready', content = $2, error = NULL, file_stamp = $3, analyzed_at = now()`,
    [video.id, JSON.stringify(content), stampOf(video)],
  );
  cache.delete(video.id);
}

/** Lance l'analyse des visages d'une vidéo (sans attendre la fin). Renvoie son état. */
export async function startAnalysis(video) {
  if (!facesEnabled()) throw new HttpError(503, 'Le cadrage automatique est désactivé sur ce serveur.');
  if (!video.file_name) throw new HttpError(409, 'Dépose d’abord le fichier vidéo.');
  if (!live.has(video.id)) {
    live.set(video.id, { status: 'queued', progress: 0 });
    queue.push({ video });
    await pool.query('DELETE FROM video_faces WHERE video_id = $1', [video.id]);
    cache.delete(video.id);
    setImmediate(pump);
  }
  return facesStatus(video);
}

/** Même chose pour le dépôt d'une vidéo : jamais d'erreur remontée. */
export function autoAnalyze(video) {
  if (facesEnabled() && video.file_name) startAnalysis(video).catch((e) => console.error(`Visages : ${e.message}`));
}

export async function removeFaces(videoId) {
  cancelAnalysis(videoId);
  cache.delete(videoId);
  await pool.query('DELETE FROM video_faces WHERE video_id = $1', [videoId]);
}

/** { status: 'off' | 'none' | 'queued' | 'running' | 'ready' | 'failed' | 'stale', progress, error, analyzed_at, summary } */
export async function facesStatus(video) {
  if (!facesEnabled()) return { status: 'off' };
  const l = live.get(video.id);
  if (l) return { status: l.status, progress: Math.round(l.progress * 100) / 100 };
  const { rows } = await pool.query(
    `SELECT status, error, file_stamp, analyzed_at,
            jsonb_array_length(content->'frames') AS frames, jsonb_array_length(content->'cuts') AS cuts
     FROM video_faces WHERE video_id = $1`,
    [video.id],
  );
  if (!rows.length) return { status: 'none' };
  const r = rows[0];
  if (r.file_stamp !== stampOf(video)) return { status: 'stale' }; // la vidéo a été remplacée depuis
  if (r.status === 'failed') return { status: 'failed', error: r.error, analyzed_at: r.analyzed_at };
  return { status: 'ready', analyzed_at: r.analyzed_at, summary: { seconds: r.frames, cuts: r.cuts } };
}

const cache = new Map(); // videoId → { stamp, data }

/** Données de visages d'une vidéo (null si pas analysée, ou si l'analyse ne correspond plus au fichier). */
export async function loadFaces(video) {
  if (!facesEnabled()) return null;
  const stamp = stampOf(video);
  const hit = cache.get(video.id);
  if (hit?.stamp === stamp) return hit.data;
  const { rows } = await pool.query("SELECT content, file_stamp FROM video_faces WHERE video_id = $1 AND status = 'ready'", [video.id]);
  if (!rows.length || rows[0].file_stamp !== stamp) return null;
  cache.set(video.id, { stamp, data: rows[0].content });
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  return rows[0].content;
}

/**
 * Cadrage automatique d'une demande de clip (mode plein écran, suivi activé) :
 * { segments, faces, coverage } ou null si indisponible (pas d'analyse, pas de visage).
 */
export async function framingForRequest(video, req) {
  if (req.layout.fit !== 'crop' || !req.layout.follow?.on) return null;
  const data = await loadFaces(video);
  if (!data) return null;
  const clip = framingForClip({ frames: data.frames, fps: data.fps, aspect: data.aspect, extracts: req.extracts, subject: req.layout.follow.subject, cuts: data.cuts });
  return clip.segments.some((s) => s.keys) ? clip : null;
}
