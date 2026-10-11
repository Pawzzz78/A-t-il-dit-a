// Tests de la synchronisation (nécessite Postgres via DATABASE_URL, sinon ignorés).
// YouTube et Supadata sont remplacés par des faux : aucun appel réseau.
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

const enabled = Boolean(process.env.DATABASE_URL);
const P = 'SYNCtest_'; // + 2 caractères = 11
const id = (n) => `${P}${String(n).padStart(2, '0')}`;
const RECENT = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const OLD = '2020-01-01';

let db;
let sync;
let T;
let channel;

const video = (n, extra = {}) => ({
  youtube_id: id(n), title: `Vidéo ${n}`, channel: 'Chaîne test', channel_id: 'UCtest', published_at: RECENT,
  thumbnail_url: null, duration_s: 600, live: false, ...extra,
});
const pages = (...list) => async function* () { for (const details of list) yield { details }; };
const iterate = (...list) => () => pages(...list)();
const noShorts = async () => ({ ids: new Set(), found: true });
const withShorts = (...ids) => async () => ({ ids: new Set(ids), found: true });

const row = async (n) => (await db.pool.query('SELECT * FROM videos WHERE youtube_id = $1', [id(n)])).rows[0];
const segCount = async (n) => (await db.pool.query('SELECT count(*)::int AS c FROM segments s JOIN videos v ON v.id = s.video_id WHERE v.youtube_id = $1', [id(n)])).rows[0].c;
const fakeSegments = (text) => ({ segments: [{ start_ms: 0, duration_ms: 1000, text }], lang: 'fr' });

before(async () => {
  if (!enabled) return;
  db = await import('../src/db.js');
  sync = await import('../src/sync.js');
  T = await import('../src/transcripts.js');
  await db.initDb();
});

beforeEach(async () => {
  if (!enabled) return;
  await db.pool.query(`DELETE FROM videos WHERE youtube_id LIKE '${P}%'`);
  await db.pool.query(`DELETE FROM excluded_videos WHERE youtube_id LIKE '${P}%'`);
  await db.pool.query(`DELETE FROM channels WHERE youtube_channel_id = 'UCtest'`);
  ({ rows: [channel] } = await db.pool.query(
    `INSERT INTO channels (youtube_channel_id, title, uploads_playlist_id) VALUES ('UCtest', 'Chaîne test', 'UUtest') RETURNING *`,
  ));
});

after(async () => {
  if (!enabled) return;
  await db.pool.query(`DELETE FROM videos WHERE youtube_id LIKE '${P}%'`);
  await db.pool.query(`DELETE FROM excluded_videos WHERE youtube_id LIKE '${P}%'`);
  await db.pool.query(`DELETE FROM channels WHERE youtube_channel_id = 'UCtest'`);
  await db.pool.query(`DELETE FROM settings WHERE key IN ('processing_paused', 'cooldown_until', 'last_error')`);
  await db.pool.end();
});

test('découverte : met en file, ignore les directs, idempotente', { skip: !enabled }, async () => {
  const deps = { listShortIds: noShorts, iterateUploads: iterate([video(1), video(2, { live: true })], [video(3)]) };
  assert.deepEqual(await sync.discoverChannel(channel, deps), { added: 2, skipped: 0 });
  assert.equal((await row(1)).sync_status, 'pending');
  assert.equal(await row(2), undefined); // direct : repris plus tard
  const again = await sync.discoverChannel({ ...channel, backfilled_at: new Date() }, deps);
  assert.equal(again.added, 0);
});

test('découverte : ne touche pas aux vidéos existantes ni aux exclues', { skip: !enabled }, async () => {
  await db.pool.query(`INSERT INTO videos (youtube_id, title, source) VALUES ($1, 'Titre manuel', 'manual')`, [id(1)]);
  await db.pool.query(`INSERT INTO excluded_videos (youtube_id, reason) VALUES ($1, 'deleted')`, [id(2)]);
  const out = await sync.discoverChannel(channel, { listShortIds: noShorts, iterateUploads: iterate([video(1), video(2), video(3)]) });
  assert.equal(out.added, 1);
  const manual = await row(1);
  assert.equal(manual.title, 'Titre manuel');
  assert.equal(manual.sync_status, null);
  assert.equal(await row(2), undefined);
});

test('découverte : durée minimale', { skip: !enabled }, async () => {
  const out = await sync.discoverChannel({ ...channel, min_duration_s: 120, exclude_shorts: false }, {
    listShortIds: noShorts,
    iterateUploads: iterate([video(1, { duration_s: 30 }), video(2)]),
  });
  assert.deepEqual(out, { added: 1, skipped: 1 });
  const { rows } = await db.pool.query('SELECT reason FROM excluded_videos WHERE youtube_id = $1', [id(1)]);
  assert.equal(rows[0].reason, 'too_short');
});

test('traitement : pose la transcription d\'une vidéo en attente', { skip: !enabled }, async () => {
  await sync.discoverChannel(channel, { listShortIds: noShorts, iterateUploads: iterate([video(1)]) });
  const res = await sync.processPending({ limit: 10, fetchFn: async () => fakeSegments('bonjour à tous'), gapMs: 0 });
  assert.equal(res.done, 1);
  const v = await row(1);
  assert.equal(v.sync_status, 'done');
  assert.equal(v.norm_text, 'bonjour a tous');
  assert.equal(v.edited, false);
});

test('traitement : JAMAIS de modification d\'une vidéo déjà transcrite ou éditée', { skip: !enabled }, async () => {
  await sync.discoverChannel(channel, { listShortIds: noShorts, iterateUploads: iterate([video(1), video(2), video(3)]) });
  // 1 : l'admin la corrige pendant que la synchro est en route ; 2 : transcrite à la main ; 3 : normale.
  const fetchFn = async (ytId) => {
    if (ytId === id(1)) {
      const v = await row(1);
      await db.withTransaction((c) => db.replaceSegments(c, v.id, [{ start_ms: 0, text: 'texte corrigé à la main' }], { edited: true }));
    }
    return fakeSegments('texte automatique');
  };
  const v2 = await row(2);
  await db.withTransaction((c) => db.replaceSegments(c, v2.id, [{ start_ms: 0, text: 'import manuel' }], { edited: true, source: 'manual' }));

  const res = await sync.processPending({ limit: 10, fetchFn, gapMs: 0 });
  assert.equal(res.done, 1);
  assert.equal((await row(1)).norm_text, 'texte corrige a la main');
  assert.equal((await row(2)).norm_text, 'import manuel');
  assert.equal((await row(3)).norm_text, 'texte automatique');

  // Un second passage ne retouche rien : plus rien n'est en attente.
  let calls = 0;
  await sync.processPending({ limit: 10, fetchFn: async () => (calls++, fakeSegments('autre')), gapMs: 0 });
  assert.equal(calls, 0);
  assert.equal((await row(3)).norm_text, 'texte automatique');
});

test('traitement : une vidéo ajoutée à la main (sans statut) n\'est jamais retraitée', { skip: !enabled }, async () => {
  await db.pool.query(`INSERT INTO videos (youtube_id, title, source) VALUES ($1, 'Manuelle', 'manual')`, [id(1)]);
  let calls = 0;
  await sync.processPending({ limit: 10, fetchFn: async () => (calls++, fakeSegments('x')), gapMs: 0 });
  assert.equal(calls, 0);
});

test('traitement : sous-titres absents → nouvel essai pour une vidéo récente, abandon pour une ancienne', { skip: !enabled }, async () => {
  await sync.discoverChannel(channel, { listShortIds: noShorts, iterateUploads: iterate([video(1), video(2, { published_at: OLD })]) });
  const unavailable = async () => { throw new T.TranscriptError('pas de sous-titres', 404, 'unavailable'); };
  const res = await sync.processPending({ limit: 10, fetchFn: unavailable, gapMs: 0 });
  assert.deepEqual([res.retry, res.failed], [1, 1]);
  const recent = await row(1);
  assert.equal(recent.sync_status, 'pending');
  assert.equal(recent.sync_attempts, 1);
  assert.ok(new Date(recent.sync_next_at) > new Date());
  assert.equal((await row(2)).sync_status, 'failed');
  // la vidéo en échec peut être relancée
  const { rowCount } = await db.pool.query(`UPDATE videos SET sync_status = 'pending', sync_next_at = now() WHERE youtube_id = $1`, [id(2)]);
  assert.equal(rowCount, 1);
});

test('traitement : quota épuisé → arrêt sans toucher au reste de la file', { skip: !enabled }, async () => {
  await sync.discoverChannel(channel, { listShortIds: noShorts, iterateUploads: iterate([video(1), video(2)]) });
  let calls = 0;
  const quota = async () => { calls++; throw new T.TranscriptError('plus de crédits', 429, 'quota'); };
  const res = await sync.processPending({ limit: 10, fetchFn: quota, gapMs: 0 });
  assert.equal(calls, 1);
  assert.equal(res.stopped.code, 'quota');
  assert.equal((await row(1)).sync_status, 'pending');
  assert.equal((await row(1)).sync_attempts, 0);
});

test('cycle : en pause par défaut, traite après « reprendre »', { skip: !enabled }, async () => {
  await db.pool.query(`DELETE FROM settings WHERE key IN ('processing_paused', 'cooldown_until')`);
  const deps = { listShortIds: noShorts, iterateUploads: iterate([video(1)]), fetchFn: async () => fakeSegments('salut'), gapMs: 0 };
  assert.equal(await sync.isPaused(), true);
  let out = await sync.runCycle(deps);
  assert.equal(out.discovered, 1);
  assert.equal(out.processing, undefined);
  assert.equal((await row(1)).sync_status, 'pending');

  await sync.setSetting('processing_paused', false);
  out = await sync.runCycle(deps);
  assert.equal(out.processing.done, 1);
  assert.equal((await row(1)).sync_status, 'done');
});

test('traduction : stockée avec le texte d\'origine, et signalée dans la recherche', { skip: !enabled }, async () => {
  const { createApp } = await import('../src/server.js');
  await sync.discoverChannel(channel, { listShortIds: noShorts, iterateUploads: iterate([video(1), video(2)]) });
  const fetchFn = async (ytId) => ({
    lang: 'fr',
    translated: ytId === id(1),
    originalLang: ytId === id(1) ? 'en' : null,
    segments: [{ start_ms: 0, duration_ms: 1000, text: 'nous devons réduire la dépense publique', text_original: ytId === id(1) ? 'we must cut public spending' : null }],
  });
  const res = await sync.processPending({ limit: 10, fetchFn, gapMs: 0 });
  assert.equal(res.done, 2);

  const v1 = await row(1);
  assert.deepEqual([v1.translated, v1.original_lang, v1.lang], [true, 'en', 'fr']);
  const { rows } = await db.pool.query('SELECT text_original FROM segments WHERE video_id = $1', [v1.id]);
  assert.equal(rows[0].text_original, 'we must cut public spending');
  const v2 = await row(2);
  assert.deepEqual([v2.translated, v2.original_lang], [false, null]);

  const server = createApp().listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const q = encodeURIComponent('réduire la dépense publique');
    // Les deux vidéos contiennent la phrase : la vidéo non traduite fait foi.
    let r = await (await fetch(`${base}/api/search?q=${q}`)).json();
    assert.equal(r.verdict, 'exact');
    const byId = Object.fromEntries(r.results.map((x) => [x.video.youtube_id, x.video]));
    assert.equal(byId[id(1)].translated, true);
    assert.equal(byId[id(2)].translated, false);
    // Si la phrase n'existe que dans la traduction, le verdict l'indique.
    await db.pool.query('DELETE FROM videos WHERE youtube_id = $1', [id(2)]);
    r = await (await fetch(`${base}/api/search?q=${q}`)).json();
    assert.equal(r.verdict, 'translated');
  } finally {
    server.close();
  }
});

// --- Shorts ---------------------------------------------------------------------------

test('découverte : les Shorts sont exclus (durée ≤ 60 s ou liste des Shorts YouTube) et mémorisés', { skip: !enabled }, async () => {
  const deps = {
    listShortIds: withShorts(id(2)), // 150 s, mais présent dans la liste des Shorts
    iterateUploads: iterate([video(1, { duration_s: 30 }), video(2, { duration_s: 150 }), video(3, { duration_s: 900 })]),
  };
  assert.deepEqual(await sync.discoverChannel(channel, deps), { added: 1, skipped: 2 });
  assert.equal(await row(1), undefined);
  assert.equal(await row(2), undefined);
  assert.equal((await row(3)).sync_status, 'pending');
  const { rows } = await db.pool.query(`SELECT youtube_id, reason FROM excluded_videos WHERE youtube_id LIKE '${P}%' ORDER BY 1`);
  assert.deepEqual(rows.map((r) => r.reason), ['short', 'short']);
});

test('découverte : Shorts inclus si la chaîne le demande, et jamais d\'appel à la liste si la durée suffit', { skip: !enabled }, async () => {
  const off = await sync.discoverChannel({ ...channel, exclude_shorts: false }, {
    listShortIds: async () => { throw new Error('ne doit pas être appelé'); },
    iterateUploads: iterate([video(1, { duration_s: 30 })]),
  });
  assert.equal(off.added, 1);
  let calls = 0;
  await sync.discoverChannel(channel, { listShortIds: async () => (calls++, { ids: new Set(), found: true }), iterateUploads: iterate([video(2, { duration_s: 20 })]) });
  assert.equal(calls, 0);
});

test('découverte : liste des Shorts indisponible → la découverte échoue (rien n\'est ajouté à tort)', { skip: !enabled }, async () => {
  await assert.rejects(
    sync.discoverChannel(channel, { listShortIds: async () => { throw new Error('API YouTube : quota'); }, iterateUploads: iterate([video(1, { duration_s: 900 })]) }),
    /quota/,
  );
  assert.equal(await row(1), undefined);
});

test('traitement : un Short déjà en file est retiré sans dépenser de crédit', { skip: !enabled }, async () => {
  await sync.discoverChannel({ ...channel, exclude_shorts: false }, { listShortIds: noShorts, iterateUploads: iterate([video(1, { duration_s: 30 }), video(2, { duration_s: 900 })]) });
  const fetched = [];
  const res = await sync.processPending({ limit: 10, fetchFn: async (ytId) => (fetched.push(ytId), fakeSegments('texte')), gapMs: 0 });
  assert.deepEqual(fetched, [id(2)]);
  assert.equal(res.removed, 1);
  assert.equal(await row(1), undefined);
  const { rows } = await db.pool.query(`SELECT reason FROM excluded_videos WHERE youtube_id = $1`, [id(1)]);
  assert.equal(rows[0].reason, 'short');
});

const seedForPurge = async () => {
  await sync.discoverChannel({ ...channel, exclude_shorts: false }, {
    listShortIds: noShorts,
    iterateUploads: iterate([
      video(1, { duration_s: 30 }), // Short, déjà transcrit
      video(2, { duration_s: 45 }), // Short, en attente
      video(3, { duration_s: 900 }), // vidéo longue
      video(4, { duration_s: 150 }), // Short « long » (3 min max), connu de YouTube
      video(5, { duration_s: 20 }), // Short corrigé à la main
    ]),
  });
  const done = (n, text, extra = {}) => db.pool.query('SELECT id FROM videos WHERE youtube_id = $1', [id(n)]).then(async ({ rows }) => {
    await db.withTransaction((c) => db.replaceSegments(c, rows[0].id, [{ start_ms: 0, text }], extra));
    return rows[0].id;
  });
  const shortId = await done(1, 'un short');
  await db.pool.query(`INSERT INTO video_summaries (video_id, content, model, source_hash) VALUES ($1, 'résumé', 'm', 'h')`, [shortId]);
  await done(3, 'une longue vidéo');
  await done(5, 'corrigé à la main', { edited: true });
  // vidéo ajoutée à la main : même courte, elle ne doit jamais être touchée
  await db.pool.query(`INSERT INTO videos (youtube_id, title, source, channel_id, duration_s) VALUES ($1, 'Ajoutée à la main', 'manual', 'UCtest', 25)`, [id(6)]);
};

test('Shorts : aperçu (rien n\'est supprimé) puis nettoyage', { skip: !enabled }, async () => {
  await seedForPurge();
  const deps = { listShortIds: withShorts(id(4)) };

  const preview = await sync.previewShorts(channel, deps);
  assert.deepEqual(
    [preview.detection, preview.total, preview.with_transcript, preview.pending, preview.protected],
    ['playlist', 3, 1, 2, 1], // 1, 2, 4 supprimables ; 5 protégé (corrigé à la main)
  );
  assert.equal(preview.examples.length, 3);
  assert.ok(await row(1) && await row(2) && await row(4)); // l'aperçu ne supprime rien

  const res = await sync.purgeShorts(channel, deps);
  assert.deepEqual([res.removed, res.protected], [3, 1]);
  for (const n of [1, 2, 4]) assert.equal(await row(n), undefined, `vidéo ${n} supprimée`);
  for (const n of [3, 5, 6]) assert.ok(await row(n), `vidéo ${n} conservée`); // longue, corrigée à la main, ajoutée à la main
  assert.equal((await row(6)).sync_status, null);

  // transcription et résumé du Short supprimés avec lui ; mémorisé pour ne jamais revenir
  const { rows: orphan } = await db.pool.query(`SELECT 1 FROM video_summaries vs LEFT JOIN videos v ON v.id = vs.video_id WHERE v.id IS NULL`);
  assert.equal(orphan.length, 0);
  const { rows: tomb } = await db.pool.query(`SELECT count(*)::int AS n FROM excluded_videos WHERE youtube_id = ANY($1) AND reason = 'short'`, [[id(1), id(2), id(4)]]);
  assert.equal(tomb[0].n, 3);
  const { rows: ch } = await db.pool.query('SELECT exclude_shorts FROM channels WHERE id = $1', [channel.id]);
  assert.equal(ch[0].exclude_shorts, true);

  // la synchro suivante ne les ramène pas
  const again = await sync.discoverChannel({ ...channel, backfilled_at: new Date() }, {
    listShortIds: withShorts(id(4)),
    iterateUploads: iterate([video(1, { duration_s: 30 }), video(2, { duration_s: 45 }), video(4, { duration_s: 150 })]),
  });
  assert.equal(again.added, 0);
});

test('Shorts : sans liste YouTube, détection par la durée seule (et on le signale)', { skip: !enabled }, async () => {
  await seedForPurge();
  const preview = await sync.previewShorts(channel, { listShortIds: async () => ({ ids: new Set(), found: false }) });
  assert.equal(preview.detection, 'duration');
  assert.equal(preview.total, 2); // 1 et 2 ; la vidéo 4 (150 s) n'est pas détectée
  const noKey = await sync.previewShorts(channel, { listShortIds: async () => { throw new Error('YOUTUBE_API_KEY manquante'); } });
  assert.equal(noKey.detection, 'duration');
});

test('Shorts : l\'API exige une confirmation avant de supprimer', { skip: !enabled }, async () => {
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  const { createApp } = await import('../src/server.js');
  await seedForPurge();
  const server = createApp().listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw-test' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = (path, body) => fetch(`${base}/api/admin/sync/channels/${channel.id}/shorts/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
    const noAuth = await fetch(`${base}/api/admin/sync/channels/${channel.id}/shorts/preview`, { method: 'POST' });
    assert.equal(noAuth.status, 401);
    const preview = await (await call('preview', {})).json();
    assert.equal(preview.total, 2); // sans clé YouTube : durée seule
    assert.equal((await call('purge', {})).status, 400);
    assert.equal((await call('purge', { confirm: 'oui' })).status, 400);
    assert.ok(await row(1));
    const done = await (await call('purge', { confirm: true })).json();
    assert.equal(done.removed, 2);
    assert.equal(await row(1), undefined);
  } finally {
    server.close();
  }
});

test('Shorts : le nettoyage applique aussi la durée minimale de la chaîne (Shorts de 1 à 3 min non listés)', { skip: !enabled }, async () => {
  await sync.discoverChannel({ ...channel, exclude_shorts: false }, {
    listShortIds: noShorts,
    iterateUploads: iterate([video(1, { duration_s: 90 }), video(2, { duration_s: 170 }), video(3, { duration_s: 900 })]),
  });
  const none = await sync.previewShorts(channel, { listShortIds: noShorts });
  assert.equal(none.total, 0); // 90 s et 170 s ne sont ni ≤ 60 s ni dans la liste YouTube
  const withMin = await sync.previewShorts({ ...channel, min_duration_s: 181 }, { listShortIds: noShorts });
  assert.equal(withMin.total, 2);
  const res = await sync.purgeShorts({ ...channel, min_duration_s: 181 }, { listShortIds: noShorts });
  assert.equal(res.removed, 2);
  assert.ok(await row(3));
  assert.equal(await row(1), undefined);
});
