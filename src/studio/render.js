/**
 * Rendu des clips verticaux avec ffmpeg : cadrage 9:16, sous-titres incrustés (ASS/libass), musique mixée sous la voix.
 *
 *  - Aperçu : même cadrage en 360 × 640, sans sous-titres (dessinés en direct dans le navigateur), mis en cache 1 h.
 *  - Rendu final : file d'attente (STUDIO_CONCURRENCY clips à la fois, 1 par défaut), limites par visiteur, progression,
 *    annulation, fichier supprimé 1 h après sa création. Rien n'est conservé durablement.
 *  - Les fichiers vidéo d'origine ne sont jamais servis : seuls ces extraits (≤ 90 s au total) sortent du serveur.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { LIMITS, OUT, bannerText, buildAss, groupWords, sanitizeStyle, wordsForExtracts } from '../../public/js/studio-core.js';
import { HttpError } from '../http-error.js';
import { storageDir, videoFilePath } from '../media.js';

const read = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
export const FONTS = read('fonts.json');
export const MUSIC = read('music.json');
export const FONTS_DIR = new URL('../../public/fonts/studio', import.meta.url).pathname;
export const MUSIC_DIR = new URL('../../public/music', import.meta.url).pathname;
const fontById = new Map(FONTS.map((f) => [f.id, f]));
const musicById = new Map(MUSIC.map((m) => [m.id, m]));

export const config = () => ({
  concurrency: Math.max(1, Number(process.env.STUDIO_CONCURRENCY) || 1),
  maxQueue: Number(process.env.STUDIO_MAX_QUEUE) || 10,
  perIpActive: 2,
  rendersPerHour: Number(process.env.STUDIO_RENDERS_PER_HOUR) || 8,
  previewsPerHour: Number(process.env.STUDIO_PREVIEWS_PER_HOUR) || 60,
  ttlMs: 60 * 60 * 1000,
  timeoutMs: 12 * 60 * 1000,
});

/** Format de l'aperçu : MP4 (H.264, lu partout). STUDIO_PREVIEW_FORMAT=webm : réservé aux tests avec un navigateur sans H.264. */
const previewExt = () => (process.env.STUDIO_PREVIEW_FORMAT === 'webm' ? 'webm' : 'mp4');

const SIZES = { hd: { w: 1080, h: 1920, crf: 21, preset: 'veryfast' }, fast: { w: 720, h: 1280, crf: 23, preset: 'veryfast' }, preview: { w: 360, h: 640, crf: 31, preset: 'ultrafast' } };

// --- capacités de ffmpeg ----------------------------------------------------------------------------

let capabilities;
/** Ce que le ffmpeg du serveur sait faire : incruster des sous-titres (libass) et encoder en H.264 / AAC. */
export async function studioCapabilities() {
  if (capabilities) return capabilities;
  const run = (args) =>
    new Promise((resolve) => {
      const p = spawn('ffmpeg', ['-hide_banner', ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('error', () => resolve(''));
      p.on('close', () => resolve(out));
    });
  const [filters, encoders] = await Promise.all([run(['-filters']), run(['-encoders'])]);
  const has = (text, re) => re.test(text);
  capabilities = { ass: has(filters, /\bass\b/), x264: has(encoders, /libx264/), aac: has(encoders, /\baac\b/) };
  capabilities.ready = capabilities.ass && capabilities.x264 && capabilities.aac;
  return capabilities;
}

// --- validation de la demande -------------------------------------------------------------------

/** Demande de rendu normalisée à partir d'une saisie quelconque ; lève une 400 claire sinon. `video` : { file_duration_s }. */
export function normalizeRequest(body, video) {
  const b = body && typeof body === 'object' ? body : {};
  const list = Array.isArray(b.extracts) ? b.extracts : [];
  if (!list.length) throw new HttpError(400, 'Choisis au moins un extrait.');
  if (list.length > LIMITS.maxExtracts) throw new HttpError(400, `${LIMITS.maxExtracts} extraits au maximum.`);
  const limitMs = Math.floor(video.file_duration_s * 1000) + 500;
  let total = 0;
  const extracts = list.map((e) => {
    const start = Math.round(Number(e?.start_ms));
    const end = Math.round(Number(e?.end_ms));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new HttpError(400, 'Extrait invalide.');
    if (end > limitMs) throw new HttpError(400, 'Un extrait dépasse la durée de la vidéo.');
    if ((end - start) / 1000 < LIMITS.minExtractS) throw new HttpError(400, `Un extrait doit durer au moins ${LIMITS.minExtractS} secondes.`);
    total += (end - start) / 1000;
    return { start_ms: start, end_ms: Math.min(end, Math.floor(video.file_duration_s * 1000)) };
  });
  if (total > LIMITS.maxTotalS + 0.01) throw new HttpError(400, `Le clip ne peut pas dépasser ${LIMITS.maxTotalS} secondes (il en fait ${Math.round(total)}).`);
  const l = b.layout && typeof b.layout === 'object' ? b.layout : {};
  const layout = {
    fit: l.fit === 'crop' ? 'crop' : 'blur',
    cropX: Math.round(Math.min(1, Math.max(0, Number.isFinite(Number(l.cropX)) ? Number(l.cropX) : 0.5)) * 100) / 100,
    quality: l.quality === 'fast' ? 'fast' : 'hd',
  };
  const style = sanitizeStyle(b.style, FONTS.map((f) => f.id));
  let music = null;
  if (b.music && b.music.id) {
    if (!musicById.has(b.music.id)) throw new HttpError(400, 'Musique inconnue.');
    music = { id: b.music.id, volume: Math.round(Math.min(1, Math.max(0, Number.isFinite(Number(b.music.volume)) ? Number(b.music.volume) : 0.25)) * 100) / 100 };
  }
  const voice = Math.round(Math.min(1.5, Math.max(0, Number.isFinite(Number(b.voice)) ? Number(b.voice) : 1)) * 100) / 100;
  return { extracts, layout, style, music, voice, total: Math.round(total * 1000) / 1000 };
}

// --- commande ffmpeg --------------------------------------------------------------------------------

const esc = (p) => String(p).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function layoutChain(i, { w, h }, layout) {
  if (layout.fit === 'crop') {
    return `[${i}:v]fps=30,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}:(iw-ow)*${layout.cropX}:(ih-oh)*0.5,setsar=1[v${i}]`;
  }
  // « fit » : la vidéo entière, centrée, sur un fond flou fait avec elle-même (calculé en petit pour rester rapide)
  const bw = even(w / 4);
  const bh = even(h / 4);
  return (
    `[${i}:v]fps=30,split=2[bg${i}][fg${i}];` +
    `[bg${i}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=6:2,scale=${w}:${h},eq=brightness=-0.12:saturation=1.15[b${i}];` +
    `[fg${i}]scale=${w}:-2[f${i}];[b${i}][f${i}]overlay=(W-w)/2:(H-h)/2,setsar=1[v${i}]`
  );
}

/**
 * Arguments ffmpeg d'un rendu. `kind` : 'final' (sous-titres + musique) ou 'preview' (cadrage seul, petite définition).
 * Fonction pure : testable sans lancer ffmpeg.
 */
export function buildFfmpegArgs({ file, req, hasAudio, assPath, out, kind = 'final' }) {
  const size = kind === 'preview' ? SIZES.preview : SIZES[req.layout.quality];
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y'];
  req.extracts.forEach((e) => args.push('-ss', String(e.start_ms / 1000), '-t', String((e.end_ms - e.start_ms) / 1000), '-i', file));
  const music = kind === 'final' && req.music ? musicById.get(req.music.id) : null;
  const musicIdx = req.extracts.length;
  if (music) args.push('-stream_loop', '-1', '-t', String(req.total), '-i', path.join(MUSIC_DIR, music.file));

  const f = [];
  req.extracts.forEach((e, i) => {
    const dur = (e.end_ms - e.start_ms) / 1000;
    f.push(layoutChain(i, size, req.layout));
    f.push(
      hasAudio
        ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${dur},asetpts=PTS-STARTPTS[a${i}]`
        : `anullsrc=r=48000:cl=stereo,atrim=0:${dur},asetpts=PTS-STARTPTS[a${i}]`,
    );
  });
  const ins = req.extracts.map((_, i) => `[v${i}][a${i}]`).join('');
  f.push(`${ins}concat=n=${req.extracts.length}:v=1:a=1[vc][ac]`);
  f.push(kind === 'final' ? `[vc]ass=${esc(assPath)}:fontsdir=${esc(FONTS_DIR)}[vo]` : '[vc]null[vo]');
  if (music) {
    const fadeOut = Math.max(0, req.total - 1.8);
    f.push(`[ac]volume=${req.voice}[av]`);
    f.push(`[${musicIdx}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${req.music.volume},afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeOut}:d=1.8[m]`);
    f.push('[av][m]amix=inputs=2:duration=first:dropout_transition=0,volume=2,alimiter=limit=0.95[ao]');
  } else {
    f.push(`[ac]volume=${req.voice},alimiter=limit=0.95[ao]`);
  }
  args.push('-filter_complex', f.join(';'), '-map', '[vo]', '-map', '[ao]');
  if (kind === 'preview' && previewExt() === 'webm') {
    args.push('-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '700k', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'libopus', '-b:a', '64k', '-ar', '48000', '-t', String(req.total), out);
    return args;
  }
  args.push('-c:v', 'libx264', '-preset', size.preset, '-crf', String(size.crf), '-pix_fmt', 'yuv420p', '-r', '30');
  if (kind === 'final') args.push('-profile:v', 'high', '-level', '4.1');
  args.push('-c:a', 'aac', '-b:a', kind === 'final' ? '160k' : '64k', '-ar', '48000', '-t', String(req.total), '-movflags', '+faststart', out);
  return args;
}

/** Fichier ASS du clip : mots horodatés des lignes de la transcription, groupés selon le style, plus le bandeau de source. */
export function assForRequest({ req, lines, video }) {
  const { words, duration } = wordsForExtracts(lines, req.extracts);
  const groups = groupWords(words, req.style);
  const font = fontById.get(req.style.font) ?? FONTS[0];
  const banner = fontById.get('inter') ?? font;
  return buildAss({
    groups,
    style: req.style,
    font: { ass_name: font.ass_name, em_ratio: font.em_ratio, cap_em: font.cap_em, banner_name: banner.ass_name, banner_em_ratio: banner.em_ratio },
    banner: bannerText(video.title, video.published_at),
    duration,
  });
}

// --- exécution de ffmpeg ----------------------------------------------------------------------------

const dirs = () => ({ renders: path.join(storageDir(), 'renders'), previews: path.join(storageDir(), 'previews') });
async function ensureDirs() {
  const d = dirs();
  await fs.mkdir(d.renders, { recursive: true });
  await fs.mkdir(d.previews, { recursive: true });
}

/** Lance ffmpeg ; `onProgress(0..1)` ; renvoie { cancel }. Rejette avec le dernier message d'erreur de ffmpeg. */
function runFfmpeg(args, total, { onProgress, timeoutMs }) {
  let proc;
  const promise = new Promise((resolve, reject) => {
    proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let cancelled = false;
    proc.cancel = () => {
      cancelled = true;
      proc.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      err += '\nDélai dépassé';
      proc.kill('SIGKILL');
    }, timeoutMs);
    proc.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m && total > 0) onProgress?.(Math.min(0.99, Number(m[1]) / 1e6 / total));
      }
    });
    proc.stderr.on('data', (d) => {
      err = (err + d).slice(-2000);
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(e.code === 'ENOENT' ? "ffmpeg n'est pas installé sur ce serveur." : e.message), { cancelled }));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error(err.trim() || `ffmpeg a échoué (code ${code})`), { cancelled }));
    });
  });
  return { promise, cancel: () => proc?.cancel?.() };
}

// --- limites par visiteur ---------------------------------------------------------------------------

const recent = new Map(); // `${kind}:${ip}` -> horodatages
function take(kind, ip, max) {
  const key = `${kind}:${ip}`;
  const now = Date.now();
  const list = (recent.get(key) ?? []).filter((t) => now - t < 3600_000);
  if (list.length >= max) {
    recent.set(key, list);
    return false;
  }
  list.push(now);
  recent.set(key, list);
  if (recent.size > 5000) recent.clear();
  return true;
}

// --- aperçu -------------------------------------------------------------------------------------------

const inflightPreviews = new Map();
let previewsRunning = 0;
const previewWaiters = [];
const acquirePreview = async () => {
  while (previewsRunning >= 2) await new Promise((r) => previewWaiters.push(r));
  previewsRunning++;
};
const releasePreview = () => {
  previewsRunning--;
  previewWaiters.shift()?.();
};

/** Aperçu du cadrage (sans sous-titres, 360 × 640) : renvoie { key, duration_s }. Mis en cache selon fichier + extraits + cadrage. */
export async function createPreview({ video, req, ip = 'local' }) {
  const keySource = JSON.stringify([video.file_name, video.file_size, String(video.file_uploaded_at), req.extracts, req.layout.fit, req.layout.cropX]);
  const key = crypto.createHash('sha1').update(keySource).digest('hex');
  await ensureDirs();
  const ext = previewExt();
  const out = path.join(dirs().previews, `${key}.${ext}`);
  const done = { key, ext, duration_s: req.total };
  if (await fs.stat(out).then(() => true, () => false)) {
    await fs.writeFile(path.join(dirs().previews, `${key}.json`), JSON.stringify({ youtube_id: video.youtube_id }));
    return done;
  }
  if (inflightPreviews.has(key)) return inflightPreviews.get(key);
  if (!take('preview', ip, config().previewsPerHour)) throw new HttpError(429, 'Trop d’aperçus pour le moment : réessaie dans quelques minutes.');
  const promise = (async () => {
    await acquirePreview();
    try {
      const tmp = `${out}.tmp.${ext}`;
      const args = buildFfmpegArgs({ file: videoFilePath(video.file_name), req, hasAudio: video.file_has_audio, out: tmp, kind: 'preview' });
      await runFfmpeg(args, req.total, { timeoutMs: 120_000 }).promise.catch((e) => {
        throw new HttpError(500, `Aperçu impossible : ${e.message.split('\n').pop().slice(0, 160)}`);
      });
      await fs.rename(tmp, out);
      await fs.writeFile(path.join(dirs().previews, `${key}.json`), JSON.stringify({ youtube_id: video.youtube_id }));
      return done;
    } finally {
      releasePreview();
    }
  })().finally(() => inflightPreviews.delete(key));
  inflightPreviews.set(key, promise);
  return promise;
}

/** Chemin d'un aperçu mis en cache (et vidéo d'origine) : null s'il n'existe plus. */
export async function previewFile(key) {
  if (!/^[0-9a-f]{40}$/.test(key)) return null;
  const meta = await fs.readFile(path.join(dirs().previews, `${key}.json`), 'utf8').then(JSON.parse, () => null);
  if (!meta) return null;
  for (const ext of ['mp4', 'webm']) {
    const file = path.join(dirs().previews, `${key}.${ext}`);
    if (await fs.stat(file).then(() => true, () => false)) return { file, ext, youtube_id: meta.youtube_id };
  }
  return null;
}

// --- file d'attente des rendus --------------------------------------------------------------------------

const jobs = new Map();
const queue = [];
let running = 0;

const slug = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'clip';

export function publicJob(job) {
  const pos = job.status === 'queued' ? queue.indexOf(job) + 1 : 0;
  return {
    id: job.id,
    status: job.status,
    progress: job.status === 'done' ? 1 : Math.round(job.progress * 100) / 100,
    position: pos,
    error: job.error ?? null,
    duration_s: job.total,
    filename: job.filename,
    size: job.size ?? null,
    expires_in_s: job.finishedAt ? Math.max(0, Math.round((job.finishedAt + config().ttlMs - Date.now()) / 1000)) : null,
  };
}
export const getJob = (id) => (/^[0-9a-f]{24}$/.test(id) ? jobs.get(id) : undefined);

/** Met un rendu en file. `video` : ligne de la base ; `lines` : lignes de la transcription ; renvoie le job. */
export async function enqueueRender({ video, req, lines, ip = 'local' }) {
  const cfg = config();
  const mine = [...jobs.values()].filter((j) => j.ip === ip && (j.status === 'queued' || j.status === 'running')).length;
  if (mine >= cfg.perIpActive) throw new HttpError(429, 'Tu as déjà des clips en cours de création : attends qu’ils soient prêts.');
  if (queue.length >= cfg.maxQueue) throw new HttpError(503, 'Le studio est très sollicité : réessaie dans quelques minutes.');
  if (!take('render', ip, cfg.rendersPerHour)) throw new HttpError(429, `Limite atteinte : ${cfg.rendersPerHour} clips par heure. Réessaie plus tard.`);
  await ensureDirs();
  const id = crypto.randomBytes(12).toString('hex');
  const job = {
    id,
    ip,
    status: 'queued',
    progress: 0,
    total: req.total,
    filename: `lisnard-facts-${slug(video.title)}-${id.slice(0, 6)}.mp4`,
    out: path.join(dirs().renders, `${id}.mp4`),
    assPath: path.join(dirs().renders, `${id}.ass`),
    file: videoFilePath(video.file_name),
    hasAudio: video.file_has_audio,
    req,
    ass: assForRequest({ req, lines, video }),
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  queue.push(job);
  pump();
  return job;
}

function pump() {
  while (running < config().concurrency && queue.length) {
    const job = queue.shift();
    running++;
    runJob(job).finally(() => {
      running--;
      pump();
    });
  }
}

async function runJob(job) {
  job.status = 'running';
  try {
    await fs.writeFile(job.assPath, job.ass);
    const args = buildFfmpegArgs({ file: job.file, req: job.req, hasAudio: job.hasAudio, assPath: job.assPath, out: job.out, kind: 'final' });
    const run = runFfmpeg(args, job.total, { onProgress: (p) => (job.progress = p), timeoutMs: config().timeoutMs });
    job.cancel = run.cancel;
    await run.promise;
    job.size = (await fs.stat(job.out)).size;
    job.status = 'done';
    job.progress = 1;
  } catch (e) {
    if (job.status !== 'cancelled') {
      job.status = e.cancelled ? 'cancelled' : 'error';
      if (!e.cancelled) {
        console.error(`Rendu ${job.id} : ${e.message}`);
        job.error = 'Le rendu de la vidéo a échoué. Réessaie, ou choisis un autre extrait.';
      }
    }
    await fs.rm(job.out, { force: true });
  } finally {
    job.finishedAt = Date.now();
    job.cancel = null;
    await fs.rm(job.assPath, { force: true });
    delete job.ass;
  }
}

/** Annule un rendu en file ou en cours, ou supprime un rendu terminé. */
export async function cancelJob(job) {
  if (job.status === 'queued') {
    queue.splice(queue.indexOf(job), 1);
    job.status = 'cancelled';
    job.finishedAt = Date.now();
  } else if (job.status === 'running') {
    job.status = 'cancelled';
    job.cancel?.();
  } else {
    await fs.rm(job.out, { force: true });
    jobs.delete(job.id);
  }
}

// --- nettoyage : rien n'est conservé plus d'une heure -------------------------------------------------------

export async function cleanup(now = Date.now()) {
  const ttl = config().ttlMs;
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > ttl) {
      await fs.rm(job.out, { force: true });
      jobs.delete(id);
    }
  }
  for (const dir of Object.values(dirs())) {
    const names = await fs.readdir(dir).catch(() => []);
    for (const name of names) {
      const p = path.join(dir, name);
      const st = await fs.stat(p).catch(() => null);
      if (st && now - st.mtimeMs > ttl && !(await isActive(name))) await fs.rm(p, { force: true });
    }
  }
}
const isActive = async (name) => [...jobs.values()].some((j) => (j.status === 'running' || j.status === 'queued') && name.startsWith(j.id));

let cleanupTimer;
export function startStudioCleanup() {
  cleanup().catch(() => {});
  cleanupTimer ??= setInterval(() => cleanup().catch(() => {}), 10 * 60 * 1000).unref();
}

/** Remet à zéro l'état en mémoire (tests). */
export function resetStudioState() {
  jobs.clear();
  queue.length = 0;
  recent.clear();
}
export { OUT };
