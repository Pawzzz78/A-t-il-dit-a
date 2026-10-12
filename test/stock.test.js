// Images libres de droits (Pexels) : recherche, cache, téléchargement sûr (jamais d'adresse venue du visiteur).
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

let stock;
let dir;
const photo = (id, extra = {}) => ({
  id,
  width: 1253,
  height: 1880,
  url: `https://www.pexels.com/photo/x-${id}/`,
  photographer: 'Camille Durand',
  avg_color: '#112233',
  alt: 'Une mairie',
  src: { original: `https://images.pexels.com/photos/${id}/o.jpeg`, large2x: `https://images.pexels.com/photos/${id}/l2.jpeg`, large: `https://images.pexels.com/photos/${id}/l.jpeg`, medium: `https://images.pexels.com/photos/${id}/m.jpeg` },
  ...extra,
});
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const jpeg = (n = 5000, type = 'image/jpeg') => new Response(Buffer.alloc(n, 1), { status: 200, headers: { 'content-type': type } });

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stock-test-'));
  process.env.STORAGE_DIR = dir;
  process.env.PEXELS_API_KEY = 'cle-de-test';
  stock = await import('../src/studio/stock.js');
});
beforeEach(() => stock.resetStockState());
after(async () => {
  delete process.env.PEXELS_API_KEY;
  await fs.rm(dir, { recursive: true, force: true });
});

test('recherche : clé côté serveur, résultats simplifiés, mis en cache, entrées contrôlées', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), auth: opts.headers.Authorization });
    return json({ photos: [photo(11), photo(22, { avg_color: 'pas-une-couleur', url: 'https://evil.test/' }), { id: 'abc' }], total_results: 40, next_page: 'https://api.pexels.com/v1/search?page=2' });
  };
  const r = await stock.searchPhotos('  Mairie  de   Nice ', { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth, 'cle-de-test');
  const u = new URL(calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://api.pexels.com/v1/search');
  assert.deepEqual([u.searchParams.get('query'), u.searchParams.get('orientation'), u.searchParams.get('locale')], ['Mairie de Nice', 'portrait', 'fr-FR']);
  assert.deepEqual(r.photos.map((p) => p.id), ['11', '22']); // identifiant illisible écarté
  assert.deepEqual(r.photos[0], { id: '11', thumb: 'https://images.pexels.com/photos/11/m.jpeg', width: 1253, height: 1880, alt: 'Une mairie', photographer: 'Camille Durand', page: 'https://www.pexels.com/photo/x-11/', color: '#112233' });
  assert.equal(r.photos[1].color, '#888888'); // valeurs du fournisseur contrôlées
  assert.equal(r.photos[1].page, 'https://www.pexels.com'); // jamais un lien vers un autre site
  assert.equal(r.next, true);
  await stock.searchPhotos('mairie de nice', { fetchImpl }); // même recherche (casse et espaces près) : cache
  assert.equal(calls.length, 1);
  await assert.rejects(stock.searchPhotos('a', { fetchImpl }), (e) => e.status === 400);
  await assert.rejects(stock.searchPhotos('x'.repeat(81), { fetchImpl }), (e) => e.status === 400);
});

test('recherche : limite par visiteur, erreurs du fournisseur expliquées, sans clé', async () => {
  process.env.STOCK_SEARCHES_PER_HOUR = '2';
  try {
    const ok = async () => json({ photos: [], total_results: 0 });
    await stock.searchPhotos('un', { fetchImpl: ok, ip: '1.1.1.1' });
    await stock.searchPhotos('deux', { fetchImpl: ok, ip: '1.1.1.1' });
    await assert.rejects(stock.searchPhotos('trois', { fetchImpl: ok, ip: '1.1.1.1' }), (e) => e.status === 429);
    await stock.searchPhotos('trois', { fetchImpl: ok, ip: '2.2.2.2' }); // un autre visiteur n'est pas gêné
  } finally {
    delete process.env.STOCK_SEARCHES_PER_HOUR;
  }
  stock.resetStockState();
  const status = (code) => async () => json({}, code);
  await assert.rejects(stock.searchPhotos('mairie', { fetchImpl: status(401) }), (e) => e.status === 502 && /Clé Pexels/.test(e.message));
  await assert.rejects(stock.searchPhotos('école', { fetchImpl: status(429) }), (e) => e.status === 503);
  await assert.rejects(stock.searchPhotos('argent', { fetchImpl: status(500) }), (e) => e.status === 502);
  await assert.rejects(stock.searchPhotos('mer', { fetchImpl: async () => { throw new Error('réseau'); } }), (e) => e.status === 502);
  delete process.env.PEXELS_API_KEY;
  try {
    assert.equal(stock.stockEnabled(), false);
    await assert.rejects(stock.searchPhotos('sans clé', { fetchImpl: async () => json({}) }), (e) => e.status === 503);
  } finally {
    process.env.PEXELS_API_KEY = 'cle-de-test';
  }
});

test('image : téléchargée une fois, seulement depuis le serveur d\'images, type et taille contrôlés', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    seen.push(u.href);
    if (u.hostname === 'api.pexels.com') return json(photo(Number(u.pathname.split('/').pop())));
    return jpeg();
  };
  const f1 = await stock.ensureImage('314', 'full', { fetchImpl });
  assert.ok(f1.endsWith('314-f.jpg'));
  assert.equal((await fs.stat(f1)).size, 5000);
  assert.ok(seen.includes('https://images.pexels.com/photos/314/l2.jpeg')); // rendu final : grande taille
  const n = seen.length;
  assert.equal(await stock.ensureImage('314', 'full', { fetchImpl }), f1); // déjà là : aucun appel
  assert.equal(seen.length, n);
  const p1 = await stock.ensureImage('314', 'preview', { fetchImpl });
  assert.ok(p1.endsWith('314-p.jpg') && seen.includes('https://images.pexels.com/photos/314/l.jpeg'));
  // deux demandes simultanées : un seul téléchargement
  seen.length = 0;
  const [a, b] = await Promise.all([stock.ensureImage('500', 'full', { fetchImpl }), stock.ensureImage('500', 'full', { fetchImpl })]);
  assert.equal(a, b);
  assert.equal(seen.filter((x) => x.includes('/photos/500/l2')).length, 1);
  assert.deepEqual((await fs.readdir(stock.stockDir())).filter((x) => x.endsWith('.tmp')), []); // pas de fichier temporaire laissé
});

test('image : adresse étrangère, redirection, mauvais type, trop lourde ou numéro invalide refusés', async () => {
  const meta = (src) => async (url) => (new URL(url).hostname === 'api.pexels.com' ? json(photo(900, { src })) : jpeg());
  // l'adresse donnée par le fournisseur doit être sur images.pexels.com, en https
  await assert.rejects(stock.ensureImage('900', 'full', { fetchImpl: meta({ large2x: 'https://evil.test/a.jpg' }) }), (e) => e.status === 502);
  stock.resetStockState();
  await assert.rejects(stock.ensureImage('900', 'full', { fetchImpl: meta({ large2x: 'http://images.pexels.com/a.jpg' }) }), (e) => e.status === 502);
  stock.resetStockState();
  await assert.rejects(stock.ensureImage('900', 'full', { fetchImpl: meta({ large2x: 'https://images.pexels.com.evil.test/a.jpg' }) }), (e) => e.status === 502);
  stock.resetStockState();
  // type de fichier
  const html = async (url) => (new URL(url).hostname === 'api.pexels.com' ? json(photo(901)) : jpeg(100, 'text/html'));
  await assert.rejects(stock.ensureImage('901', 'full', { fetchImpl: html }), (e) => e.status === 502 && /inattendu/.test(e.message));
  // taille
  const big = async (url) => (new URL(url).hostname === 'api.pexels.com' ? json(photo(902)) : new Response(Buffer.alloc(10), { headers: { 'content-type': 'image/jpeg', 'content-length': String(40 * 1024 * 1024) } }));
  await assert.rejects(stock.ensureImage('902', 'full', { fetchImpl: big }), (e) => e.status === 502 && /lourde/.test(e.message));
  // pas de redirection suivie
  let redirectOpt;
  const redirects = async (url, opts) => {
    if (new URL(url).hostname === 'api.pexels.com') return json(photo(903));
    redirectOpt = opts.redirect;
    return jpeg();
  };
  await stock.ensureImage('903', 'full', { fetchImpl: redirects });
  assert.equal(redirectOpt, 'error');
  // numéros invalides : jamais de chemin ni d'adresse
  for (const id of ['', 'abc', '../1', '1/../2', '12345678901234', 'https://x.test/a', '-1', '1.5']) {
    await assert.rejects(stock.ensureImage(id, 'full', { fetchImpl: async () => json({}) }), (e) => e.status === 400, id);
  }
  assert.equal(stock.validPhotoId('42'), true);
  assert.equal(stock.validPhotoId('4 2'), false);
  // téléchargements limités par visiteur
  stock.resetStockState();
  process.env.STOCK_DOWNLOADS_PER_HOUR = '1';
  try {
    const ok = async (url) => (new URL(url).hostname === 'api.pexels.com' ? json(photo(Number(new URL(url).pathname.split('/').pop()))) : jpeg());
    await stock.ensureImage('950', 'full', { fetchImpl: ok, ip: '9.9.9.9' });
    await assert.rejects(stock.ensureImage('951', 'full', { fetchImpl: ok, ip: '9.9.9.9' }), (e) => e.status === 429);
  } finally {
    delete process.env.STOCK_DOWNLOADS_PER_HOUR;
  }
});
