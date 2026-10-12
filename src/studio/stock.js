/**
 * Images libres de droits pour le studio (b-roll), depuis Pixabay (https://pixabay.com/api/docs/) ou Pexels
 * (https://www.pexels.com/api/) : celui dont la clé est configurée (PIXABAY_API_KEY, PEXELS_API_KEY ; STOCK_PROVIDER pour forcer).
 *
 *  - Recherche : le serveur interroge le fournisseur avec sa clé (jamais exposée au navigateur) ; résultats mis en cache
 *    10 minutes ; nombre de recherches limité par visiteur.
 *  - Images : le navigateur ne donne qu'un NUMÉRO de photo. Le serveur retrouve l'adresse auprès du fournisseur, vérifie qu'elle est bien
 *    sur le serveur d'images du fournisseur (aucune adresse venue du visiteur n'est jamais appelée), télécharge, contrôle le type et la
 *    taille, puis garde le fichier (supprimé par le nettoyage horaire du studio).
 *  - Licences : usage gratuit, y compris commercial, sans obligation de crédit ; le crédit de l'auteur est apprécié : le studio
 *    fournit le texte à copier dans la description.
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createBudget } from '../budget.js';
import { HttpError } from '../http-error.js';
import { storageDir } from '../media.js';

const MAX_BYTES = 15 * 1024 * 1024;
const TTL_MS = 10 * 60 * 1000;

const searchBudget = createBudget(() => ({ perIpHourly: Number(process.env.STOCK_SEARCHES_PER_HOUR) || 60, dailyCap: 4000 }));
const downloadBudget = createBudget(() => ({ perIpHourly: Number(process.env.STOCK_DOWNLOADS_PER_HOUR) || 120, dailyCap: 8000 }));
const searches = new Map(); // `${fournisseur}|${q}|${page}` -> { at, value }
const photos = new Map(); // `${fournisseur}:${id}` -> { at, photo }
const inflight = new Map(); // fichier -> promesse
export const resetStockState = () => {
  searchBudget.reset();
  downloadBudget.reset();
  searches.clear();
  photos.clear();
  inflight.clear();
};

export const validPhotoId = (id) => /^\d{1,12}$/.test(String(id));
const color = (c) => (/^#[0-9a-f]{6}$/i.test(c ?? '') ? c : '#888888');
const pageUrl = (url, prefix, fallback) => (typeof url === 'string' && url.startsWith(prefix) ? url : fallback);

/** Réponse du fournisseur -> `fail(status, message)` explicite. */
function httpFailure(res, name) {
  if (res.status === 401 || res.status === 403) return new HttpError(502, `Clé ${name} refusée : vérifie la clé d'images du serveur.`);
  if (res.status === 404) return new HttpError(404, 'Image introuvable.');
  if (res.status === 429) return new HttpError(503, `${name} est très sollicité : réessaie dans quelques minutes.`);
  return new HttpError(502, `${name} a répondu par une erreur : réessaie dans un instant.`);
}

async function getJson(url, headers, fetchImpl, name) {
  let res;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new HttpError(502, `${name} ne répond pas pour le moment : réessaie dans un instant.`);
  }
  if (!res.ok) throw httpFailure(res, name);
  return res.json().catch(() => {
    throw new HttpError(502, `Réponse illisible de ${name}.`);
  });
}

// --- fournisseurs : chacun donne des photos au même format { id, thumb, width, height, alt, photographer, page, color, full, preview } ---

const PROVIDERS = {
  pixabay: {
    label: 'Pixabay',
    key: () => process.env.PIXABAY_API_KEY,
    hosts: ['pixabay.com', 'cdn.pixabay.com'],
    // largeImageURL : 1280 px de côté (fullHDURL seulement avec un compte approuvé)
    normalize: (p) => ({
      id: String(p.id),
      thumb: p.webformatURL ?? p.previewURL ?? null, // adresse valable 24 h : affichée seulement dans les résultats de recherche (usage prévu par Pixabay)
      width: p.imageWidth,
      height: p.imageHeight,
      alt: String(p.tags ?? '').slice(0, 140),
      photographer: String(p.user ?? '').slice(0, 80),
      page: pageUrl(p.pageURL, 'https://pixabay.com/', 'https://pixabay.com'),
      color: '#888888',
      full: p.fullHDURL ?? p.largeImageURL ?? p.webformatURL,
      preview: p.webformatURL ?? p.largeImageURL,
    }),
    async search(q, page, fetchImpl) {
      const params = new URLSearchParams({ key: process.env.PIXABAY_API_KEY, q, image_type: 'photo', orientation: 'vertical', per_page: '24', page: String(page), lang: 'fr', safesearch: 'true' });
      const json = await getJson(`https://pixabay.com/api/?${params}`, {}, fetchImpl, 'Pixabay');
      const list = Array.isArray(json.hits) ? json.hits.filter((p) => validPhotoId(p?.id)) : [];
      return { list, total: Number(json.totalHits) || list.length, next: page * 24 < (Number(json.totalHits) || 0) };
    },
    async meta(id, fetchImpl) {
      const json = await getJson(`https://pixabay.com/api/?${new URLSearchParams({ key: process.env.PIXABAY_API_KEY, id })}`, {}, fetchImpl, 'Pixabay');
      const p = json.hits?.[0];
      if (!validPhotoId(p?.id)) throw new HttpError(404, 'Image introuvable.');
      return p;
    },
  },
  pexels: {
    label: 'Pexels',
    key: () => process.env.PEXELS_API_KEY,
    hosts: ['images.pexels.com'],
    normalize: (p) => ({
      id: String(p.id),
      thumb: p.src?.medium ?? p.src?.small ?? null,
      width: p.width,
      height: p.height,
      alt: String(p.alt ?? '').slice(0, 140),
      photographer: String(p.photographer ?? '').slice(0, 80),
      page: pageUrl(p.url, 'https://www.pexels.com/', 'https://www.pexels.com'),
      color: color(p.avg_color),
      full: p.src?.large2x ?? p.src?.large,
      preview: p.src?.large ?? p.src?.medium,
    }),
    async search(q, page, fetchImpl) {
      const params = new URLSearchParams({ query: q, per_page: '24', page: String(page), orientation: 'portrait', locale: 'fr-FR' });
      const json = await getJson(`https://api.pexels.com/v1/search?${params}`, { Authorization: process.env.PEXELS_API_KEY }, fetchImpl, 'Pexels');
      const list = Array.isArray(json.photos) ? json.photos.filter((p) => validPhotoId(p?.id)) : [];
      return { list, total: Number(json.total_results) || list.length, next: Boolean(json.next_page) };
    },
    async meta(id, fetchImpl) {
      const p = await getJson(`https://api.pexels.com/v1/photos/${id}`, { Authorization: process.env.PEXELS_API_KEY }, fetchImpl, 'Pexels');
      if (!validPhotoId(p?.id)) throw new HttpError(502, 'Réponse inattendue de Pexels.');
      return p;
    },
  },
};

/** Fournisseur utilisé : STOCK_PROVIDER s'il a une clé, sinon le premier qui en a une (Pixabay, puis Pexels). */
export function activeProvider() {
  const wanted = PROVIDERS[process.env.STOCK_PROVIDER];
  if (wanted?.key()) return { id: process.env.STOCK_PROVIDER, ...wanted };
  const id = ['pixabay', 'pexels'].find((k) => PROVIDERS[k].key());
  return id ? { id, ...PROVIDERS[id] } : null;
}
export const stockEnabled = () => Boolean(activeProvider());
export const stockProvider = () => activeProvider()?.label ?? null;
export const stockDir = () => path.join(storageDir(), 'stock');

const need = () => {
  const p = activeProvider();
  if (!p) throw new HttpError(503, "La recherche d'images n'est pas configurée sur ce site.");
  return p;
};

const present = (n) => ({ id: n.id, thumb: n.thumb, width: n.width, height: n.height, alt: n.alt, photographer: n.photographer, page: n.page, color: n.color });

function remember(provider, raw) {
  const n = provider.normalize(raw);
  photos.set(`${provider.id}:${n.id}`, { at: Date.now(), photo: n });
  if (photos.size > 2000) photos.delete(photos.keys().next().value);
  return n;
}

/** Recherche de photos (verticales d'abord) : { photos: [...], page, total, next, provider }. */
export async function searchPhotos(query, { page = 1, ip = 'local', fetchImpl = fetch } = {}) {
  const q = String(query ?? '').replace(/\s+/g, ' ').trim();
  if (q.length < 2) throw new HttpError(400, 'Écris au moins 2 lettres.');
  if (q.length > 80) throw new HttpError(400, 'Recherche trop longue.');
  const provider = need();
  const pageNo = Math.min(10, Math.max(1, Math.round(Number(page)) || 1));
  const key = `${provider.id}|${q.toLowerCase()}|${pageNo}`;
  const hit = searches.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  if (!searchBudget.take(ip)) throw new HttpError(429, 'Trop de recherches pour le moment : réessaie dans quelques minutes.');
  const { list, total, next } = await provider.search(q, pageNo, fetchImpl);
  const value = { photos: list.map((raw) => present(remember(provider, raw))), page: pageNo, total, next, provider: provider.label };
  searches.set(key, { at: Date.now(), value });
  if (searches.size > 300) searches.delete(searches.keys().next().value);
  return value;
}

async function photoMeta(provider, id, fetchImpl) {
  const hit = photos.get(`${provider.id}:${id}`);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.photo;
  return remember(provider, await provider.meta(id, fetchImpl));
}

/** Informations d'une photo (crédit compris), ou 404. */
export async function photoInfo(id, { fetchImpl = fetch } = {}) {
  if (!validPhotoId(id)) throw new HttpError(400, 'Numéro de photo invalide.');
  const provider = need();
  return present(await photoMeta(provider, String(id), fetchImpl));
}

/** Télécharge `url` sans jamais sortir des serveurs d'images du fournisseur : https, hôte autorisé, redirections vérifiées une à une. */
async function download(url, hosts, fetchImpl) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    let u;
    try {
      u = new URL(current);
    } catch {
      throw new HttpError(502, 'Adresse d’image inattendue.');
    }
    if (u.protocol !== 'https:' || !hosts.includes(u.hostname)) throw new HttpError(502, 'Adresse d’image inattendue.');
    let res;
    try {
      res = await fetchImpl(u, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new HttpError(502, "Impossible de télécharger l'image.");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), u).href;
      continue;
    }
    if (!res.ok) throw new HttpError(502, "Impossible de télécharger l'image.");
    if (!/^image\/(jpeg|png|webp)/i.test(res.headers.get('content-type') ?? '')) throw new HttpError(502, 'Fichier inattendu pour cette image.');
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new HttpError(502, 'Image trop lourde.');
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) throw new HttpError(502, 'Image trop lourde ou vide.');
    return buf;
  }
  throw new HttpError(502, "Impossible de télécharger l'image.");
}

/**
 * Chemin local de l'image `id`, téléchargée si besoin. `size` : 'preview' (aperçu du navigateur) ou 'full' (rendu final).
 * Seules les adresses des serveurs d'images du fournisseur sont appelées, en HTTPS.
 */
export async function ensureImage(id, size = 'full', { ip = 'local', fetchImpl = fetch } = {}) {
  if (!validPhotoId(id)) throw new HttpError(400, 'Numéro de photo invalide.');
  const provider = need();
  const file = path.join(stockDir(), `${provider.id}-${id}-${size === 'preview' ? 'p' : 'f'}.jpg`);
  if (await fs.stat(file).then((s) => s.size > 0, () => false)) return file;
  if (inflight.has(file)) return inflight.get(file);
  const job = (async () => {
    if (!downloadBudget.take(ip)) throw new HttpError(429, "Trop d'images demandées pour le moment : réessaie dans quelques minutes.");
    const meta = await photoMeta(provider, String(id), fetchImpl);
    const buf = await download(size === 'preview' ? meta.preview : meta.full, provider.hosts, fetchImpl);
    await fs.mkdir(stockDir(), { recursive: true });
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, file);
    return file;
  })().finally(() => inflight.delete(file));
  inflight.set(file, job);
  return job;
}
