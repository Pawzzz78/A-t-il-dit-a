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
    retryDelayMs: Math.max(0, num(process.env.LIBRARY_UNIQ_RETRY_MS, 5_000)),
  };
};

export const variantsDir = () => path.join(storageDir(), 'library', 'variants');
const ID = /^[0-9a-f]{24}$/;
const whoOf16 = (who) => String(who).slice(0, 16);
const variantPath = (id, who, level) => path.join(variantsDir(), `${id}_${whoOf16(who)}_${level}.mp4`);
const sidecarOf = (file) => `${file}.json`;
// `.part` (pas `.mp4`) : un encodage en cours n'est ni compté, ni évincé, ni servi comme une variante
const partOf = (file) => `${file}.part`;

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
  for (const [key, job] of jobs) {
    if (job.id !== id) continue;
    jobs.delete(key); // runVariant voit le job orphelin et ne range pas son fichier
    const i = queue.indexOf(job);
    if (i >= 0) queue.splice(i, 1);
    job.cancel?.();
  }
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

/** Vue publique d'un job ; `retry` : faux quand les tentatives sont épuisées (le client masque « Réessayer »). */
const jobView = (job) => {
  if (job.status !== 'error') return { state: job.status, progress: job.progress };
  return { state: 'error', progress: 0, error: job.error, retry: job.attempts < MAX_VARIANT_ATTEMPTS };
};

/** Raison affichée à la personne : une catégorie, pas le journal ffmpeg (chemins, adresses) qui reste dans les logs. */
const variantErrorMessage = (e) => {
  const msg = String(e?.message ?? '');
  if (/ffmpeg n'est pas installé/i.test(msg)) return 'le traitement vidéo est indisponible sur ce serveur';
  if (e?.timedOut) return 'le délai de préparation a été dépassé';
  return 'une erreur est survenue pendant le traitement de la vidéo';
};

/**
 * Statut public d'une variante. `who` : clé du propriétaire (adhérent ou cookie anonyme) ou empreinte IP.
 * `idle` : rien n'a été préparé ; `skipped` : repli sur le fichier original (file pleine ou ffmpeg absent).
 */
export async function variantState(id, who) {
  const cfg = uniqConfig();
  if (!cfg.on || !who) return { state: 'disabled', progress: 0 };
  if (await variantFile(id, who)) return { state: 'ready', progress: 1 };
  const job = jobs.get(`${id}|${whoOf16(who)}`);
  if (job) return jobView(job);
  return { state: 'idle', progress: 0 };
}

/** Nombre maximal de tentatives d'encodage par (clip, personne) : borne le coût des réessais. */
const MAX_VARIANT_ATTEMPTS = 3;
/** Durée après laquelle un échec est oublié (cause passagère) ; l'écart minimal entre tentatives est `retryDelayMs`. */
const ERROR_TTL_MS = 15 * 60_000;

/**
 * Met une variante en file si besoin. Idempotent : prête → `ready`, déjà en cours → son statut,
 * file pleine ou ffmpeg incomplet → `skipped` (le fichier original reste servi).
 * `file` : chemin du fichier canonique du clip (déjà vérifié par l'appelant).
 */
export async function ensureVariant({ id, who, file, quality, durationS }) {
  const cfg = uniqConfig();
  if (!cfg.on || !who) return { state: 'disabled', progress: 0 };
  if (await variantFile(id, who)) return { state: 'ready', progress: 1 };
  const caps = await uniqCapabilities();
  // lu après les await : une requête concurrente a pu créer le job entre-temps
  const key = `${id}|${whoOf16(who)}`;
  const existing = jobs.get(key);
  if (existing && existing.status !== 'error') return jobView(existing);
  const recent = existing && Date.now() - existing.failedAt < ERROR_TTL_MS;
  if (recent && (existing.attempts >= MAX_VARIANT_ATTEMPTS || Date.now() - existing.failedAt < cfg.retryDelayMs)) return jobView(existing);
  if (!caps.ok || queue.length >= cfg.maxQueue) return { state: 'skipped', progress: 0 };
  const job = {
    id, who, file, quality, durationS: Number(durationS) > 0 ? Number(durationS) : 30,
    seed: seedFrom(`${id}|${who}`),
    attempts: recent ? existing.attempts + 1 : 1, // échec oublié (TTL) : compteur remis à zéro
    status: 'queued',
    progress: 0,
    cancel: null,
  };
  jobs.set(key, job);
  queue.push(job);
  pump();
  return jobView(job);
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
  const key = `${job.id}|${whoOf16(job.who)}`;
  const level = uniqConfig().level;
  const out = variantPath(job.id, job.who, level);
  const tmp = partOf(out);
  const orphan = () => jobs.get(key) !== job; // clip supprimé ou recréé : removeVariants a retiré le job
  try {
    if (orphan()) return;
    job.status = 'running';
    const caps = await uniqCapabilities();
    if (!caps.ok) {
      job.status = 'skipped';
      jobs.delete(key); // pas d'état figé : la prochaine demande re-sonde ffmpeg
      return;
    }
    const { params, args } = buildUniqArgs({ file: job.file, out: tmp, quality: job.quality, seed: job.seed, level, rubberband: caps.rubberband });
    await fs.mkdir(variantsDir(), { recursive: true }); // ffmpeg ouvre la sortie dès le départ
    // la sortie fait `trimStart` de moins que le clip : progression calculée sur la durée réelle
    const run = runFfmpeg(args, Math.max(1, job.durationS - params.trimStart), {
      onProgress: (p) => (job.progress = p),
      timeoutMs: uniqConfig().timeoutMs,
    });
    job.cancel = run.cancel;
    await run.promise;
    if (orphan()) return;
    await fs.rename(tmp, out);
    await fs.writeFile(sidecarOf(out), JSON.stringify({ clip: job.id, who: whoOf16(job.who), level, seed: job.seed, at: new Date().toISOString() }));
    job.status = 'done';
    jobs.delete(key); // le fichier fait foi : une variante évincée plus tard sera simplement re-préparée
    bytesAt = 0;
    await evictOldest(job.id);
  } catch (e) {
    if (orphan()) return;
    console.error(`Bibliothèque ${job.id} (variante) : ${e.message}`);
    job.status = 'error';
    job.failedAt = Date.now();
    job.error = variantErrorMessage(e); // phrase courte pour l'interface ; le détail complet est dans les logs
  } finally {
    job.cancel = null;
    if (job.status !== 'done') await fs.rm(tmp, { force: true });
  }
}

/** Lance ffmpeg ; renvoie { promise, cancel } ; `onProgress(0..1)` ; rejette avec le dernier message d'erreur. */
function runFfmpeg(args, total, { onProgress, timeoutMs }) {
  let kill = null;
  const promise = new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let cancelled = false;
    let timedOut = false; // drapeau séparé : le tampon stderr tronqué pourrait perdre un marqueur texte
    kill = () => {
      cancelled = true;
      proc.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
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
      if (timedOut) return reject(Object.assign(new Error(`Délai dépassé (${timeoutMs} ms)`), { timedOut: true }));
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
 * Épuration : les variantes d'un clip sans fichier actif (supprimé ou archivé) partent, ainsi que les
 * encodages abandonnés (`.part` laissés par un arrêt brutal). `activeIds` : clips dont le fichier existe.
 */
export async function sweepVariants(activeIds, now = Date.now()) {
  const dir = variantsDir();
  const names = await fs.readdir(dir).catch(() => []);
  const stale = [];
  for (const n of names) {
    if (n.endsWith('.part')) {
      const st = await fs.stat(path.join(dir, n)).catch(() => null);
      if (st && now - st.mtimeMs > 2 * uniqConfig().timeoutMs) stale.push(n);
    } else if (n.endsWith('.mp4') && !activeIds.has(n.split('_')[0])) {
      stale.push(n, `${n}.json`);
    }
  }
  await Promise.all(stale.map((n) => fs.rm(path.join(dir, n), { force: true })));
  if (stale.length) {
    bytesAt = 0;
    bytesValue = null;
  }
  return stale.filter((n) => n.endsWith('.mp4')).length;
}
