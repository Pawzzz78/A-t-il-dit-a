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
  const deps = { iterateUploads: iterate([video(1), video(2, { live: true })], [video(3)]) };
  assert.deepEqual(await sync.discoverChannel(channel, deps), { added: 2, skipped: 0 });
  assert.equal((await row(1)).sync_status, 'pending');
  assert.equal(await row(2), undefined); // direct : repris plus tard
  const again = await sync.discoverChannel({ ...channel, backfilled_at: new Date() }, deps);
  assert.equal(again.added, 0);
});

test('découverte : ne touche pas aux vidéos existantes ni aux exclues', { skip: !enabled }, async () => {
  await db.pool.query(`INSERT INTO videos (youtube_id, title, source) VALUES ($1, 'Titre manuel', 'manual')`, [id(1)]);
  await db.pool.query(`INSERT INTO excluded_videos (youtube_id, reason) VALUES ($1, 'deleted')`, [id(2)]);
  const out = await sync.discoverChannel(channel, { iterateUploads: iterate([video(1), video(2), video(3)]) });
  assert.equal(out.added, 1);
  const manual = await row(1);
  assert.equal(manual.title, 'Titre manuel');
  assert.equal(manual.sync_status, null);
  assert.equal(await row(2), undefined);
});

test('découverte : durée minimale', { skip: !enabled }, async () => {
  const out = await sync.discoverChannel({ ...channel, min_duration_s: 120 }, {
    iterateUploads: iterate([video(1, { duration_s: 30 }), video(2)]),
  });
  assert.deepEqual(out, { added: 1, skipped: 1 });
  const { rows } = await db.pool.query('SELECT reason FROM excluded_videos WHERE youtube_id = $1', [id(1)]);
  assert.equal(rows[0].reason, 'too_short');
});

test('traitement : pose la transcription d\'une vidéo en attente', { skip: !enabled }, async () => {
  await sync.discoverChannel(channel, { iterateUploads: iterate([video(1)]) });
  const res = await sync.processPending({ limit: 10, fetchFn: async () => fakeSegments('bonjour à tous'), gapMs: 0 });
  assert.equal(res.done, 1);
  const v = await row(1);
  assert.equal(v.sync_status, 'done');
  assert.equal(v.norm_text, 'bonjour a tous');
  assert.equal(v.edited, false);
});

test('traitement : JAMAIS de modification d\'une vidéo déjà transcrite ou éditée', { skip: !enabled }, async () => {
  await sync.discoverChannel(channel, { iterateUploads: iterate([video(1), video(2), video(3)]) });
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
  await sync.discoverChannel(channel, { iterateUploads: iterate([video(1), video(2, { published_at: OLD })]) });
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
  await sync.discoverChannel(channel, { iterateUploads: iterate([video(1), video(2)]) });
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
  const deps = { iterateUploads: iterate([video(1)]), fetchFn: async () => fakeSegments('salut'), gapMs: 0 };
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
