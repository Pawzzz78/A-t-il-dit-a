// Uniquification des clips de la bibliothèque : une deuxième passe ffmpeg (micro-transforms invisibles)
// clé sur (clip, personne), pour que chaque personne qui télécharge un clip obtienne son propre fichier.
//
//   <STORAGE_DIR>/library/variants/<clipId>_<who16>_<niveau>.mp4   (+ sidecar .json)
//
// Le seed est tiré de (clip, personne) : la même personne re-télécharge toujours le même fichier (mis en
// cache sur le volume), une autre personne obtient un autre fichier. Aucune table de base : les fichiers
// sont suivis par readdir, comme les aperçus du studio. La file a sa propre concurrence (1 par défaut) et
// ne ralentit jamais le rendu du studio ; si elle est pleine ou si ffmpeg manque, on sert le fichier
// original — un téléchargement n'échoue jamais.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildUniqArgs, seedFrom, uniqCapabilities } from '../studio/uniquify.js';
import { storageDir } from '../media.js';

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

export const uniqConfig = () => {
  const level = String(process.env.LIBRARY_UNIQ_LEVEL ?? 'gentle').toLowerCase();
  return {
    on: !/^(off|false|0|non)$/i.test(process.env.LIBRARY_UNIQ ?? 'on'),
    level: level === 'medium' ? 'medium' : 'gentle',
    maxPerClip: Math.max(1, Math.min(100, num(process.env.LIBRARY_UNIQ_MAX_PER_CLIP, 25))),
    concurrency: Math.max(1, num(process.env.LIBRARY_UNIQ_CONCURRENCY, 1)),
    maxQueue: Math.max(1, num(process.env.LIBRARY_UNIQ_QUEUE, 10)),
    timeoutMs: num(process.env.LIBRARY_UNIQ_TIMEOUT_MS, 180_000),
  };
};

export const variantsDir = () => path.join(storageDir(), 'library', 'variants');
const ID = /^[0-9a-f]{24}$/;
const whoOf16 = (who) => String(who).slice(0, 16);
const variantPath = (id, who, level) => path.join(variantsDir(), `${id}_${whoOf16(who)}_${level}.mp4`);
const sidecarOf = (file) => `${file}.json`;

export const resetUniqState = () => {
  jobs.clear();
  queue.length = 0;
  running = 0;
  bytesAt = 0;
  bytesValue = null;
};

// --- état des fichiers -----------------------------------------------------------------------------

/** Fichier prêt de la variante de `who` pour ce clip : chemin, ou null. */
export async function variantFile(id, who) {
  if (!ID.test(String(id)) || !who) return null;
  const file = variantPath(id, who, uniqConfig().level);
  return fs.stat(file).then((s) => (s.isFile() ? file : null), () => null);
}

/** Supprime toutes les variantes d'un clip (fichiers, sidecars et jobs en cours). */
export async function removeVariants(id) {
  if (!ID.test(String(id))) return;
  for (const [key, job] of jobs) if (job.id === id) jobs.delete(key);
  const names = await fs.readdir(variantsDir()).catch(() => []);
  await Promise.all(
    names
      .filter((n) => n.startsWith(`${id}_`))
      .map((n) => fs.rm(path.join(variantsDir(), n), { force: true })),
  );
}

// --- file de préparation ---------------------------------------------------------------------------

/** `state` : ready | queued | running | done | error | skipped | disabled | idle */
const jobs = new Map(); // `${id}|${who16}` -> job
const queue = [];
let running = 0;

/**
 * Statut public d'une variante. `who` : clé du propriétaire (adhérent ou cookie anonyme) ou empreinte IP.
 * `idle` : rien n'a été préparé ; `skipped` : repli sur le fichier original (file pleine ou ffmpeg absent).
 */
export async function variantState(id, who) {
  const cfg = uniqConfig();
  if (!cfg.on || !who) return { state: 'disabled', progress: 0 };
  if (await variantFile(id, who)) return { state: 'ready', progress: 1 };
  const job = jobs.get(`${id}|${whoOf16(who)}`);
  if (job) return { state: job.status === 'done' ? 'ready' : job.status, progress: job.status === 'done' ? 1 : job.progress };
  return { state: 'idle', progress: 0 };
}

/**
 * Met une variante en file si besoin. Idempotent : prête → `ready`, déjà en cours → son statut,
 * file pleine ou ffmpeg incomplet → `skipped` (le fichier original reste servi).
 * `file` : chemin du fichier canonique du clip (déjà vérifié par l'appelant).
 */
export async function ensureVariant({ id, who, file, quality, durationS }) {
  const cfg = uniqConfig();
  if (!cfg.on || !who) return { state: 'disabled', progress: 0 };
  if (await variantFile(id, who)) return { state: 'ready', progress: 1 };
  const key = `${id}|${whoOf16(who)}`;
  const existing = jobs.get(key);
  if (existing) return { state: existing.status, progress: existing.progress };
  const caps = await uniqCapabilities();
  if (!caps.ok) return { state: 'skipped', progress: 0 };
  if (queue.length >= cfg.maxQueue) return { state: 'skipped', progress: 0 };
  const job = {
    id, who, file, quality, durationS: Number(durationS) > 0 ? Number(durationS) : 30,
    seed: seedFrom(`${id}|${who}`),
    rubberband: caps.rubberband,
    status: 'queued',
    progress: 0,
    cancel: null,
  };
  jobs.set(key, job);
  queue.push(job);
  pump();
  return { state: job.status, progress: 0 };
}

function pump() {
  const cfg = uniqConfig();
  while (running < cfg.concurrency && queue.length) {
    const job = queue.shift();
    running++;
    runVariant(job).finally(() => {
      running--;
      pump();
    });
  }
}

async function runVariant(job) {
  try {
    const caps = await uniqCapabilities();
    if (!caps.ok) return (job.status = 'skipped');
    const { params, args } = buildUniqArgs({
      file: job.file,
      out: variantPath(job.id, job.who, uniqConfig().level),
      quality: job.quality,
      seed: job.seed,
      level: uniqConfig().level,
      rubberband: caps.rubberband,
    });
    job.params = params;
    await fs.mkdir(variantsDir(), { recursive: true }); // ffmpeg ouvre la sortie dès le départ
    const tmp = `${variantPath(job.id, job.who, uniqConfig().level)}.tmp.mp4`;
    args[args.length - 1] = tmp;
    const run = runFfmpeg(args, job.durationS, { onProgress: (p) => (job.progress = p), timeoutMs: uniqConfig().timeoutMs });
    job.cancel = run.cancel;
    await run.promise;
    await fs.mkdir(variantsDir(), { recursive: true });
    await fs.rename(tmp, variantPath(job.id, job.who, uniqConfig().level));
    await fs.writeFile(sidecarOf(variantPath(job.id, job.who, uniqConfig().level)), JSON.stringify({
      clip: job.id,
      who: whoOf16(job.who),
      level: uniqConfig().level,
      seed: job.seed,
      at: new Date().toISOString(),
    }));
    job.status = 'done';
    job.progress = 1;
    await evictOldest(job.id);
  } catch (e) {
    console.error(`Bibliothèque ${job.id} (variante) : ${e.message}`);
    job.status = 'error';
  } finally {
    if (job.status !== 'done' && job.status !== 'skipped') {
      // annulée (clip supprimé) ou en erreur : le fichier partiel est retiré par removeVariants / l'épuration
      await fs.rm(`${variantPath(job.id, job.who, uniqConfig().level)}.tmp.mp4`, { force: true });
    }
    job.cancel = null;
  }
}

/** Lance ffmpeg ; renvoie { promise, cancel } ; `onProgress(0..1)` ; rejette avec le dernier message d'erreur. */
function runFfmpeg(args, total, { onProgress, timeoutMs }) {
  let kill = null;
  const promise = new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let cancelled = false;
    kill = () => {
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
    proc.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error("ffmpeg n'est pas installé sur ce serveur.") : e);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (cancelled) return reject(Object.assign(new Error('annulé'), { cancelled: true }));
      if (code === 0) return resolve();
      reject(new Error(err.trim() || `ffmpeg a échoué (code ${code})`));
    });
  });
  return { promise, cancel: () => kill?.() };
}

/** Plafond de variantes par clip : les plus anciennes partent (les sidecars aussi). */
async function evictOldest(id) {
  const cfg = uniqConfig();
  const dir = variantsDir();
  const names = (await fs.readdir(dir).catch(() => [])).filter((n) => n.startsWith(`${id}_`) && n.endsWith('.mp4'));
  if (names.length <= cfg.maxPerClip) return;
  const ranked = await Promise.all(
    names.map(async (n) => ({
      n,
      m: (await fs.stat(path.join(dir, n)).catch(() => null))?.mtimeMs ?? 0,
    })),
  );
  ranked.sort((a, b) => a.m - b.m);
  await Promise.all(
    ranked
      .slice(0, ranked.length - cfg.maxPerClip)
      .map(({ n }) => Promise.all([fs.rm(path.join(dir, n), { force: true }), fs.rm(path.join(dir, `${n}.json`), { force: true })])),
  );
}

// --- entretien --------------------------------------------------------------------------------------

let bytesAt = 0;
let bytesValue = null;

/** Poids des variantes sur le volume (mis en cache 60 s) : compté dans le budget de la bibliothèque. */
export async function variantsBytes() {
  if (Date.now() - bytesAt < 60_000 && bytesValue !== null) return bytesValue;
  const dir = variantsDir();
  const names = (await fs.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.mp4'));
  let total = 0;
  for (const n of names) {
    const st = await fs.stat(path.join(dir, n)).catch(() => null);
    if (st?.isFile()) total += st.size;
  }
  bytesAt = Date.now();
  bytesValue = total;
  return total;
}

/**
 * Épuration : les variantes d'un clip disparu partent. Appelé par l'entretien de la bibliothèque avec
 * l'ensemble des ids encore présents en base.
 */
export async function sweepVariants(existingIds) {
  const dir = variantsDir();
  const names = await fs.readdir(dir).catch(() => []);
  const stale = names.filter((n) => !existingIds.has(n.split('_')[0]) && n.endsWith('.mp4'));
  await Promise.all(
    stale.map((n) => Promise.all([fs.rm(path.join(dir, n), { force: true }), fs.rm(path.join(dir, `${n}.json`), { force: true })])),
  );
  if (stale.length) {
    bytesAt = 0;
    bytesValue = null;
  }
  return stale.length;
}
