/**
 * Fichiers vidéo du studio de clips : stockage sur disque (volume Railway monté sur STORAGE_DIR), dépôt par morceaux
 * (reprise possible après une coupure, pas de limite de durée de requête) et vérification avec ffprobe.
 *
 *   <STORAGE_DIR>/uploads/<id>.part   dépôt en cours
 *   <STORAGE_DIR>/videos/<id>.<ext>   fichier validé (mp4, mkv ou webm)
 *
 * Les noms de fichiers viennent uniquement de l'identifiant YouTube (11 caractères sûrs) : jamais d'un nom envoyé par le client.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { HttpError } from './http-error.js';

const run = promisify(execFile);

export const CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const EXTENSIONS = ['mp4', 'mkv', 'webm'];

export const storageDir = () => path.resolve(process.env.STORAGE_DIR || 'data');
export const maxVideoBytes = () => (Number(process.env.MAX_VIDEO_MB) || 2000) * 1024 * 1024;

const safeId = (youtubeId) => {
  if (!YT_ID.test(String(youtubeId))) throw new HttpError(400, 'Identifiant de vidéo invalide.');
  return String(youtubeId);
};
export const partPath = (youtubeId) => path.join(storageDir(), 'uploads', `${safeId(youtubeId)}.part`);
/** Chemin d'un fichier validé ; `name` vient de la base (jamais du client) et est revérifié. */
export function videoFilePath(name) {
  if (!/^[A-Za-z0-9_-]{11}\.(mp4|mkv|webm)$/.test(String(name))) throw new HttpError(404, 'Fichier introuvable.');
  return path.join(storageDir(), 'videos', name);
}

/** Version of an interview file: changes when the admin replaces the video. */
export const stampOf = (video) => `${video.file_name}|${video.file_size}|${video.file_uploaded_at instanceof Date ? video.file_uploaded_at.toISOString() : video.file_uploaded_at}`;

const ensureDirs = async () => {
  await fs.mkdir(path.join(storageDir(), 'uploads'), { recursive: true });
  await fs.mkdir(path.join(storageDir(), 'videos'), { recursive: true });
};

// --- ffprobe -------------------------------------------------------------------------

let ffprobeAvailable;
export async function ffmpegAvailable() {
  if (ffprobeAvailable === undefined) {
    ffprobeAvailable = await run('ffprobe', ['-version'], { timeout: 10_000 }).then(() => true, () => false);
  }
  return ffprobeAvailable;
}

/** Lit un fichier vidéo : durée, définition, présence d'une piste audio, extension à utiliser. Lève 422 si ce n'est pas une vidéo. */
export async function probeVideo(file) {
  let stdout;
  try {
    ({ stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (e) {
    if (e.code === 'ENOENT') throw new HttpError(503, "ffmpeg n'est pas installé sur ce serveur : impossible de vérifier la vidéo.");
    throw new HttpError(422, "Ce fichier n'est pas une vidéo lisible (formats acceptés : mp4, mov, mkv, webm).");
  }
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new HttpError(422, 'Fichier vidéo illisible.');
  }
  const streams = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new HttpError(422, 'Ce fichier ne contient pas de piste vidéo.');
  const duration = Number(info.format?.duration) || Number(video.duration) || 0;
  if (!(duration > 0)) throw new HttpError(422, 'Durée de la vidéo introuvable.');
  const format = String(info.format?.format_name ?? '');
  let ext = null;
  if (/matroska|webm/.test(format)) ext = /^(vp8|vp9|av1)$/.test(video.codec_name) ? 'webm' : 'mkv';
  else if (/mp4|mov/.test(format)) ext = 'mp4';
  if (!ext) throw new HttpError(422, `Format « ${format || 'inconnu'} » non accepté (mp4, mov, mkv ou webm).`);
  return {
    duration_s: Math.round(duration * 10) / 10,
    width: Number(video.width) || null,
    height: Number(video.height) || null,
    has_audio: streams.some((s) => s.codec_type === 'audio'),
    ext,
  };
}

// --- dépôt par morceaux ----------------------------------------------------------------

const locks = new Map(); // un seul morceau écrit à la fois par vidéo
function serial(key, fn) {
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  locks.set(key, next);
  next.catch(() => {}).finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  });
  return next;
}

const sizeOf = async (file) => fs.stat(file).then((s) => s.size, () => null);

/** Ouvre un dépôt : vérifie la taille et l'espace disque, repart d'un fichier vide. */
export async function startUpload(youtubeId, size) {
  const total = Number(size);
  if (!Number.isFinite(total) || total <= 0) throw new HttpError(400, 'Taille du fichier invalide.');
  if (total > maxVideoBytes()) throw new HttpError(413, `Fichier trop gros (${Math.round(maxVideoBytes() / 1024 / 1024)} Mo au maximum).`);
  await ensureDirs();
  try {
    const st = await fs.statfs(storageDir());
    if (st.bavail * st.bsize < total + 200 * 1024 * 1024) throw new HttpError(507, "Pas assez d'espace libre sur le stockage du serveur.");
  } catch (e) {
    if (e instanceof HttpError) throw e; // statfs indisponible : on laisse faire
  }
  return serial(youtubeId, async () => {
    await fs.writeFile(partPath(youtubeId), '');
    return { chunk_bytes: CHUNK_BYTES };
  });
}

/** Ajoute un morceau à l'offset attendu. Si l'offset ne correspond pas, renvoie 409 avec la taille reçue pour reprendre. */
export function appendChunk(youtubeId, offset, buffer, expectedTotal) {
  return serial(youtubeId, async () => {
    const part = partPath(youtubeId);
    const have = await sizeOf(part);
    if (have === null) throw new HttpError(409, 'Aucun dépôt en cours : recommence.', { received: 0 });
    if (offset !== have) throw new HttpError(409, 'Morceau inattendu : reprise au bon endroit.', { received: have });
    if (!buffer?.length) throw new HttpError(400, 'Morceau vide.');
    if (have + buffer.length > Math.min(maxVideoBytes(), expectedTotal ?? Infinity)) throw new HttpError(413, 'Le fichier dépasse la taille annoncée.');
    await fs.appendFile(part, buffer);
    return { received: have + buffer.length };
  });
}

/** Termine un dépôt : vérifie la taille et le contenu avec ffprobe, puis remplace le fichier actuel. */
export function finishUpload(youtubeId, expectedSize) {
  return serial(youtubeId, async () => {
    const part = partPath(youtubeId);
    const have = await sizeOf(part);
    if (have === null) throw new HttpError(409, 'Aucun dépôt en cours.', { received: 0 });
    if (have !== Number(expectedSize)) throw new HttpError(409, `Fichier incomplet (${have} octets reçus sur ${expectedSize}).`, { received: have });
    let meta;
    try {
      meta = await probeVideo(part);
    } catch (e) {
      await fs.rm(part, { force: true });
      throw e;
    }
    const name = `${safeId(youtubeId)}.${meta.ext}`;
    await fs.rename(part, videoFilePath(name)); // replaces a same-extension file in one step
    await removeFinalFiles(youtubeId, meta.ext); // une seule version à la fois
    return { ...meta, name, size: have };
  });
}

const removeFinalFiles = (youtubeId, keepExt = null) =>
  Promise.all(EXTENSIONS.filter((ext) => ext !== keepExt).map((ext) => fs.rm(path.join(storageDir(), 'videos', `${safeId(youtubeId)}.${ext}`), { force: true })));

/** Supprime le fichier (toutes extensions) et un éventuel dépôt en cours. */
export async function removeVideoFiles(youtubeId) {
  await Promise.all([removeFinalFiles(youtubeId), fs.rm(partPath(youtubeId), { force: true })]);
}

/** Écart de durée toléré entre le fichier et la vidéo YouTube (secondes) avant d'avertir. */
export const DURATION_TOLERANCE_S = 3;
