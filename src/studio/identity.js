/**
 * Reconnaissance d'une personne de référence (David Lisnard) dans les interviews.
 *
 * - `referenceFromImage` : prépare une photo de référence (un seul visage, assez grand) : empreinte + vignette redressée.
 * - `identifyVideo` : pour les plans à plusieurs visages d'une interview déjà analysée, extrait quelques images de chaque visage
 *   dans la vidéo, calcule leur empreinte et la compare à celles des photos de référence.
 *
 * Fonctions utilisées dans un thread de travail (faces-worker.js) : le calcul ne bloque pas le serveur.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FRAMING, faceTracks, splitShots } from '../../public/js/framing.js';
import { FACE_SIZE, alignFace, cosine } from './sface.js';

const run = promisify(execFile);

export const REFERENCE = { minFacePx: 50, maxSide: 1280, minScore: 0.7, otherFaceRatio: 0.45, maxBytes: 15 * 1024 * 1024, max: 60 };

/** Erreur avec un message destiné à l'admin. */
export class IdentityError extends Error {}

/** Image décodée par ffmpeg (formats courants : jpg, png, webp…) : { rgb, w, h }, réduite à `maxSide` si elle est plus grande. */
export async function decodeImage(file, maxSide = REFERENCE.maxSide) {
  let probe;
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', file], { timeout: 30_000 });
    probe = JSON.parse(stdout).streams?.[0];
  } catch {
    throw new IdentityError("Ce fichier n'est pas une image lisible (JPEG, PNG ou WebP).");
  }
  if (!probe?.width || !probe?.height) throw new IdentityError("Ce fichier n'est pas une image lisible (JPEG, PNG ou WebP).");
  const k = Math.min(1, maxSide / Math.max(probe.width, probe.height));
  const w = Math.max(2, Math.round(probe.width * k));
  const h = Math.max(2, Math.round(probe.height * k));
  const { stdout } = await run('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area,format=rgb24`, '-f', 'rawvideo', '-'], { encoding: 'buffer', maxBuffer: 1 << 28, timeout: 60_000 });
  if (stdout.length < w * h * 3) throw new IdentityError("Cette image n'a pas pu être décodée.");
  return { rgb: new Uint8Array(stdout.buffer, stdout.byteOffset, w * h * 3), w, h };
}

/** Image complétée de noir à droite et en bas jusqu'à des dimensions multiples de 32 (exigence du détecteur). */
export function padTo32(rgb, w, h) {
  const pw = Math.ceil(w / 32) * 32;
  const ph = Math.ceil(h / 32) * 32;
  if (pw === w && ph === h) return { rgb, pw, ph };
  const out = new Uint8Array(pw * ph * 3);
  for (let y = 0; y < h; y++) out.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * pw * 3);
  return { rgb: out, pw, ph };
}

/** Vignette JPEG d'un visage redressé (RVB entrelacé 112 × 112). */
export async function thumbnailJpeg(aligned) {
  return new Promise((resolve, reject) => {
    const p = execFile('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${FACE_SIZE}x${FACE_SIZE}`, '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1'], { encoding: 'buffer', maxBuffer: 1 << 24 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    p.stdin.end(Buffer.from(aligned));
  });
}

/**
 * Photo de référence : le visage le plus grand, à condition qu'il soit seul, net et assez grand.
 * Renvoie { embedding: number[128], thumb: Buffer (JPEG), score, facePx } ; lève IdentityError sinon.
 */
export async function referenceFromImage(file, { yunet, sface }) {
  const img = await decodeImage(file);
  const { rgb, pw, ph } = padTo32(img.rgb, img.w, img.h);
  const faces = yunet.detect(rgb, pw, ph, { threshold: REFERENCE.minScore });
  if (!faces.length) throw new IdentityError('Aucun visage trouvé sur cette photo (de face ou de trois quarts, bien éclairé).');
  const [best, second] = faces;
  if (second && second.w * second.h >= best.w * best.h * REFERENCE.otherFaceRatio) throw new IdentityError('Plusieurs visages sur cette photo : recadre-la sur David Lisnard.');
  if (best.w < REFERENCE.minFacePx) throw new IdentityError(`Visage trop petit (${Math.round(best.w)} px de large, ${REFERENCE.minFacePx} px au minimum) : utilise une photo plus grande ou recadrée.`);
  const aligned = alignFace(img.rgb, img.w, img.h, best.kps);
  return { embedding: Array.from(sface.embed(aligned)), thumb: await thumbnailJpeg(aligned), score: Math.round(best.score * 1000) / 1000, facePx: Math.round(best.w) };
}

/** Ressemblance d'une empreinte avec la personne de référence : moyenne de ses trois meilleures similarités avec les photos. */
export function similarity(embedding, references) {
  const sims = references.map((r) => cosine(embedding, r)).sort((a, b) => b - a);
  const top = sims.slice(0, 3);
  return top.length ? top.reduce((s, v) => s + v, 0) / top.length : 0;
}

// --- identification dans une interview -------------------------------------------------------------------------------------

/** Au plus `n` points d'un visage suivi : les plus grands et les plus nets, espacés d'au moins `gapS` secondes. */
function samplePoints(track, n = 3, gapS = 1) {
  const chosen = [];
  for (const p of [...track.pts].sort((a, b) => b.w * b.h * b.s - a.w * a.h * a.s)) {
    if (chosen.every((c) => Math.abs(c.t - p.t) >= gapS)) chosen.push(p);
    if (chosen.length >= n) break;
  }
  return chosen;
}

/** Visages à identifier : ceux des plans où l'on hésite (plusieurs visages présents). Renvoie [{ shot, track, points }]. */
export function identificationTargets({ frames, fps, aspect, duration, cuts }) {
  const targets = [];
  for (const shot of splitShots(0, duration, cuts)) {
    const tracks = faceTracks(frames, fps, aspect, shot.from, shot.to).filter((t) => t.share >= FRAMING.minShare && t.count >= 2);
    if (tracks.length < 2) continue;
    for (const track of tracks) targets.push({ shot, track, points: samplePoints(track) });
  }
  return targets;
}

/** Vignette carrée autour d'un visage, prise dans la vidéo à l'instant t : RVB 224 × 224. */
async function grabFace(file, t, box, srcW, srcH) {
  const side = Math.min(Math.round(Math.max(box.w * srcW, box.h * srcH) * 2.6), srcW, srcH);
  const x = Math.round(Math.min(Math.max(0, (box.x + box.w / 2) * srcW - side / 2), srcW - side));
  const y = Math.round(Math.min(Math.max(0, (box.y + box.h / 2) * srcH - side / 2), srcH - side));
  const { stdout } = await run(
    'ffmpeg',
    ['-v', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', `crop=${side}:${side}:${x}:${y},scale=224:224:flags=lanczos,format=rgb24`, '-f', 'rawvideo', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 24, timeout: 60_000 },
  );
  return stdout.length === 224 * 224 * 3 ? new Uint8Array(stdout.buffer, stdout.byteOffset, stdout.length) : null;
}

/**
 * Compare les visages des plans à plusieurs visages à la personne de référence.
 * Renvoie [[indice d'image, indice du visage, ressemblance], …] pour chaque visage comparé (clé lue par framing.js).
 */
export async function identifyVideo({ file, srcW, srcH, frames, fps, aspect, duration, cuts, references, yunet, sface, onProgress = () => {}, cancelled = () => false }) {
  const targets = identificationTargets({ frames, fps, aspect, duration, cuts });
  const refs = references.map((r) => Float32Array.from(r));
  const total = targets.reduce((n, t) => n + t.points.length, 0) || 1;
  const out = [];
  let done = 0;
  for (const { points } of targets) {
    for (const p of points) {
      if (cancelled()) return out;
      done++;
      onProgress(done / total);
      const [x, y, w, h] = frames[p.fi][p.di];
      const crop = await grabFace(file, p.t, { x, y, w, h }, srcW, srcH).catch(() => null);
      if (!crop) continue;
      // le visage recherché est celui qui tombe au centre de la vignette
      const found = yunet.detect(crop, 224, 224, { threshold: 0.4 }).sort((a, b) => Math.hypot(a.x + a.w / 2 - 112, a.y + a.h / 2 - 112) - Math.hypot(b.x + b.w / 2 - 112, b.y + b.h / 2 - 112))[0];
      if (!found || Math.hypot(found.x + found.w / 2 - 112, found.y + found.h / 2 - 112) > 60) continue;
      out.push([p.fi, p.di, Math.round(similarity(sface.embed(alignFace(crop, 224, 224, found.kps)), refs) * 1000) / 1000]);
    }
  }
  return out;
}
