// Résumés et « Dernières vidéos » (nécessite Postgres via DATABASE_URL, sinon ignorés).
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

const enabled = Boolean(process.env.DATABASE_URL);
const P = 'SUMtest_';
const id = (n) => `${P}${String(n).padStart(3, '0')}`;
let db;
let svc;

const REPLY = '## En bref\nLe résumé de la vidéo, en deux phrases courtes et fidèles au texte.\n## [00:00] Début\n- Un **point** clé.';
const counting = (reply = REPLY, delay = 0) => {
  const f = async () => {
    f.calls += 1;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return reply;
  };
  f.calls = 0;
  return f;
};
const addVideo = async (n, { published = null, texts = ['bonjour à tous', 'merci'], source = 'manual', translated = false, duration = null } = {}) => {
  const { rows } = await db.pool.query(
    `INSERT INTO videos (youtube_id, title, channel, published_at, source, lang, translated, duration_s) VALUES ($1, $2, 'Chaîne', $3, $4, 'fr', $5, $6) RETURNING id`,
    [id(n), `Vidéo ${n}`, published, source, translated, duration],
  );
  if (texts) await db.withTransaction((c) => db.replaceSegments(c, rows[0].id, texts.map((text, i) => ({ start_ms: i * 60000, text }))));
  return rows[0].id;
};
const err = async (p) => p.then(() => null, (e) => e);

before(async () => {
  if (!enabled) return;
  db = await import('../src/db.js');
  svc = await import('../src/summaries.js');
  await db.initDb();
});
beforeEach(async () => {
  if (!enabled) return;
  svc.resetSummaryState();
  await db.pool.query(`DELETE FROM videos WHERE youtube_id LIKE '${P}%'`);
});
after(async () => {
  if (!enabled) return;
  await db.pool.query(`DELETE FROM videos WHERE youtube_id LIKE '${P}%'`);
  await db.pool.end();
});

test('résumé : généré une fois, puis servi depuis la base sans appel au modèle', { skip: !enabled }, async () => {
  await addVideo(1);
  const complete = counting();
  const a = await svc.getSummary(id(1), { ip: 'a', complete });
  assert.equal(a.cached, false);
  assert.match(a.markdown, /^## En bref/);
  const b = await svc.getSummary(id(1), { ip: 'b', complete });
  assert.equal(b.cached, true);
  assert.equal(b.markdown, a.markdown);
  assert.equal(complete.calls, 1);
});

test('résumé : régénéré seulement si la transcription a changé', { skip: !enabled }, async () => {
  const vid = await addVideo(1);
  const complete = counting();
  await svc.getSummary(id(1), { complete });
  await db.withTransaction((c) => db.replaceSegments(c, vid, [{ start_ms: 0, text: 'texte corrigé à la main' }], { edited: true }));
  const again = await svc.getSummary(id(1), { complete });
  assert.equal(again.cached, false);
  assert.equal(complete.calls, 2);
  assert.equal((await svc.getSummary(id(1), { complete })).cached, true);
});

test('résumé : des clics simultanés ne font qu\'un seul appel au modèle', { skip: !enabled }, async () => {
  await addVideo(1);
  const complete = counting(REPLY, 80);
  const results = await Promise.all([1, 2, 3, 4].map((n) => svc.getSummary(id(1), { ip: `ip${n}`, complete })));
  assert.equal(complete.calls, 1);
  assert.equal(new Set(results.map((r) => r.markdown)).size, 1);
});

test('résumé : erreurs claires (inconnue, sans transcription, plafonds, modèle en panne)', { skip: !enabled }, async () => {
  await addVideo(1);
  await addVideo(2, { texts: null });
  const complete = counting();
  assert.equal((await err(svc.getSummary(id(9), { complete }))).status, 404);
  assert.equal((await err(svc.getSummary(id(2), { complete }))).status, 409);
  assert.equal(complete.calls, 0);

  // modèle en panne → 502 sans détail technique, rien n'est stocké
  const down = async () => { throw new (await import('../src/openrouter.js')).LlmError('boom secret'); };
  const e = await err(svc.getSummary(id(1), { complete: down }));
  assert.equal(e.status, 502);
  assert.doesNotMatch(e.message, /boom|secret/);
  const { rows } = await db.pool.query('SELECT 1 FROM video_summaries vs JOIN videos v ON v.id = vs.video_id WHERE v.youtube_id = $1', [id(1)]);
  assert.equal(rows.length, 0);

  // plafond par visiteur ; les résumés déjà en base restent servis
  process.env.SUMMARY_PER_IP_HOURLY = '1';
  try {
    svc.resetSummaryState();
    await addVideo(3);
    await svc.getSummary(id(1), { ip: 'x', complete });
    const blocked = await err(svc.getSummary(id(3), { ip: 'x', complete }));
    assert.equal(blocked.status, 429);
    assert.equal((await svc.getSummary(id(1), { ip: 'x', complete })).cached, true);
  } finally {
    delete process.env.SUMMARY_PER_IP_HOURLY;
  }
});

test('résumé : sans clé OpenRouter → 503 (mais un résumé déjà stocké reste lisible)', { skip: !enabled }, async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    await addVideo(1);
    assert.equal((await err(svc.getSummary(id(1)))).status, 503);
    await svc.getSummary(id(1), { complete: counting() });
    assert.equal((await svc.getSummary(id(1))).cached, true);
  } finally {
    if (saved) process.env.OPENROUTER_API_KEY = saved;
  }
});

test('API : /latest mêle vidéos de chaînes et ajouts manuels, triées par date, avec transcription', { skip: !enabled }, async () => {
  // dates dans le futur lointain pour passer devant les données éventuelles de la base
  await addVideo(1, { published: '2099-03-01', source: 'manual' });
  await addVideo(2, { published: '2099-05-01', source: 'supadata' });
  await addVideo(3, { published: '2099-04-01', source: 'manual' });
  await addVideo(4, { published: '2099-06-01', texts: null }); // sans transcription : absente
  await addVideo(5, { published: null });
  await addVideo(6, { published: '2099-07-01', duration: 45 }); // un Short qui aurait échappé au nettoyage : jamais sur l'accueil
  await addVideo(7, { published: '2099-02-01', duration: 1800 });
  const { createApp } = await import('../src/server.js');
  const server = createApp().listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await (await fetch(`${base}/api/latest?limit=3`)).json();
    assert.deepEqual(r.videos.map((v) => v.youtube_id), [id(2), id(3), id(1)]);
    assert.ok(!(await (await fetch(`${base}/api/latest?limit=12`)).json()).videos.some((v) => v.youtube_id === id(6)));
    assert.equal(r.videos[0].published_at, '2099-05-01');
    assert.equal(typeof r.summaries_enabled, 'boolean');
    const five = await (await fetch(`${base}/api/latest`)).json();
    assert.equal(five.videos.length, 5);

    // résumé : GET refusé, POST valide, id invalide
    assert.equal((await fetch(`${base}/api/summary/${id(1)}`)).status, 404);
    assert.equal((await fetch(`${base}/api/summary/pas-un-id`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/api/summary/${id(4)}`, { method: 'POST' })).status, 409);
    const cached = await svc.getSummary(id(1), { complete: counting() });
    const ok = await fetch(`${base}/api/summary/${id(1)}`, { method: 'POST' });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.markdown, cached.markdown);
    assert.equal(body.cached, true);
  } finally {
    server.close();
  }
});

test('YouTube : fetchVideoMeta lit titre, chaîne, date et durée', async () => {
  const { fetchVideoMeta } = await import('../src/youtube.js');
  const realFetch = globalThis.fetch;
  const savedKey = process.env.YOUTUBE_API_KEY;
  process.env.YOUTUBE_API_KEY = 'test-key';
  let seenUrl;
  globalThis.fetch = async (url) => {
    seenUrl = String(url);
    return { ok: true, status: 200, json: async () => ({ items: [{ id: 'abcdefghijk', snippet: { title: 'Un titre', channelTitle: 'Une chaîne', channelId: 'UC1', publishedAt: '2026-10-09T12:34:56Z', liveBroadcastContent: 'none', thumbnails: { high: { url: 'https://img/x.jpg' } } }, contentDetails: { duration: 'PT1H2M3S' } }] }) };
  };
  try {
    const m = await fetchVideoMeta('abcdefghijk');
    assert.match(seenUrl, /youtube\/v3\/videos\?.*id=abcdefghijk/);
    assert.deepEqual(
      [m.title, m.channel, m.published_at, m.duration_s, m.thumbnail_url, m.channel_id],
      ['Un titre', 'Une chaîne', '2026-10-09', 3723, 'https://img/x.jpg', 'UC1'],
    );
    delete process.env.YOUTUBE_API_KEY;
    assert.equal(await fetchVideoMeta('abcdefghijk'), null); // sans clé : pas d'appel
  } finally {
    globalThis.fetch = realFetch;
    if (savedKey) process.env.YOUTUBE_API_KEY = savedKey;
    else delete process.env.YOUTUBE_API_KEY;
  }
});
