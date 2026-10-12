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
  delete process.env.PIXABAY_API_KEY;
  delete process.env.STOCK_PROVIDER;
  stock = await import('../src/studio/stock.js');
});
beforeEach(() => stock.resetStockState());
after(async () => {
  delete process.env.PEXELS_API_KEY;
  await fs.rm(dir, { recursive: true, force: true });
});

test('Pexels — recherche : clé côté serveur, résultats simplifiés, mis en cache, entrées contrôlées', async () => {
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

test('Pexels — recherche : limite par visiteur, erreurs du fournisseur expliquées, sans clé', async () => {
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

test('Pexels — image : téléchargée une fois, seulement depuis le serveur d\'images, type et taille contrôlés', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    seen.push(u.href);
    if (u.hostname === 'api.pexels.com') return json(photo(Number(u.pathname.split('/').pop())));
    return jpeg();
  };
  const f1 = await stock.ensureImage('314', 'full', { fetchImpl });
  assert.ok(f1.endsWith('pexels-314-f.jpg'));
  assert.equal((await fs.stat(f1)).size, 5000);
  assert.ok(seen.includes('https://images.pexels.com/photos/314/l2.jpeg')); // rendu final : grande taille
  const n = seen.length;
  assert.equal(await stock.ensureImage('314', 'full', { fetchImpl }), f1); // déjà là : aucun appel
  assert.equal(seen.length, n);
  const p1 = await stock.ensureImage('314', 'preview', { fetchImpl });
  assert.ok(p1.endsWith('pexels-314-p.jpg') && seen.includes('https://images.pexels.com/photos/314/l.jpeg'));
  // deux demandes simultanées : un seul téléchargement
  seen.length = 0;
  const [a, b] = await Promise.all([stock.ensureImage('500', 'full', { fetchImpl }), stock.ensureImage('500', 'full', { fetchImpl })]);
  assert.equal(a, b);
  assert.equal(seen.filter((x) => x.includes('/photos/500/l2')).length, 1);
  assert.deepEqual((await fs.readdir(stock.stockDir())).filter((x) => x.endsWith('.tmp')), []); // pas de fichier temporaire laissé
});

test('Pexels — image : adresse étrangère, redirection, mauvais type, trop lourde ou numéro invalide refusés', async () => {
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
  // redirections : suivies une à une, seulement vers le serveur d'images (sinon refus)
  const hops = [];
  const redirects = (target) => async (url, opts) => {
    if (new URL(url).hostname === 'api.pexels.com') return json(photo(903));
    hops.push(String(url));
    assert.equal(opts.redirect, 'manual');
    return hops.length === 1 ? new Response(null, { status: 302, headers: { location: target } }) : jpeg();
  };
  stock.resetStockState();
  await stock.ensureImage('903', 'full', { fetchImpl: redirects('https://images.pexels.com/photos/903/autre.jpeg') });
  assert.deepEqual(hops.map((h) => new URL(h).hostname), ['images.pexels.com', 'images.pexels.com']);
  hops.length = 0;
  stock.resetStockState();
  await assert.rejects(stock.ensureImage('904', 'full', { fetchImpl: async (url, opts) => (new URL(url).hostname === 'api.pexels.com' ? json(photo(904)) : (hops.push(String(url)), new Response(null, { status: 302, headers: { location: 'https://evil.test/x.jpg' } }))) }), (e) => e.status === 502);
  assert.deepEqual(hops.map((h) => new URL(h).hostname), ['images.pexels.com']); // l'adresse étrangère n'est jamais appelée
  // boucle de redirections : abandon
  await assert.rejects(stock.ensureImage('905', 'full', { fetchImpl: async (url) => (new URL(url).hostname === 'api.pexels.com' ? json(photo(905)) : new Response(null, { status: 302, headers: { location: 'https://images.pexels.com/loop.jpg' } })) }), (e) => e.status === 502);
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

// --- Pixabay ----------------------------------------------------------------------------------------------------------------

const hit = (id, extra = {}) => ({
  id,
  pageURL: `https://pixabay.com/photos/mairie-${id}/`,
  tags: 'mairie, bâtiment, ville',
  previewURL: `https://cdn.pixabay.com/photo/${id}/p.jpg`,
  webformatURL: `https://pixabay.com/get/w${id}_640.jpg`,
  largeImageURL: `https://pixabay.com/get/l${id}_1280.jpg`,
  imageWidth: 3000,
  imageHeight: 4500,
  user: 'Jean_Dupont',
  ...extra,
});

test('fournisseur : Pixabay si sa clé est là, Pexels sinon ; STOCK_PROVIDER force le choix ; rien sans clé', () => {
  assert.equal(stock.stockProvider(), 'Pexels');
  process.env.PIXABAY_API_KEY = 'cle-pixabay';
  try {
    assert.equal(stock.stockProvider(), 'Pixabay'); // les deux clés : Pixabay (Pexels n'ouvre plus de clés)
    process.env.STOCK_PROVIDER = 'pexels';
    assert.equal(stock.stockProvider(), 'Pexels');
    process.env.STOCK_PROVIDER = 'inconnu';
    assert.equal(stock.stockProvider(), 'Pixabay');
    delete process.env.STOCK_PROVIDER;
    delete process.env.PEXELS_API_KEY;
    assert.equal(stock.stockProvider(), 'Pixabay');
    delete process.env.PIXABAY_API_KEY;
    assert.equal(stock.stockEnabled(), false);
    assert.equal(stock.stockProvider(), null);
  } finally {
    process.env.PEXELS_API_KEY = 'cle-de-test';
    delete process.env.PIXABAY_API_KEY;
    delete process.env.STOCK_PROVIDER;
  }
});

test('Pixabay — recherche : paramètres, résultats simplifiés, cache, pagination', async () => {
  process.env.PIXABAY_API_KEY = 'cle-pixabay';
  try {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(new URL(url));
      return json({ totalHits: 60, hits: [hit(11), hit(22, { pageURL: 'https://evil.test/', user: 'x'.repeat(200) }), { id: 'abc' }] });
    };
    const r = await stock.searchPhotos(' Mairie ', { fetchImpl, page: 2 });
    assert.equal(calls.length, 1);
    const q = calls[0].searchParams;
    assert.equal(calls[0].origin + calls[0].pathname, 'https://pixabay.com/api/');
    assert.deepEqual([q.get('key'), q.get('q'), q.get('orientation'), q.get('image_type'), q.get('lang'), q.get('safesearch'), q.get('page')], ['cle-pixabay', 'Mairie', 'vertical', 'photo', 'fr', 'true', '2']);
    assert.equal(r.provider, 'Pixabay');
    assert.deepEqual(r.photos.map((p) => p.id), ['11', '22']);
    assert.deepEqual(r.photos[0], { id: '11', thumb: 'https://pixabay.com/get/w11_640.jpg', width: 3000, height: 4500, alt: 'mairie, bâtiment, ville', photographer: 'Jean_Dupont', page: 'https://pixabay.com/photos/mairie-11/', color: '#888888' });
    assert.equal(r.photos[1].page, 'https://pixabay.com'); // jamais un lien vers un autre site
    assert.equal(r.photos[1].photographer.length, 80);
    assert.equal(r.next, true); // 60 résultats, 2 pages de 24 vues : il en reste
    await stock.searchPhotos('mairie', { fetchImpl, page: 2 });
    assert.equal(calls.length, 1); // cache
    await assert.rejects(stock.searchPhotos('école', { fetchImpl: async () => json({}, 429) }), (e) => e.status === 503);
    await assert.rejects(stock.searchPhotos('mer', { fetchImpl: async () => json({}, 401) }), (e) => e.status === 502 && /Pixabay/.test(e.message));
  } finally {
    delete process.env.PIXABAY_API_KEY;
  }
});

test('Pixabay — image : serveurs Pixabay seulement, redirections vérifiées, fichier propre au fournisseur', async () => {
  process.env.PIXABAY_API_KEY = 'cle-pixabay';
  try {
    const seen = [];
    const fetchImpl = async (url) => {
      const u = new URL(url);
      seen.push(u.href);
      if (u.pathname === '/api/') return json({ hits: [hit(Number(u.searchParams.get('id')))] });
      if (u.pathname.startsWith('/get/')) return new Response(null, { status: 302, headers: { location: `https://cdn.pixabay.com/photo/real${u.pathname.split('/').pop()}` } });
      return jpeg(7000);
    };
    const f = await stock.ensureImage('77', 'full', { fetchImpl });
    assert.ok(f.endsWith('pixabay-77-f.jpg'));
    assert.equal((await fs.stat(f)).size, 7000);
    assert.ok(seen.some((x) => x.includes('/api/?key=cle-pixabay&id=77')));
    assert.ok(seen.includes('https://pixabay.com/get/l77_1280.jpg') && seen.some((x) => x.startsWith('https://cdn.pixabay.com/photo/real')));
    const p = await stock.ensureImage('77', 'preview', { fetchImpl });
    assert.ok(p.endsWith('pixabay-77-p.jpg'));
    // adresse venue de la réponse du fournisseur mais étrangère : refusée
    stock.resetStockState();
    const evil = async (url) => (new URL(url).pathname === '/api/' ? json({ hits: [hit(78, { largeImageURL: 'https://evil.test/a.jpg' })] }) : jpeg());
    await assert.rejects(stock.ensureImage('78', 'full', { fetchImpl: evil }), (e) => e.status === 502);
    // image introuvable
    await assert.rejects(stock.ensureImage('79', 'full', { fetchImpl: async () => json({ hits: [] }) }), (e) => e.status === 404);
  } finally {
    delete process.env.PIXABAY_API_KEY;
  }
});
