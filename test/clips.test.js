// Studio de clips, côté admin : dépôt du fichier vidéo par morceaux, interrupteur, suppression
// (nécessite Postgres via DATABASE_URL et ffmpeg, sinon ignorés).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

let hasFfmpeg = true;
try {
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const enabled = Boolean(process.env.DATABASE_URL) && hasFfmpeg;
const YT = 'CLPtest_001';
const YT2 = 'CLPtest_002';

let pool;
let server;
let base;
let dir;
let sample; // octets d'une vraie petite vidéo (3 s, 320x240, avec son)
let cookie = '';
let media;

const call = async (method, p, body, headers = {}) => {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
};
const chunk = (id, offset, buf, total) =>
  fetch(`${base}/api/admin/videos/${id}/file/chunk?offset=${offset}&total=${total}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream', Cookie: cookie },
    body: buf,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/** Dépose `bytes` en morceaux de `step` octets, puis termine. */
async function upload(id, bytes, step) {
  const start = await call('POST', `/api/admin/videos/${id}/file/start`, { size: bytes.length });
  assert.equal(start.status, 200);
  for (let off = 0; off < bytes.length; off += step) {
    const r = await chunk(id, off, bytes.subarray(off, off + step), bytes.length);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return call('POST', `/api/admin/videos/${id}/file/finish`, { size: bytes.length });
}

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clips-test-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  delete process.env.OPENROUTER_API_KEY; // aucun appel réel au modèle
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'sample.mp4')]);
  sample = await fs.readFile(path.join(dir, 'sample.mp4'));
  media = await import('../src/media.js');
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM videos WHERE youtube_id = ANY($1)', [[YT, YT2]]);
  for (const [yt, dur] of [[YT, 3], [YT2, 100]]) {
    const { rows } = await pool.query(`INSERT INTO videos (youtube_id, title, source, lang, duration_s) VALUES ($1, 'Vidéo test', 'manual', 'fr', $2) RETURNING id`, [yt, dur]);
    await db.withTransaction((c) => db.replaceSegments(c, rows[0].id, [{ start_ms: 0, text: 'bonjour à tous' }, { start_ms: 1000, text: 'merci' }]));
  }
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await call('POST', '/api/admin/login', { password: 'pw-test' })).status, 200);
});

after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM videos WHERE youtube_id = ANY($1)', [[YT, YT2]]);
  server.close();
  await pool.end();
  await fs.rm(dir, { recursive: true, force: true });
});

const idOf = async (yt) => (await pool.query('SELECT id FROM videos WHERE youtube_id = $1', [yt])).rows[0].id;

test('studio : la session admin est exigée, comme l\'origine des requêtes', { skip: !enabled }, async () => {
  const id = await idOf(YT);
  const saved = cookie;
  cookie = '';
  assert.equal((await call('GET', `/api/admin/videos/${id}/clips`)).status, 401);
  assert.equal((await call('POST', `/api/admin/videos/${id}/file/start`, { size: 10 })).status, 401);
  cookie = saved;
  assert.equal((await call('POST', `/api/admin/videos/${id}/file/start`, { size: 10 }, { Origin: 'https://evil.example' })).status, 403);
});

test('dépôt par morceaux : validé avec ffprobe, durée comparée à YouTube, lecture partielle, remplacement', { skip: !enabled }, async () => {
  const id = await idOf(YT);
  const empty = await call('GET', `/api/admin/videos/${id}/clips`);
  assert.deepEqual([empty.body.file, empty.body.enabled, empty.body.ffmpeg], [null, false, true]);

  const done = await upload(id, sample, 7000); // plusieurs morceaux
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const f = done.body.file;
  assert.deepEqual([f.name, f.size, f.width, f.height, f.has_audio, f.duration_mismatch], [`${YT}.mp4`, sample.length, 320, 240, true, false]);
  assert.ok(Math.abs(f.duration_s - 3) < 0.5);
  assert.equal((await fs.stat(path.join(process.env.STORAGE_DIR, 'videos', `${YT}.mp4`))).size, sample.length);
  await assert.rejects(fs.stat(path.join(process.env.STORAGE_DIR, 'uploads', `${YT}.part`))); // le dépôt temporaire a disparu

  // aperçu de l'admin : lecture partielle (Range) pour pouvoir avancer dans la vidéo
  const part = await fetch(`${base}/api/admin/videos/${id}/file`, { headers: { Range: 'bytes=0-99', Cookie: cookie } });
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.match(part.headers.get('cache-control'), /no-store/);
  const noCookie = await fetch(`${base}/api/admin/videos/${id}/file`);
  assert.equal(noCookie.status, 401); // jamais exposé au public

  // la durée du fichier (3 s) ne correspond pas à celle de la vidéo YouTube (100 s) : avertissement
  const id2 = await idOf(YT2);
  const other = await upload(id2, sample, 100_000);
  assert.equal(other.body.file.duration_mismatch, true);
  assert.equal(other.body.file.youtube_duration_s, 100);

  // un nouveau dépôt remplace l'ancien
  const again = await upload(id, sample, 100_000);
  assert.equal(again.status, 200);
  assert.deepEqual(await fs.readdir(path.join(process.env.STORAGE_DIR, 'videos')).then((l) => l.filter((n) => n.startsWith(YT))), [`${YT}.mp4`]);
});

test('dépôt : reprise après coupure, taille respectée, fichier invalide refusé', { skip: !enabled }, async () => {
  const id = await idOf(YT);
  await call('POST', `/api/admin/videos/${id}/file/start`, { size: sample.length });
  assert.equal((await chunk(id, 0, sample.subarray(0, 5000), sample.length)).status, 200);
  // le client croit être à 0 (réponse perdue) : le serveur indique où reprendre
  const redo = await chunk(id, 0, sample.subarray(0, 5000), sample.length);
  assert.equal(redo.status, 409);
  assert.equal(redo.body.received, 5000);
  const skip = await chunk(id, 9000, sample.subarray(9000, 12000), sample.length); // trou
  assert.deepEqual([skip.status, skip.body.received], [409, 5000]);
  assert.equal((await chunk(id, 5000, sample.subarray(5000), sample.length)).status, 200);
  // plus d'octets que la taille annoncée
  assert.equal((await chunk(id, sample.length, Buffer.from('x'), sample.length)).status, 413);
  // fichier incomplet
  await call('POST', `/api/admin/videos/${id}/file/start`, { size: 1000 });
  await chunk(id, 0, Buffer.alloc(400), 1000);
  const short = await call('POST', `/api/admin/videos/${id}/file/finish`, { size: 1000 });
  assert.deepEqual([short.status, short.body.received], [409, 400]);

  // fichier qui n'est pas une vidéo : refusé, rien ne reste, l'ancien fichier est intact
  const junk = Buffer.from('ceci est un texte, pas une vidéo '.repeat(100));
  const bad = await upload(id, junk, 1000);
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /vidéo/);
  await assert.rejects(fs.stat(path.join(process.env.STORAGE_DIR, 'uploads', `${YT}.part`)));
  assert.equal((await fs.stat(path.join(process.env.STORAGE_DIR, 'videos', `${YT}.mp4`))).size, sample.length);

  // limites : taille annoncée absurde ou trop grande
  assert.equal((await call('POST', `/api/admin/videos/${id}/file/start`, { size: 0 })).status, 400);
  process.env.MAX_VIDEO_MB = '1';
  try {
    assert.equal((await call('POST', `/api/admin/videos/${id}/file/start`, { size: 5 * 1024 * 1024 })).status, 413);
  } finally {
    delete process.env.MAX_VIDEO_MB;
  }
  assert.equal((await call('GET', '/api/admin/videos/999999999/clips')).status, 404);
});

test('clips autorisés : exige un fichier, se retire avec lui, et le fichier part avec la vidéo', { skip: !enabled }, async () => {
  const id = await idOf(YT);
  const id2 = await idOf(YT2);
  await call('DELETE', `/api/admin/videos/${id2}/file`);
  const refused = await call('PUT', `/api/admin/videos/${id2}/clips`, { enabled: true });
  assert.equal(refused.status, 409); // pas de fichier

  const on = await call('PUT', `/api/admin/videos/${id}/clips`, { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.enabled, true);
  assert.equal(on.body.suggestions, null); // pas de clé OpenRouter : pas d'extraits, mais l'autorisation est posée
  assert.equal((await call('PUT', `/api/admin/videos/${id}/clips`, { enabled: false })).body.enabled, false);
  await call('PUT', `/api/admin/videos/${id}/clips`, { enabled: true });

  // supprimer le fichier retire aussi l'autorisation
  const removed = await call('DELETE', `/api/admin/videos/${id}/file`);
  assert.deepEqual([removed.body.file, removed.body.enabled], [null, false]);
  await assert.rejects(fs.stat(path.join(process.env.STORAGE_DIR, 'videos', `${YT}.mp4`)));

  // supprimer la vidéo supprime son fichier
  await upload(id, sample, 100_000);
  assert.equal((await fs.stat(path.join(process.env.STORAGE_DIR, 'videos', `${YT}.mp4`))).size, sample.length);
  assert.equal((await call('DELETE', `/api/admin/videos/${id}`)).status, 200);
  await assert.rejects(fs.stat(path.join(process.env.STORAGE_DIR, 'videos', `${YT}.mp4`)));
  await pool.query(`DELETE FROM excluded_videos WHERE youtube_id = $1`, [YT]);
});

test('noms de fichiers : jamais issus d\'une saisie du client', async () => {
  const m = await import('../src/media.js');
  assert.throws(() => m.videoFilePath('../../etc/passwd'), (e) => e.status === 404);
  assert.throws(() => m.videoFilePath('abc.mp4'), (e) => e.status === 404);
  assert.throws(() => m.partPath('../../x'), (e) => e.status === 400);
  assert.match(m.videoFilePath('abcdefghijk.mp4'), /videos[\\/]abcdefghijk\.mp4$/);
});
