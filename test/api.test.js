// Test d'intégration : nécessite une base Postgres (DATABASE_URL), sinon ignoré.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const enabled = Boolean(process.env.DATABASE_URL);
const YT = 'TESTtest_01';

let server;
let base;
let cookie = '';
let pool;

const call = async (method, path, body, headers = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
};

before(async () => {
  if (!enabled) return;
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  server.close();
  await pool.end();
});

test('admin protégée, connexion, ajout, recherche, correction', { skip: !enabled }, async () => {
  assert.equal((await call('GET', '/api/admin/videos')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'pw-test' })).status, 200);

  const bad = await call('POST', '/api/admin/videos', { input: 'pas une url', mode: 'empty' });
  assert.equal(bad.status, 400);

  // Une requête venant d'un autre site est refusée même avec le cookie.
  const csrf = await call('POST', '/api/admin/videos', { input: YT, mode: 'empty' }, { Origin: 'https://evil.example' });
  assert.equal(csrf.status, 403);

  const created = await call('POST', '/api/admin/videos', {
    input: `https://youtu.be/${YT}`,
    mode: 'paste',
    title: 'Vidéo de test',
    published_at: '2025-01-02',
    transcript: '[00:01] nous devons simplifier\n[00:05] la vie des entrepreneurs français',
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await call('POST', '/api/admin/videos', { input: YT, mode: 'empty' })).status, 409);

  let r = await call('GET', '/api/search?q=' + encodeURIComponent('Simplifier la vie des entrepreneurs'));
  assert.equal(r.body.verdict, 'exact');
  const hit = r.body.results.find((x) => x.video.youtube_id === YT);
  assert.equal(hit.video.published_at, '2025-01-02');
  assert.equal(hit.matches[0].start_ms, 1000);
  assert.match(hit.matches[0].url, /t=1s$/);

  r = await call('GET', '/api/search?q=' + encodeURIComponent('entrepreneurs francais simplifier'));
  assert.ok(['exact', 'approx'].includes(r.body.verdict));

  // Correction manuelle : l'ancienne formulation disparaît, la nouvelle apparaît.
  const saved = await call('PUT', `/api/admin/videos/${id}/segments`, {
    segments: [
      { start_ms: 1000, text: 'nous devons alléger' },
      { start_ms: 5000, text: 'la vie des entrepreneurs français' },
    ],
  });
  assert.equal(saved.status, 200);
  r = await call('GET', '/api/search?q=' + encodeURIComponent('nous devons simplifier'));
  assert.ok(!r.body.results.some((x) => x.video.youtube_id === YT && x.matches.some((m) => m.type === 'exact')));
  r = await call('GET', '/api/search?q=' + encodeURIComponent('nous devons alléger la vie'));
  assert.equal(r.body.verdict, 'exact');

  const detail = await call('GET', `/api/admin/videos/${id}`);
  assert.equal(detail.body.video.edited, true);
  assert.equal(detail.body.segments.length, 2);

  assert.equal((await call('DELETE', `/api/admin/videos/${id}`)).status, 200);
  assert.equal((await call('GET', `/api/admin/videos/${id}`)).status, 404);
});

test('recherche : requête trop courte refusée', { skip: !enabled }, async () => {
  assert.equal((await call('GET', '/api/search?q=ab')).status, 400);
});
