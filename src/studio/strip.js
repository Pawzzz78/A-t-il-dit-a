/**
 * Vignettes de la timeline du studio : une seule image (grille de petites images tirées de l'interview, une toutes les N secondes),
 * créée une fois à partir du fichier vidéo déjà présent sur le serveur, puis gardée sur le volume (<STORAGE_DIR>/studio/strips).
 *
 * Le navigateur ne reçoit jamais la vidéo entière (elle ne sort pas du serveur) : il reçoit cette grille, de quelques centaines de Ko, qui
 * lui permet de montrer l'interview sur toute sa durée comme dans un logiciel de montage.
 *
 * Le nom du fichier vient de l'identifiant YouTube et de la version du fichier vidéo : remplacer la vidéo produit une nouvelle grille.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { stampOf, storageDir, videoFilePath } from '../media.js';

const run = promisify(execFile);

export const STRIP = { thumbW: 160, thumbH: 90, cols: 10, maxFrames: 200, minStepS: 5 };
export const stripsDir = () => path.join(storageDir(), 'studio', 'strips');
const NAME = /^[A-Za-z0-9_-]{11}-[0-9a-f]{8}\.jpg$/;
export const stripNameOk = (name) => NAME.test(String(name));

/** Pas entre deux vignettes (secondes), nombre de vignettes et lignes de la grille pour une durée donnée. */
export function stripPlan(durationS) {
  const d = Math.max(1, Number(durationS) || 1);
  const step_s = Math.max(STRIP.minStepS, Math.ceil(d / STRIP.maxFrames));
  const frames = Math.max(1, Math.ceil(d / step_s));
  return { step_s, frames, cols: STRIP.cols, rows: Math.ceil(frames / STRIP.cols), thumb_w: STRIP.thumbW, thumb_h: STRIP.thumbH };
}

export const stripFileName = (video) => `${video.youtube_id}-${crypto.createHash('sha1').update(stampOf(video)).digest('hex').slice(0, 8)}.jpg`;
export const stripPath = (video) => path.join(stripsDir(), stripFileName(video));

const exists = (file) => fs.stat(file).then((s) => s.size > 0, () => false);
const FAILED_FOR_MS = 5 * 60_000;
const building = new Map(); // nom du fichier -> promesse
const failed = new Map(); // nom du fichier -> instant de l'échec (on ne boucle pas)
let chain = Promise.resolve(); // une seule grille à la fois : ffmpeg est gourmand

async function build(video) {
  const plan = stripPlan(video.file_duration_s);
  const out = stripPath(video);
  const work = `${out}.work`;
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  try {
    const file = videoFilePath(video.file_name);
    const last = Math.max(0, (Number(video.file_duration_s) || 1) - 0.3);
    const frame = (i) => path.join(work, `${String(i).padStart(4, '0')}.jpg`);
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < plan.frames; i = next++) {
        const t = Math.min(last, i * plan.step_s + plan.step_s / 2);
        await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-an', '-vf', `scale=${STRIP.thumbW}:${STRIP.thumbH}:force_original_aspect_ratio=increase,crop=${STRIP.thumbW}:${STRIP.thumbH}`, '-q:v', '6', frame(i)], { timeout: 60_000 }).catch(() => {});
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    // une vignette manquante (lecture impossible à cet instant) reprend la précédente, ou la première qui existe
    const ok = [];
    for (let i = 0; i < plan.frames; i++) ok.push(await exists(frame(i)));
    const firstOk = ok.indexOf(true);
    if (firstOk < 0) throw new Error('aucune vignette');
    for (let i = 0; i < plan.frames; i++) {
      if (!ok[i]) await fs.copyFile(frame(i > firstOk ? i - 1 : firstOk), frame(i));
    }
    const tmp = `${out}.tmp.jpg`;
    await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-framerate', '1', '-i', path.join(work, '%04d.jpg'), '-vf', `tile=${plan.cols}x${plan.rows}:padding=0`, '-frames:v', '1', '-q:v', '6', tmp], { timeout: 60_000 });
    await fs.rename(tmp, out);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
    await fs.rm(`${out}.tmp.jpg`, { force: true });
  }
}

/**
 * État de la grille d'une vidéo : { ready, failed, url, ...plan }. Lance sa création en arrière-plan si elle n'existe pas encore.
 * `video` : ligne de la base (youtube_id, file_name, file_size, file_uploaded_at, file_duration_s).
 */
export async function stripStatus(video) {
  const plan = stripPlan(video.file_duration_s);
  const name = stripFileName(video);
  const base = { ...plan, url: `/api/studio/strips/${name}` };
  if (await exists(stripPath(video))) return { ready: true, failed: false, ...base };
  const at = failed.get(name);
  if (at && Date.now() - at < FAILED_FOR_MS) return { ready: false, failed: true, ...base };
  if (!building.has(name)) {
    await fs.mkdir(stripsDir(), { recursive: true });
    const job = chain.catch(() => {}).then(() => build(video));
    chain = job;
    building.set(name, job);
    job.then(() => failed.delete(name), (e) => {
      console.error(`Vignettes ${name} : ${e.message}`);
      failed.set(name, Date.now());
    }).finally(() => building.delete(name));
  }
  return { ready: false, failed: false, ...base };
}

/** Attend la fin de la création en cours (tests). */
export const stripIdle = () => Promise.all([...building.values()].map((p) => p.catch(() => {})));

/** Supprime les grilles d'une vidéo (fichier supprimé ou remplacé). */
export async function removeStrips(youtubeId) {
  for (const name of await fs.readdir(stripsDir()).catch(() => [])) {
    if (name.startsWith(`${youtubeId}-`)) await fs.rm(path.join(stripsDir(), name), { recursive: true, force: true });
  }
}

export const resetStrips = () => {
  building.clear();
  failed.clear();
};
