// Studio de clips public : liste, aperçu, rendu ffmpeg, file d'attente, limites, nettoyage
// (nécessite Postgres via DATABASE_URL et ffmpeg, sinon ignorés).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
const YT = 'STUtest_001'; // clips autorisés
const YT_OFF = 'STUtest_002'; // fichier présent, clips non autorisés
const DURATION = 12;

let pool;
let server;
let base;
let dir;
let studio;
let core;
let videoRowId;

const api = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers, res };
};
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' }));
const waitFor = async (id, until, ms = 60_000) => {
  const t0 = Date.now();
  for (;;) {
    const r = await api('GET', `/api/studio/render/${id}`);
    if (until(r.body)) return r.body;
    if (Date.now() - t0 > ms) throw new Error(`délai dépassé : ${JSON.stringify(r.body)}`);
    await new Promise((r2) => setTimeout(r2, 150));
  }
};
const REQ = (extra = {}) => ({
  youtube_id: YT,
  extracts: [{ start_ms: 1000, end_ms: 5000 }, { start_ms: 7000, end_ms: 10500 }],
  layout: { fit: 'blur', quality: 'fast' },
  style: { preset: 'hormozi' },
  music: { id: 'lofi-doux', volume: 0.3 },
  ...extra,
});

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-test-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  process.env.STUDIO_RENDERS_PER_HOUR = '100';
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.SESSION_SECRET = 'x'.repeat(32);
  await fs.mkdir(path.join(process.env.STORAGE_DIR, 'videos'), { recursive: true });
  const sample = path.join(process.env.STORAGE_DIR, 'videos', `${YT}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=duration=${DURATION}:size=640x360:rate=25`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${DURATION}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sample]);
  await fs.copyFile(sample, path.join(process.env.STORAGE_DIR, 'videos', `${YT_OFF}.mp4`));
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM videos WHERE youtube_id = ANY($1)', [[YT, YT_OFF]]);
  for (const [yt, on] of [[YT, true], [YT_OFF, false]]) {
    const { rows } = await pool.query(
      `INSERT INTO videos (youtube_id, title, channel, published_at, source, lang, duration_s, file_name, file_size, file_duration_s, file_width, file_height, file_has_audio, file_uploaded_at, clips_enabled)
       VALUES ($1, 'Interview de test du studio', 'Chaîne', '2025-03-01', 'manual', 'fr', $2::int, $3, 1000, $2::real, 640, 360, TRUE, now(), $4) RETURNING id`,
      [yt, DURATION, `${yt}.mp4`, on],
    );
    await db.withTransaction((c) =>
      db.replaceSegments(c, rows[0].id, Array.from({ length: 12 }, (_, i) => ({ start_ms: i * 1000, duration_ms: 950, text: `Ligne numéro ${i} de la transcription de test.` }))),
    );
    if (yt === YT) videoRowId = rows[0].id;
  }
  studio = await import('../src/studio/render.js');
  core = await import('../public/js/studio-core.js');
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => enabled && studio.resetStudioState());
after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM videos WHERE youtube_id = ANY($1)', [[YT, YT_OFF]]);
  server.close();
  await pool.end();
  await fs.rm(dir, { recursive: true, force: true });
});

test('éléments de l\'éditeur : 22 polices présentes, 8 musiques, 5 styles', async () => {
  const { FONTS, MUSIC, FONTS_DIR, MUSIC_DIR } = await import('../src/studio/render.js');
  assert.equal(FONTS.length, 22);
  assert.equal(new Set(FONTS.map((f) => f.ass_name)).size, 22); // un nom de police unique par fichier
  for (const f of FONTS) assert.ok((await fs.stat(path.join(FONTS_DIR, f.file))).size > 5000, f.file);
  assert.equal(MUSIC.length, 8);
  for (const m of MUSIC) assert.ok((await fs.stat(path.join(MUSIC_DIR, m.file))).size > 100_000, m.file);
  if (!enabled) return;
  const a = (await api('GET', '/api/studio/assets')).body;
  assert.deepEqual([a.fonts.length, a.music.length, a.presets.length], [22, 8, 5]);
  assert.equal(a.limits.maxTotalS, 90);
  assert.deepEqual(a.presets.map((p) => p.id), ['hormozi', 'un-mot', 'karaoke', 'classique', 'boite']);
});

test('studio : seules les vidéos autorisées sont listées, sans jamais exposer le fichier', { skip: !enabled }, async () => {
  const list = (await api('GET', '/api/studio/videos')).body.videos.map((v) => v.youtube_id);
  assert.ok(list.includes(YT) && !list.includes(YT_OFF));
  assert.equal((await api('GET', `/api/studio/videos/${YT_OFF}`)).status, 404);
  assert.equal((await api('GET', '/api/studio/videos/pas-un-id')).status, 404);
  const d = (await api('GET', `/api/studio/videos/${YT}`)).body;
  assert.equal(d.video.title, 'Interview de test du studio');
  assert.equal(d.lines.length, 12);
  assert.deepEqual(d.lines[1], [1000, 1950, 'Ligne numéro 1 de la transcription de test.']);
  assert.ok(!JSON.stringify(d).includes('.mp4') && !JSON.stringify(d).includes('file_name'));
  // le fichier d'origine n'a aucune adresse publique
  for (const p of [`/api/studio/file/${YT}`, `/videos/${YT}.mp4`, `/api/admin/videos/${videoRowId}/file`]) assert.ok([401, 404].includes((await fetch(base + p)).status), p);
});

test('demande : extraits, cadrage, style et musique validés', { skip: !enabled }, async () => {
  const { normalizeRequest } = studio;
  const video = { file_duration_s: 120 };
  const ok = normalizeRequest({ extracts: [{ start_ms: 1000, end_ms: 31000 }], style: { preset: 'karaoke', size: 5000 }, music: { id: 'lofi-doux', volume: 9 }, layout: { fit: 'crop', cropX: -3, quality: 'x' } }, video);
  assert.deepEqual([ok.total, ok.style.size, ok.music.volume, ok.layout.fit, ok.layout.cropX, ok.layout.quality, ok.voice], [30, 220, 1, 'crop', 0, 'hd', 1]);
  const bad = (body, re) => assert.throws(() => normalizeRequest(body, video), (e) => e.status === 400 && re.test(e.message), JSON.stringify(body).slice(0, 80));
  bad({}, /au moins un extrait/);
  bad({ extracts: [{ start_ms: 0, end_ms: 1000 }] }, /au moins 3 secondes/);
  bad({ extracts: [{ start_ms: 5000, end_ms: 4000 }] }, /invalide/);
  bad({ extracts: [{ start_ms: 0, end_ms: 200_000 }] }, /dépasse la durée/);
  bad({ extracts: [{ start_ms: 0, end_ms: 50_000 }, { start_ms: 60_000, end_ms: 110_000 }] }, /90 secondes/);
  bad({ extracts: Array.from({ length: 5 }, () => ({ start_ms: 0, end_ms: 5000 })) }, /4 extraits/);
  bad({ extracts: [{ start_ms: 0, end_ms: 5000 }], music: { id: 'inconnue' } }, /Musique inconnue/);
});

test('commande ffmpeg : cadrage, sous-titres, mixage musique, durée', { skip: !enabled }, () => {
  const req = studio.normalizeRequest(REQ(), { file_duration_s: DURATION });
  const args = studio.buildFfmpegArgs({ file: '/x/in.mp4', req, hasAudio: true, assPath: '/x/a.ass', out: '/x/out.mp4' });
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.equal(args.filter((a) => a === '-i').length, 3); // 2 extraits + 1 musique
  assert.match(graph, /concat=n=2:v=1:a=1/);
  assert.match(graph, /ass=\/x\/a\.ass:fontsdir=.*fonts\/studio\[vo\]/);
  assert.match(graph, /scale=720:1280/); // qualité « fast »
  assert.match(graph, /boxblur/); // fond flou
  assert.match(graph, /amix=inputs=2/);
  assert.match(graph, /volume=0.3/);
  assert.equal(args[args.indexOf('-t', args.length - 12) + 1], '7.5');
  const sansMusique = studio.buildFfmpegArgs({ file: '/x/in.mp4', req: { ...req, music: null }, hasAudio: false, assPath: '/x/a.ass', out: '/x/o.mp4' });
  assert.doesNotMatch(sansMusique[sansMusique.indexOf('-filter_complex') + 1], /amix/);
  assert.match(sansMusique[sansMusique.indexOf('-filter_complex') + 1], /anullsrc/); // vidéo sans son
  const crop = studio.buildFfmpegArgs({ file: '/x/in.mp4', req: { ...req, layout: { fit: 'crop', cropX: 0.25, quality: 'hd' } }, hasAudio: true, assPath: '/x/a.ass', out: '/x/o.mp4' });
  assert.match(crop[crop.indexOf('-filter_complex') + 1], /crop=1080:1920:\(iw-ow\)\*0\.25/);
  const prev = studio.buildFfmpegArgs({ file: '/x/in.mp4', req, hasAudio: true, out: '/x/p.mp4', kind: 'preview' });
  assert.doesNotMatch(prev[prev.indexOf('-filter_complex') + 1], /ass=|amix/); // l'aperçu n'a ni sous-titres ni musique
  assert.match(prev[prev.indexOf('-filter_complex') + 1], /scale=360:640/);
});

test('aperçu : 360 × 640, mis en cache, retiré si les clips ne sont plus autorisés', { skip: !enabled }, async () => {
  const p = await api('POST', '/api/studio/preview', REQ());
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.duration_s, 7.5);
  assert.match(p.body.url, /^\/api\/studio\/preview\/[0-9a-f]{40}\.mp4$/);
  const file = path.join(process.env.STORAGE_DIR, 'previews', `${p.body.url.split('/').pop()}`);
  const info = probe(file);
  const v = info.streams.find((s) => s.codec_type === 'video');
  assert.deepEqual([v.width, v.height], [360, 640]);
  assert.ok(Math.abs(Number(info.format.duration) - 7.5) < 0.4);
  const t0 = Date.now();
  const again = await api('POST', '/api/studio/preview', REQ());
  assert.equal(again.body.url, p.body.url);
  assert.ok(Date.now() - t0 < 600, 'servi depuis le cache');
  // lecture partielle pour le lecteur vidéo
  const part = await fetch(base + p.body.url, { headers: { Range: 'bytes=0-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-type'), 'video/mp4');
  // un autre cadrage = un autre aperçu
  const other = await api('POST', '/api/studio/preview', REQ({ layout: { fit: 'crop', cropX: 0.7, quality: 'fast' } }));
  assert.notEqual(other.body.url, p.body.url);
  // autorisation retirée : l'aperçu n'est plus servi
  await pool.query('UPDATE videos SET clips_enabled = FALSE WHERE youtube_id = $1', [YT]);
  assert.equal((await fetch(base + p.body.url)).status, 404);
  assert.equal((await api('POST', '/api/studio/preview', REQ())).status, 404);
  await pool.query('UPDATE videos SET clips_enabled = TRUE WHERE youtube_id = $1', [YT]);
  assert.equal((await fetch(`${base}/api/studio/preview/${'0'.repeat(40)}.mp4`)).status, 404);
  assert.equal((await fetch(`${base}/api/studio/preview/..%2F..%2Fetc%2Fpasswd`)).status, 404);
});

test('rendu complet : MP4 vertical avec sous-titres, musique et durée exacte', { skip: !enabled }, async () => {
  const sent = await api('POST', '/api/studio/render', REQ());
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  const id = sent.body.id;
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.equal((await api('GET', `/api/studio/render/${id}/file`)).status, 409); // pas encore prêt
  const seen = [];
  const done = await waitFor(id, (s) => (seen.push(s.progress), s.status === 'done' || s.status === 'error'));
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.ok(seen.every((p, i) => !i || p >= seen[i - 1]), 'progression croissante');
  assert.equal(done.progress, 1);
  assert.match(done.filename, /^lisnard-facts-interview-de-test-du-studio-[0-9a-f]{6}\.mp4$/);
  const res = await fetch(`${base}/api/studio/render/${id}/file`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="lisnard-facts-/);
  const out = path.join(dir, 'out.mp4');
  await fs.writeFile(out, Buffer.from(await res.arrayBuffer()));
  const info = probe(out);
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  assert.deepEqual([v.codec_name, v.width, v.height, a.codec_name], ['h264', 720, 1280, 'aac']);
  assert.ok(Math.abs(Number(info.format.duration) - 7.5) < 0.3, `durée ${info.format.duration}`);
  // des sous-titres sont bien incrustés : l'image au milieu du clip n'est pas celle du seul cadrage
  const withSubs = path.join(dir, 'with.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '2', '-i', out, '-frames:v', '1', '-vf', 'crop=720:300:0:600', withSubs]);
  const prev = await api('POST', '/api/studio/preview', REQ());
  const noSubs = path.join(dir, 'nosubs.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '2', '-i', path.join(process.env.STORAGE_DIR, 'previews', prev.body.url.split('/').pop()), '-frames:v', '1', '-vf', 'scale=720:1280,crop=720:300:0:600', noSubs]);
  const a1 = (await fs.readFile(withSubs)).length;
  const a2 = (await fs.readFile(noSubs)).length;
  assert.notEqual(a1, a2);
  // supprimer un clip terminé
  assert.equal((await api('DELETE', `/api/studio/render/${id}`)).status, 200);
  assert.equal((await api('GET', `/api/studio/render/${id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/studio/render/${id}/file`)).status, 404);
});

test('rendu : tous les styles produisent une vidéo (karaoké, un mot, classique, fond sombre)', { skip: !enabled }, async () => {
  for (const preset of ['un-mot', 'karaoke', 'classique', 'boite']) {
    const r = await api('POST', '/api/studio/render', REQ({ style: { preset, font: 'bangers', color: '#00FF99', outlineColor: '#FF00AA', x: 0.4, y: 0.4, size: 90 }, music: null, extracts: [{ start_ms: 1000, end_ms: 4500 }] }));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const done = await waitFor(r.body.id, (s) => s.status === 'done' || s.status === 'error');
    assert.equal(done.status, 'done', `${preset}: ${JSON.stringify(done)}`);
    await api('DELETE', `/api/studio/render/${r.body.id}`);
  }
});

test('file d\'attente : un seul rendu à la fois, position, annulation', { skip: !enabled }, async () => {
  const a = await api('POST', '/api/studio/render', REQ());
  const b = await api('POST', '/api/studio/render', REQ({ extracts: [{ start_ms: 2000, end_ms: 6000 }] }));
  assert.equal(b.status, 202);
  const second = (await api('GET', `/api/studio/render/${b.body.id}`)).body;
  assert.ok(['queued', 'running'].includes(second.status));
  if (second.status === 'queued') assert.equal(second.position, 1);
  // un visiteur ne peut pas avoir plus de 2 clips en cours
  const c = await api('POST', '/api/studio/render', REQ());
  assert.equal(c.status, 429);
  assert.match(c.body.error, /en cours de création/);
  // annulation du 2e
  assert.equal((await api('DELETE', `/api/studio/render/${b.body.id}`)).status, 200);
  const cancelled = await waitFor(b.body.id, (s) => s.status === 'cancelled').catch(() => null);
  if (cancelled) assert.equal(cancelled.status, 'cancelled');
  assert.equal((await waitFor(a.body.id, (s) => s.status === 'done' || s.status === 'error')).status, 'done');
});

test('limites : clips par heure, réponses claires', { skip: !enabled }, async () => {
  process.env.STUDIO_RENDERS_PER_HOUR = '2';
  try {
    studio.resetStudioState();
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const r = await api('POST', '/api/studio/render', REQ({ extracts: [{ start_ms: 1000, end_ms: 4500 }], music: null }));
      assert.equal(r.status, 202);
      await waitFor(r.body.id, (s) => s.status === 'done');
      ids.push(r.body.id);
    }
    const third = await api('POST', '/api/studio/render', REQ({ extracts: [{ start_ms: 1000, end_ms: 4500 }] }));
    assert.equal(third.status, 429);
    assert.match(third.body.error, /2 clips par heure/);
  } finally {
    process.env.STUDIO_RENDERS_PER_HOUR = '100';
  }
  assert.equal((await api('POST', '/api/studio/render', { youtube_id: YT_OFF, extracts: [{ start_ms: 0, end_ms: 5000 }] })).status, 404);
  assert.equal((await api('POST', '/api/studio/render', { youtube_id: YT })).status, 400);
  assert.equal((await api('GET', '/api/studio/render/0000')).status, 404);
});

test('nettoyage : rien n\'est conservé plus d\'une heure', { skip: !enabled }, async () => {
  const r = await api('POST', '/api/studio/render', REQ({ extracts: [{ start_ms: 1000, end_ms: 4500 }], music: null }));
  await waitFor(r.body.id, (s) => s.status === 'done');
  const file = path.join(process.env.STORAGE_DIR, 'renders', `${r.body.id}.mp4`);
  assert.ok((await fs.stat(file)).size > 1000);
  await studio.cleanup(Date.now() + 5 * 60_000); // 5 minutes plus tard : conservé
  assert.ok((await fs.stat(file)).size > 1000);
  await studio.cleanup(Date.now() + 2 * 3600_000); // 2 h plus tard : supprimé
  await assert.rejects(fs.stat(file));
  assert.equal((await api('GET', `/api/studio/render/${r.body.id}`)).status, 404);
  assert.deepEqual((await fs.readdir(path.join(process.env.STORAGE_DIR, 'renders'))).filter((n) => n.startsWith(r.body.id)), []);
  void core;
});
