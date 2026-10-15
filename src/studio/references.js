/**
 * Photos de référence de la personne à reconnaître (David Lisnard) : ajout, liste, suppression.
 * Chaque photo est réduite à une empreinte de 128 nombres et à une vignette redressée (pour que l'admin vérifie ce que le
 * système a retenu) ; l'image d'origine n'est pas conservée.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { cosine } from './sface.js';
import { pool } from '../db.js';
import { HttpError } from '../http-error.js';
import { storageDir } from '../media.js';
import { REFERENCE } from './identity.js';

export const LABEL = 'lisnard';
export { REFERENCE };

let memo = null;
/** Jeu de photos actuel : { count, version, embeddings }. `version` change dès qu'une photo est ajoutée ou retirée. */
export async function referenceSet() {
  if (memo) return memo;
  const { rows } = await pool.query('SELECT id, embedding FROM face_references WHERE label = $1 ORDER BY id', [LABEL]);
  const hash = createHash('sha1').update(rows.map((r) => r.id).join(',')).digest('hex').slice(0, 8);
  memo = { count: rows.length, version: rows.length ? `${rows.length}-${hash}` : '', embeddings: rows.map((r) => r.embedding) };
  return memo;
}
export const forgetReferenceSet = () => {
  memo = null;
};

/** Photos de référence, avec un avertissement pour celles qui ne ressemblent pas aux autres (mauvaise personne ?). */
export async function listReferences() {
  const { rows } = await pool.query('SELECT id, name, embedding, score, face_px, created_at FROM face_references WHERE label = $1 ORDER BY id', [LABEL]);
  const embs = rows.map((r) => Float32Array.from(r.embedding));
  const references = rows.map((r, i) => {
    const sims = embs.map((e, j) => (j === i ? null : cosine(embs[i], e))).filter((v) => v !== null).sort((a, b) => b - a);
    const near = sims.slice(0, 3);
    const nearMean = near.length ? near.reduce((s, v) => s + v, 0) / near.length : null;
    return {
      id: r.id,
      name: r.name,
      score: r.score,
      face_px: r.face_px,
      created_at: r.created_at,
      similarity: nearMean === null ? null : Math.round(nearMean * 100) / 100,
      suspicious: rows.length >= 4 && nearMean !== null && nearMean < 0.3, // ne ressemble à aucune autre photo : sans doute une autre personne
    };
  });
  const set = await referenceSet();
  return { references, count: set.count, version: set.version, max: REFERENCE.max };
}

/** Empreinte d'une photo dans un thread de travail. `bytes` : contenu du fichier envoyé. */
const isImage = (b) =>
  (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || // JPEG
  (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') ||
  (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP');

async function embedPhoto(bytes) {
  // ffmpeg guesses formats from content (a playlist would be followed): reject anything that is not a plain image
  if (!Buffer.isBuffer(bytes) || !isImage(bytes)) throw new HttpError(422, "Ce fichier n'est pas une image lisible (JPEG, PNG ou WebP).");
  const dir = path.join(storageDir(), 'tmp');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `ref-${randomBytes(6).toString('hex')}`);
  await fs.writeFile(file, bytes);
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./faces-worker.js', import.meta.url), { workerData: { mode: 'reference', file } });
      let settled = false;
      const end = (fn, v) => {
        if (settled) return;
        settled = true;
        fn(v);
      };
      worker.on('message', (m) => (m.error ? end(reject, new HttpError(m.user ? 422 : 500, m.error)) : m.done && end(resolve, m.reference)));
      worker.on('error', (e) => end(reject, new HttpError(500, `Analyse de la photo impossible : ${e.message}`)));
      worker.on('exit', () => end(reject, new HttpError(500, 'Analyse de la photo interrompue.')));
    });
  } finally {
    await fs.rm(file, { force: true });
  }
}

export async function addReference({ bytes, name }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new HttpError(400, 'Aucune image reçue.');
  if (bytes.length > REFERENCE.maxBytes) throw new HttpError(413, `Image trop lourde (${Math.round(REFERENCE.maxBytes / 1048576)} Mo au maximum).`);
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM face_references WHERE label = $1', [LABEL]);
  if (n >= REFERENCE.max) throw new HttpError(409, `Déjà ${REFERENCE.max} photos : supprime-en avant d'en ajouter.`);
  const r = await embedPhoto(bytes);
  // la même photo envoyée deux fois n'apporte rien
  const { rows: same } = await pool.query('SELECT id, embedding FROM face_references WHERE label = $1', [LABEL]);
  const mine = Float32Array.from(r.embedding);
  if (same.some((s) => cosine(mine, Float32Array.from(s.embedding)) > 0.985)) throw new HttpError(409, 'Cette photo (ou une quasi identique) est déjà dans la liste.');
  const { rows: [row] } = await pool.query(
    'INSERT INTO face_references (label, name, embedding, thumb, score, face_px) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [LABEL, String(name ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 120), JSON.stringify(r.embedding), r.thumb, r.score, r.facePx],
  );
  forgetReferenceSet();
  return { id: row.id };
}

export async function deleteReference(id) {
  const { rowCount } = await pool.query('DELETE FROM face_references WHERE id = $1 AND label = $2', [id, LABEL]);
  if (!rowCount) throw new HttpError(404, 'Photo introuvable.');
  forgetReferenceSet();
}

export async function referenceThumb(id) {
  const { rows } = await pool.query('SELECT thumb FROM face_references WHERE id = $1 AND label = $2', [id, LABEL]);
  return rows[0]?.thumb ?? null;
}
