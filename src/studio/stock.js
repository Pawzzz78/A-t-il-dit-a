/**
 * Images libres de droits pour le studio (b-roll), depuis Pexels (https://www.pexels.com/api/).
 *
 *  - Recherche : le serveur interroge Pexels avec la clé PEXELS_API_KEY (jamais exposée au navigateur) ; résultats mis en cache
 *    10 minutes ; nombre de recherches limité par visiteur.
 *  - Images : le navigateur ne donne qu'un NUMÉRO de photo. Le serveur retrouve l'adresse auprès de Pexels, vérifie qu'elle est bien
 *    sur le serveur d'images de Pexels (aucune adresse venue du visiteur n'est jamais appelée), télécharge, contrôle le type et la
 *    taille, puis garde le fichier (supprimé par le nettoyage horaire du studio).
 *  - Licence Pexels : usage gratuit, y compris commercial, sans obligation de crédit mais le crédit du photographe est apprécié :
 *    l'éditeur du studio fournit le texte à copier dans la description.
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createBudget } from '../budget.js';
import { HttpError } from '../http-error.js';
import { storageDir } from '../media.js';

const API = 'https://api.pexels.com/v1';
const CDN_HOST = 'images.pexels.com';
const MAX_BYTES = 15 * 1024 * 1024;
const TTL_MS = 10 * 60 * 1000;
export const STOCK_PROVIDER = 'Pexels';

export const stockEnabled = () => Boolean(process.env.PEXELS_API_KEY);
export const stockDir = () => path.join(storageDir(), 'stock');
export const validPhotoId = (id) => /^\d{1,12}$/.test(String(id));

const searchBudget = createBudget(() => ({ perIpHourly: Number(process.env.STOCK_SEARCHES_PER_HOUR) || 60, dailyCap: 4000 }));
const downloadBudget = createBudget(() => ({ perIpHourly: Number(process.env.STOCK_DOWNLOADS_PER_HOUR) || 120, dailyCap: 8000 }));
const searches = new Map(); // `${q}|${page}` -> { at, value }
const photos = new Map(); // id -> { at, photo }
const inflight = new Map(); // fichier -> promesse
export const resetStockState = () => {
  searchBudget.reset();
  downloadBudget.reset();
  searches.clear();
  photos.clear();
  inflight.clear();
};

const present = (p) => ({
  id: String(p.id),
  thumb: p.src?.medium ?? p.src?.small ?? null,
  width: p.width,
  height: p.height,
  alt: String(p.alt ?? '').slice(0, 140),
  photographer: String(p.photographer ?? '').slice(0, 80),
  page: typeof p.url === 'string' && p.url.startsWith('https://www.pexels.com/') ? p.url : 'https://www.pexels.com',
  color: /^#[0-9a-f]{6}$/i.test(p.avg_color ?? '') ? p.avg_color : '#888888',
});

function remember(p) {
  photos.set(String(p.id), { at: Date.now(), photo: p });
  if (photos.size > 2000) photos.delete(photos.keys().next().value);
}

async function api(pathAndQuery, fetchImpl) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw new HttpError(503, "La recherche d'images n'est pas configurée sur ce site.");
  let res;
  try {
    res = await fetchImpl(`${API}${pathAndQuery}`, { headers: { Authorization: key }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new HttpError(502, 'Pexels ne répond pas pour le moment : réessaie dans un instant.');
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'Clé Pexels refusée : vérifie PEXELS_API_KEY.');
  if (res.status === 404) throw new HttpError(404, 'Image introuvable.');
  if (res.status === 429) throw new HttpError(503, 'Pexels est très sollicité : réessaie dans quelques minutes.');
  if (!res.ok) throw new HttpError(502, 'Pexels a répondu par une erreur : réessaie dans un instant.');
  return res.json().catch(() => {
    throw new HttpError(502, 'Réponse illisible de Pexels.');
  });
}

/** Recherche de photos (verticales d'abord) : { photos: [...], page, total, next }. */
export async function searchPhotos(query, { page = 1, ip = 'local', fetchImpl = fetch } = {}) {
  const q = String(query ?? '').replace(/\s+/g, ' ').trim();
  if (q.length < 2) throw new HttpError(400, 'Écris au moins 2 lettres.');
  if (q.length > 80) throw new HttpError(400, 'Recherche trop longue.');
  const pageNo = Math.min(10, Math.max(1, Math.round(Number(page)) || 1));
  const key = `${q.toLowerCase()}|${pageNo}`;
  const hit = searches.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  if (!searchBudget.take(ip)) throw new HttpError(429, 'Trop de recherches pour le moment : réessaie dans quelques minutes.');
  const json = await api(`/search?${new URLSearchParams({ query: q, per_page: '24', page: String(pageNo), orientation: 'portrait', locale: 'fr-FR' })}`, fetchImpl);
  const list = Array.isArray(json.photos) ? json.photos.filter((p) => validPhotoId(p?.id)) : [];
  list.forEach(remember);
  const value = { photos: list.map(present), page: pageNo, total: Number(json.total_results) || list.length, next: Boolean(json.next_page) };
  searches.set(key, { at: Date.now(), value });
  if (searches.size > 300) searches.delete(searches.keys().next().value);
  return value;
}

async function photoMeta(id, fetchImpl) {
  const hit = photos.get(id);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.photo;
  const p = await api(`/photos/${id}`, fetchImpl);
  if (!validPhotoId(p?.id)) throw new HttpError(502, 'Réponse inattendue de Pexels.');
  remember(p);
  return p;
}

/** Informations d'une photo (crédit compris), ou 404. */
export async function photoInfo(id, { fetchImpl = fetch } = {}) {
  if (!validPhotoId(id)) throw new HttpError(400, 'Numéro de photo invalide.');
  return present(await photoMeta(String(id), fetchImpl));
}

/**
 * Chemin local de l'image `id`, téléchargée si besoin. `size` : 'preview' (aperçu du navigateur) ou 'full' (rendu final).
 * Seules les adresses du serveur d'images de Pexels sont appelées, en HTTPS, sans suivre de redirection.
 */
export async function ensureImage(id, size = 'full', { ip = 'local', fetchImpl = fetch } = {}) {
  if (!validPhotoId(id)) throw new HttpError(400, 'Numéro de photo invalide.');
  const file = path.join(stockDir(), `${id}-${size === 'preview' ? 'p' : 'f'}.jpg`);
  if (await fs.stat(file).then((s) => s.size > 0, () => false)) return file;
  if (inflight.has(file)) return inflight.get(file);
  const job = (async () => {
    if (!downloadBudget.take(ip)) throw new HttpError(429, "Trop d'images demandées pour le moment : réessaie dans quelques minutes.");
    const meta = await photoMeta(String(id), fetchImpl);
    const url = size === 'preview' ? (meta.src?.large ?? meta.src?.medium) : (meta.src?.large2x ?? meta.src?.large);
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new HttpError(502, 'Adresse d’image inattendue.');
    }
    if (u.protocol !== 'https:' || u.hostname !== CDN_HOST) throw new HttpError(502, 'Adresse d’image inattendue.');
    let res;
    try {
      res = await fetchImpl(u, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new HttpError(502, "Impossible de télécharger l'image.");
    }
    if (!res.ok) throw new HttpError(502, "Impossible de télécharger l'image.");
    if (!/^image\/(jpeg|png|webp)/i.test(res.headers.get('content-type') ?? '')) throw new HttpError(502, 'Fichier inattendu pour cette image.');
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new HttpError(502, 'Image trop lourde.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) throw new HttpError(502, 'Image trop lourde ou vide.');
    await fs.mkdir(stockDir(), { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, file);
    return file;
  })().finally(() => inflight.delete(file));
  inflight.set(file, job);
  return job;
}
