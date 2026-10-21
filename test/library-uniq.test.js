// Bibliothèque : uniquification par (clip, personne) — chaque personne télécharge son propre fichier
// (nécessite Postgres via DATABASE_URL et ffmpeg, sinon ignorés)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const enabled = Boolean(process.env.DATABASE_URL) && hasFfmpeg;
const YT = 'UNIQtest_001';
const DURATION = 8;
const CLIP_S = 3; // extrait 500 ms → 3500 ms
const SECRET = 'z'.repeat(32);

let pool;
let server;
let base;
let dir;
let lib;
let routes;
let uniq;

const browser = (ip = null) => {
  const jar = new Map();
  const call = async (method, p, body, headers = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(ip ? { 'X-Forwarded-For': ip } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const [k, ...v] = kv.split('=');
      if (/Max-Age=0/.test(c)) jar.delete(k);
      else jar.set(k, v.join('='));
    }
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };
  return { call, jar };
};

const REQ = { youtube_id: YT, extracts: [{ start_ms: 500, end_ms: 3500 }], layout: { fit: 'blur', quality: 'fast' }, style: { preset: 'hormozi' } };

async function renderAs(b) {
  const r = await b.call('POST', '/api/studio/render', REQ);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const t0 = Date.now();
  for (;;) {
    const s = await b.call('GET', `/api/studio/render/${r.body.id}`);
    if (s.body.status === 'done') return r.body.id;
    if (['error', 'cancelled'].includes(s.body.status) || Date.now() - t0 > 60_000) throw new Error(JSON.stringify(s.body));
    await new Promise((x) => setTimeout(x, 150));
  }
}

async function publishAs(b) {
  const job = await renderAs(b);
  const r = await b.call('POST', '/api/library/clips', { job_id: job });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

/** Démarre la variante de `b` pour ce clip et attend qu'elle soit prête (replis « skipped » : erreur ici). */
async function variantReady(b, id, { timeoutMs = 120_000 } = {}) {
  const start = await b.call('POST', `/api/library/clips/${id}/variant`);
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.ok(['ready', 'queued', 'running'].includes(start.body.state), JSON.stringify(start.body));
  const t0 = Date.now();
  for (;;) {
    const st = await b.call('GET', `/api/library/clips/${id}/variant`);
    assert.equal(st.status, 200);
    if (st.body.state === 'ready') return st.body;
    if (['error', 'skipped', 'disabled'].includes(st.body.state)) throw new Error(`Variante en ${st.body.state} : ${st.body.progress}`);
    if (Date.now() - t0 > timeoutMs) throw new Error('Délai : la variante n’est jamais prête');
    await new Promise((x) => setTimeout(x, 250));
  }
}

const probe = (file) =>
  JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }),
  );

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'library-uniq-test-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  process.env.STUDIO_RENDERS_PER_HOUR = '100';
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.SESSION_SECRET = SECRET;
  process.env.LIBRARY_MIN_FREE_MB = '0';
  delete process.env.LIBRARY_UNIQ;
  delete process.env.LIBRARY_UNIQ_LEVEL;
  await fs.mkdir(path.join(process.env.STORAGE_DIR, 'videos'), { recursive: true });
  const sample = path.join(process.env.STORAGE_DIR, 'videos', `${YT}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=duration=${DURATION}:size=640x360:rate=25`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${DURATION}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sample]);
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  const { rows } = await pool.query(
    `INSERT INTO videos (youtube_id, title, channel, published_at, source, lang, duration_s, file_name, file_size, file_duration_s, file_width, file_height, file_has_audio, file_uploaded_at, clips_enabled)
     VALUES ($1, 'Interview de test de l’unicité', 'Chaîne', '2025-03-01', 'manual', 'fr', $2::int, $3, 1000, $2::real, 640, 360, TRUE, now(), TRUE) RETURNING id`,
    [YT, DURATION, `${YT}.mp4`],
  );
  await db.withTransaction((c) => db.replaceSegments(c, rows[0].id, Array.from({ length: 8 }, (_, i) => ({ start_ms: i * 1000, duration_ms: 950, text: `Ligne ${i} de test.` }))));
  lib = await import('../src/library/library.js');
  uniq = await import('../src/library/uniq.js');
  routes = await import('../src/routes/library.js');
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(async () => {
  if (!enabled) return;
  lib.resetLibraryState();
  uniq.resetUniqState();
  routes.resetLibraryRoutes();
  await pool.query('DELETE FROM library_clips WHERE youtube_id = $1', [YT]);
});

after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  server.close();
  await pool.end();
  await fs.rm(dir, { recursive: true, force: true });
});

test('variantes : deux personnes → deux fichiers différents, valides et de même durée', { skip: !enabled }, async () => {
  const alice = browser();
  const clip = await publishAs(alice);
  const p1 = browser('10.77.0.1');
  const p2 = browser('10.77.0.2');
  await variantReady(p1, clip.id);
  await variantReady(p2, clip.id);
  const d1 = await p1.call('GET', `/api/library/clips/${clip.id}/file?use=download`);
  const d2 = await p2.call('GET', `/api/library/clips/${clip.id}/file?use=download`);
  assert.equal(d1.status, 200);
  assert.equal(d2.status, 200);
  assert.match(d1.headers.get('content-disposition'), /attachment/);
  assert.ok(d1.body.length > 10_000 && d2.body.length > 10_000);
  assert.ok(!d1.body.equals(d2.body), 'deux personnes : deux fichiers différents');
  const canonical = await fs.readFile(path.join(process.env.STORAGE_DIR, 'library', `${clip.id}.mp4`));
  assert.ok(!d1.body.equals(canonical), 'la variante diffère aussi de l’original');
  for (const d of [d1, d2]) {
    const f = path.join(dir, `probe-${Math.random().toString(16).slice(2)}.mp4`);
    await fs.writeFile(f, d.body);
    const info = probe(f);
    const v = info.streams.find((s) => s.codec_type === 'video');
    const a = info.streams.find((s) => s.codec_type === 'audio');
    await fs.rm(f, { force: true });
    assert.equal(`${v.width}x${v.height}`, '720x1280', 'même définition que le clip');
    assert.ok(Math.abs(Number(info.format.duration) - CLIP_S) < 0.25, `durée conservée (${info.format.duration})`);
    assert.ok(a && a.codec_name === 'aac' && a.sample_rate === '48000', 'audio AAC 48 kHz conservé');
  }
});

test('variantes : même personne → même fichier en cache, second POST instantanément prêt', { skip: !enabled }, async () => {
  const alice = browser();
  const clip = await publishAs(alice);
  const p1 = browser('10.77.1.1');
  await variantReady(p1, clip.id);
  const again = await p1.call('POST', `/api/library/clips/${clip.id}/variant`);
  assert.deepEqual(again.body, { state: 'ready', progress: 1 });
  const d1 = await p1.call('GET', `/api/library/clips/${clip.id}/file?use=download`);
  const d1bis = await p1.call('GET', `/api/library/clips/${clip.id}/file?use=download`);
  assert.ok(d1.body.equals(d1bis.body), 're-téléchargement : même variante');
  const names = (await fs.readdir(path.join(process.env.STORAGE_DIR, 'library', 'variants'))).filter((n) => n.startsWith(`${clip.id}_`) && n.endsWith('.mp4'));
  assert.equal(names.length, 1, 'une seule variante pour cette personne');
});

test('variantes : la lecture en ligne sert l’original inchangé', { skip: !enabled }, async () => {
  const alice = browser();
  const clip = await publishAs(alice);
  await variantReady(browser('10.77.2.1'), clip.id);
  const inline = await browser('10.77.2.2').call('GET', `/api/library/clips/${clip.id}/file`);
  assert.equal(inline.status, 200);
  const canonical = await fs.readFile(path.join(process.env.STORAGE_DIR, 'library', `${clip.id}.mp4`));
  assert.ok(inline.body.equals(canonical), 'le flux de lecture reste le fichier canonique');
});

test('variantes : LIBRARY_UNIQ=off → désactivé, téléchargement de l’original', { skip: !enabled }, async () => {
  process.env.LIBRARY_UNIQ = 'off';
  try {
    const alice = browser();
    const clip = await publishAs(alice);
    const p1 = browser('10.77.3.1');
    assert.deepEqual((await p1.call('POST', `/api/library/clips/${clip.id}/variant`)).body, { state: 'disabled', progress: 0 });
    const d = await p1.call('GET', `/api/library/clips/${clip.id}/file?use=download`);
    assert.equal(d.status, 200);
    const canonical = await fs.readFile(path.join(process.env.STORAGE_DIR, 'library', `${clip.id}.mp4`));
    assert.ok(d.body.equals(canonical), 'sans uniquification : le fichier d’origine');
  } finally {
    delete process.env.LIBRARY_UNIQ;
  }
});

test('variantes : supprimées avec le clip, orphelines nettoyées à l’entretien', { skip: !enabled }, async () => {
  const alice = browser();
  const clip = await publishAs(alice);
  await variantReady(browser('10.77.4.1'), clip.id);
  const variantsDir = path.join(process.env.STORAGE_DIR, 'library', 'variants');
  assert.ok((await fs.readdir(variantsDir)).some((n) => n.startsWith(`${clip.id}_`)));
  await alice.call('DELETE', `/api/library/clips/${clip.id}`);
  assert.ok(!(await fs.readdir(variantsDir)).some((n) => n.startsWith(`${clip.id}_`)), 'supprimées avec le clip');
  // orpheline (clip inexistant) : l’entretien la retire
  await fs.mkdir(variantsDir, { recursive: true });
  const orphan = `${'a'.repeat(24)}_${'b'.repeat(16)}_gentle.mp4`;
  await fs.writeFile(path.join(variantsDir, orphan), 'x');
  await lib.libraryMaintenance();
  assert.ok(!(await fs.readdir(variantsDir)).includes(orphan));
});
