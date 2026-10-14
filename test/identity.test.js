// Reconnaissance de la personne de référence : photos (admin), états de l'analyse d'une vidéo, et, si on fournit le portrait d'une
// autre personne (FACES_TEST_OTHER_FACE=/chemin/photo.jpg), choix du bon visage dans un plan à deux personnes.
// (nécessite Postgres via DATABASE_URL et ffmpeg, sinon ignorés).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const enabled = Boolean(process.env.DATABASE_URL) && hasFfmpeg;
const FACE = new URL('./fixtures/face.jpg', import.meta.url).pathname;
const OTHER = process.env.FACES_TEST_OTHER_FACE && existsSync(process.env.FACES_TEST_OTHER_FACE) ? process.env.FACES_TEST_OTHER_FACE : null;
const YT = 'IDtest_0001';
const YT2 = 'IDtest_0002';

let pool;
let server;
let base;
let dir;
let cookie = '';
let faces;
let refs;
const videoRows = {};

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
};
const upload = async (bytes, name = 'photo.png', withCookie = true) => {
  const res = await fetch(`${base}/api/admin/faces/references?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'image/png', ...(withCookie && cookie ? { Cookie: cookie } : {}) }, body: bytes });
  return { status: res.status, body: await res.json().catch(() => null) };
};
/** Image du portrait (ou de `src`) passée dans un filtre ffmpeg, renvoyée en PNG. */
const image = (vf, src = FACE) => execFileSync('ffmpeg', ['-v', 'error', '-i', src, '-vf', vf, '-f', 'image2pipe', '-c:v', 'png', '-'], { maxBuffer: 1 << 26 });
const waitFor = async (fn, ms = 120_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 250));
  }
};
const insertVideo = async (yt, duration) => {
  const { rows } = await pool.query(
    `INSERT INTO videos (youtube_id, title, channel, published_at, source, lang, duration_s, file_name, file_size, file_duration_s, file_width, file_height, file_has_audio, file_uploaded_at, clips_enabled)
     VALUES ($1, 'Interview de test de la reconnaissance', 'Chaîne', '2025-03-01', 'manual', 'fr', $2::int, $3, 1000, $2::real, 1280, 720, TRUE, now(), TRUE) RETURNING *`,
    [yt, duration, `${yt}.mp4`],
  );
  videoRows[yt] = rows[0];
  const db = await import('../src/db.js'); // transcription : sans elle, la vidéo n'est pas proposée par le studio
  await db.withTransaction((c) => db.replaceSegments(c, rows[0].id, Array.from({ length: duration }, (_, i) => ({ start_ms: i * 1000, duration_ms: 950, text: `Ligne numéro ${i} de la transcription de test.` }))));
};
const analyzed = async (yt) =>
  waitFor(async () => {
    const s = await faces.facesStatus(videoRows[yt]);
    return s.status === 'ready' || s.status === 'failed' ? s : null;
  });

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'identity-test-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  const vids = path.join(process.env.STORAGE_DIR, 'videos');
  await fs.mkdir(vids, { recursive: true });
  // vidéo 1 : un seul visage (le portrait de test), 12 s
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=1280x720:r=10:d=12', '-loop', '1', '-framerate', '10', '-i', FACE, '-filter_complex', '[1:v]scale=-2:240[f];[0:v][f]overlay=x=500:y=150:shortest=1,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', '-t', '12', path.join(vids, `${YT}.mp4`)]);
  if (OTHER) {
    // vidéo 2 : deux personnes ; l'autre est plus grosse et à gauche, la personne de référence plus petite et à droite ; coupe à 10 s : elles échangent leurs places
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=1280x720:r=10:d=10', '-f', 'lavfi', '-i', 'color=c=0x705020:s=1280x720:r=10:d=10', '-loop', '1', '-framerate', '10', '-i', FACE, '-loop', '1', '-framerate', '10', '-i', OTHER,
      '-filter_complex', "[0:v][1:v]concat=n=2:v=1:a=0[bg];[2:v]scale=-2:230[a];[3:v]scale=-2:320[t];[bg][t]overlay=x='if(lt(t,10),150,820)':y=200:shortest=1[v1];[v1][a]overlay=x='if(lt(t,10),880,200)':y=300:shortest=1,format=yuv420p[v]",
      '-map', '[v]', '-c:v', 'libx264', '-t', '20', path.join(vids, `${YT2}.mp4`)]);
  }
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM videos WHERE youtube_id = ANY($1)', [[YT, YT2]]);
  await pool.query('DELETE FROM face_references');
  await insertVideo(YT, 12);
  if (OTHER) await insertVideo(YT2, 20);
  faces = await import('../src/studio/faces.js');
  refs = await import('../src/studio/references.js');
  refs.forgetReferenceSet();
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await call('POST', '/api/admin/login', { password: 'pw-test' })).status, 200);
});
after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM videos WHERE youtube_id = ANY($1)', [[YT, YT2]]);
  await pool.query('DELETE FROM face_references');
  server.close();
  await pool.end();
  await fs.rm(dir, { recursive: true, force: true });
});

test('photos de référence : réservées à l\'admin ; refus clairs (pas de visage, plusieurs visages, trop petit, pas une image)', { skip: !enabled }, async () => {
  assert.equal((await upload(image('scale=340:-2'), 'a.png', false)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/faces/references`)).status, 401);
  const gray = await upload(image('scale=300:-2,geq=r=120:g=120:b=120'), 'gris.png');
  assert.equal(gray.status, 422);
  assert.match(gray.body.error, /Aucun visage/);
  const two = await upload(image('scale=300:-2,split[a][b];[a][b]hstack'), 'deux.png');
  assert.equal(two.status, 422);
  assert.match(two.body.error, /Plusieurs visages/);
  const tiny = await upload(image('scale=38:-2,pad=300:300:100:100:gray'), 'petit.png');
  assert.equal(tiny.status, 422, JSON.stringify(tiny.body));
  assert.equal((await upload(Buffer.from('ce n\'est pas une image du tout'), 'texte.txt')).status, 422);
  assert.equal((await upload(Buffer.alloc(0))).status, 400);
  assert.equal((await call('GET', '/api/admin/faces/references')).body.count, 0); // aucun résidu
});

test('photos de référence : empreinte et vignette enregistrées, doublons refusés, retrait', { skip: !enabled }, async () => {
  const first = await upload(image('scale=340:-2'), 'prise1.png');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.count, 1);
  const dup = await upload(image('scale=340:-2'), 'prise1-bis.png');
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /déjà/);
  // d'autres prises de vue de la même personne
  for (const [vf, name] of [['hflip,scale=340:-2', 'miroir.png'], ['scale=340:-2,eq=brightness=-0.15:contrast=0.9', 'sombre.png'], ['scale=510:-2,rotate=0.2:fillcolor=gray', 'penchee.png']]) {
    const r = await upload(image(vf), name);
    assert.equal(r.status, 201, `${name} : ${JSON.stringify(r.body)}`);
  }
  const list = (await call('GET', '/api/admin/faces/references')).body;
  assert.equal(list.count, 4);
  assert.match(list.version, /^4-[0-9a-f]{8}$/);
  assert.ok(list.references.every((r) => r.similarity > 0.8 && !r.suspicious), JSON.stringify(list.references));
  assert.ok(list.references.every((r) => r.score > 0.7 && r.face_px >= 50));
  // vignette : JPEG de 112 × 112
  const thumb = await fetch(`${base}/api/admin/faces/references/${list.references[0].id}/thumb`, { headers: { Cookie: cookie } });
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
  const bytes = Buffer.from(await thumb.arrayBuffer());
  assert.equal(bytes[0], 0xff);
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-'], { input: bytes }).toString());
  assert.deepEqual([info.streams[0].width, info.streams[0].height], [112, 112]);
  assert.equal((await fetch(`${base}/api/admin/faces/references/999999/thumb`, { headers: { Cookie: cookie } })).status, 404);
  // retrait : la liste et la version changent
  const gone = await call('DELETE', `/api/admin/faces/references/${list.references[3].id}`);
  assert.equal(gone.body.count, 3);
  assert.notEqual(gone.body.version, list.version);
  assert.equal((await call('DELETE', '/api/admin/faces/references/999999')).status, 404);
});

test('vidéo : état de la reconnaissance (non faite, à jour, à mettre à jour) selon les photos de référence', { skip: !enabled }, async () => {
  const video = videoRows[YT];
  await pool.query('DELETE FROM video_faces WHERE video_id <> $1', [video.id]); // la base de test peut contenir d'autres vidéos analysées
  // avec des photos de référence, l'analyse inclut la reconnaissance (aucun plan à plusieurs visages ici : rien à comparer)
  await faces.startAnalysis(video);
  const s1 = await analyzed(YT);
  assert.equal(s1.status, 'ready', JSON.stringify(s1));
  assert.deepEqual([s1.ident.state, s1.ident.samples], ['ready', 0]);
  assert.equal((await call('GET', `/api/studio/videos/${YT}`)).body.faces.identified, true);
  // une photo de plus : l'analyse existante date d'un autre jeu de photos
  assert.equal((await upload(image('scale=420:-2,eq=gamma=1.3'), 'claire.png')).status, 201);
  assert.equal((await faces.facesStatus(video)).ident.state, 'stale');
  assert.equal((await call('GET', `/api/studio/videos/${YT}`)).body.faces.identified, false);
  assert.equal((await call('GET', `/api/admin/videos/${videoRows[YT].id}/clips`)).body.faces.ident.state, 'stale');
  // relance de la seule reconnaissance (pas de nouvelle détection)
  const before = (await pool.query('SELECT analyzed_at FROM video_faces WHERE video_id = $1', [video.id])).rows[0].analyzed_at;
  const queued = await call('POST', '/api/admin/faces/identify-all');
  assert.equal(queued.body.queued, 1);
  const s2 = await analyzed(YT);
  await waitFor(async () => (await faces.facesStatus(video)).ident.state === 'ready');
  assert.equal(s2.status, 'ready');
  assert.deepEqual((await pool.query('SELECT analyzed_at FROM video_faces WHERE video_id = $1', [video.id])).rows[0].analyzed_at, before);
  assert.equal((await call('POST', '/api/admin/faces/identify-all')).body.queued, 0); // tout est à jour
  // vidéo jamais analysée : la reconnaissance seule est refusée
  const r = await call('POST', `/api/admin/videos/${video.id}/faces/identify`);
  assert.equal(r.status, 200); // déjà analysée : accepté
  // sans aucune photo, la reconnaissance est « off »
  await pool.query('DELETE FROM face_references');
  refs.forgetReferenceSet();
  assert.equal((await faces.facesStatus(video)).ident.state, 'off');
  assert.equal((await call('GET', `/api/studio/videos/${YT}`)).body.faces.identified, false);
});

test('plan à deux personnes : « David Lisnard » suit la personne de référence, « le plus gros » l\'autre', { skip: !enabled || !OTHER }, async () => {
  await pool.query('DELETE FROM face_references');
  refs.forgetReferenceSet();
  for (const [vf, name] of [['scale=340:-2', 'a.png'], ['hflip,scale=340:-2', 'b.png'], ['scale=340:-2,eq=brightness=-0.15:contrast=0.9', 'c.png']]) {
    assert.equal((await upload(image(vf), name)).status, 201);
  }
  // une photo de quelqu'un d'autre glissée dans la liste est signalée (ne ressemble à aucune des autres)
  assert.equal((await upload(image('scale=340:-2', OTHER), 'intrus.png')).status, 201);
  const list = (await call('GET', '/api/admin/faces/references')).body;
  assert.deepEqual(list.references.map((r) => r.suspicious), [false, false, false, true], JSON.stringify(list.references));
  await call('DELETE', `/api/admin/faces/references/${list.references[3].id}`);

  const video = videoRows[YT2];
  await faces.startAnalysis(video);
  const done = await analyzed(YT2);
  assert.equal(done.status, 'ready', JSON.stringify(done));
  assert.ok(done.ident.samples >= 4 && done.ident.matches >= 2, JSON.stringify(done.ident));
  const cw = 9 / 16 / (16 / 9);
  const toX = (c) => (c - cw / 2) / (1 - cw);
  const faceW = (230 * 170) / 185; // largeur du portrait de test à l'écran
  const at = async (subject) => {
    const clip = await faces.framingForRequest(video, { layout: { fit: 'crop', follow: { on: true, subject } }, extracts: [{ start_ms: 1000, end_ms: 9000 }, { start_ms: 11000, end_ms: 19000 }] });
    return { xs: clip.segments.map((s) => s.keys[0].x), clip };
  };
  const lisnard = await at('lisnard');
  assert.ok(Math.abs(lisnard.xs[0] - toX((880 + faceW / 2) / 1280)) < 0.04, `plan 1 : ${lisnard.xs[0]}`);
  assert.ok(Math.abs(lisnard.xs[1] - toX((200 + faceW / 2) / 1280)) < 0.04, `plan 2 : ${lisnard.xs[1]}`);
  assert.deepEqual([lisnard.clip.crowded, lisnard.clip.recognized], [2, 2]);
  const biggest = await at('auto');
  assert.ok(biggest.xs[0] < 0.3 && biggest.xs[1] > 0.7, `le plus gros : ${biggest.xs}`);
  // /framing (aperçu en direct du studio) donne la même trajectoire
  const r = await call('POST', '/api/studio/framing', { youtube_id: YT2, extracts: [{ start_ms: 1000, end_ms: 9000 }, { start_ms: 11000, end_ms: 19000 }], subject: 'lisnard' });
  assert.equal(r.body.recognized, 2);
  assert.deepEqual(r.body.segments.map((s) => s.keys[0].x), lisnard.xs);
});
