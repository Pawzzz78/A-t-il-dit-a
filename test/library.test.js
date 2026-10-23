// Clip library end to end (needs Postgres via DATABASE_URL and ffmpeg, skipped otherwise)
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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
const YT = 'LIBtest_001';
const DURATION = 8;
const SECRET = 'y'.repeat(32);

let pool;
let server;
let base;
let dir;
let studio;
let lib;
let routes;

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

const REQ = { youtube_id: YT, extracts: [{ start_ms: 500, end_ms: 3500 }], layout: { fit: 'blur', quality: 'fast' }, style: { preset: 'hormozi' }, edits: { 1000: 'Texte corrigé' } };

async function renderAs(b, extra = {}) {
  const r = await b.call('POST', '/api/studio/render', { ...REQ, ...extra });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  const t0 = Date.now();
  for (;;) {
    const s = await b.call('GET', `/api/studio/render/${r.body.id}`);
    if (s.body.status === 'done') return r.body.id;
    if (['error', 'cancelled'].includes(s.body.status) || Date.now() - t0 > 60_000) throw new Error(JSON.stringify(s.body));
    await new Promise((x) => setTimeout(x, 150));
  }
}

async function publishAs(b, extra = {}) {
  const job = await renderAs(b);
  const r = await b.call('POST', '/api/library/clips', { job_id: job, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

const sealMember = (sub) => {
  const body = Buffer.from(JSON.stringify({ sub, gn: 'Camille', exp: Date.now() + 3600_000 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'library-test-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  process.env.STUDIO_RENDERS_PER_HOUR = '100';
  process.env.ADMIN_PASSWORD = 'pw-test';
  process.env.SESSION_SECRET = SECRET;
  process.env.LIBRARY_MIN_FREE_MB = '0';
  await fs.mkdir(path.join(process.env.STORAGE_DIR, 'videos'), { recursive: true });
  const sample = path.join(process.env.STORAGE_DIR, 'videos', `${YT}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=duration=${DURATION}:size=640x360:rate=25`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${DURATION}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sample]);
  const db = await import('../src/db.js');
  pool = db.pool;
  await db.initDb();
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  const { rows } = await pool.query(
    `INSERT INTO videos (youtube_id, title, channel, published_at, source, lang, duration_s, file_name, file_size, file_duration_s, file_width, file_height, file_has_audio, file_uploaded_at, clips_enabled)
     VALUES ($1, 'Interview de test de la bibliothèque', 'Chaîne', '2025-03-01', 'manual', 'fr', $2::int, $3, 1000, $2::real, 640, 360, TRUE, now(), TRUE) RETURNING id`,
    [YT, DURATION, `${YT}.mp4`],
  );
  await db.withTransaction((c) => db.replaceSegments(c, rows[0].id, Array.from({ length: 8 }, (_, i) => ({ start_ms: i * 1000, duration_ms: 950, text: `Ligne ${i} de test.` }))));
  studio = await import('../src/studio/render.js');
  lib = await import('../src/library/library.js');
  routes = await import('../src/routes/library.js');
  const { createApp } = await import('../src/server.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  if (!enabled) return;
  studio.resetStudioState();
  lib.resetLibraryState();
  routes.resetLibraryRoutes();
  await pool.query('DELETE FROM library_clips WHERE youtube_id = $1', [YT]);
  await pool.query('DELETE FROM library_hidden_owners');
  for (const k of ['MEMBERS_ONLY', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'LIBRARY_MAX_PER_OWNER', 'LIBRARY_MAX_MB', 'LIBRARY_AUTOHIDE_REPORTS']) delete process.env[k];
});
after(async () => {
  if (!enabled) return;
  await pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  server.close();
  await pool.end();
  await fs.rm(dir, { recursive: true, force: true });
});

test('propriétaire : aucun cookie à la lecture, cookie posé au rendu, publication réservée au créateur', { skip: !enabled }, async () => {
  const alice = browser();
  const list = await alice.call('GET', '/api/library');
  assert.equal(list.status, 200);
  assert.equal(alice.jar.size, 0);
  const job = await renderAs(alice);
  assert.ok(alice.jar.has('own'));
  const bob = browser();
  assert.equal((await bob.call('POST', '/api/library/clips', { job_id: job })).status, 403);
  const forged = browser();
  forged.jar.set('own', 'a'.repeat(24) + '.' + 'b'.repeat(32));
  assert.equal((await forged.call('POST', '/api/library/clips', { job_id: job })).status, 403);
  const odd = browser();
  odd.jar.set('own', `${'a'.repeat(24)}.${'%C3%A9'.repeat(32)}`);
  assert.equal((await odd.call('GET', '/api/library/mine')).status, 200, 'cookie illisible : ignoré, pas d’erreur 500');
  const pub = await alice.call('POST', '/api/library/clips', { job_id: job });
  assert.equal(pub.status, 201);
  assert.equal(pub.body.mine, true);
  const again = await alice.call('POST', '/api/library/clips', { job_id: job });
  assert.equal(again.body.id, pub.body.id, 'même rendu, même fiche');
  assert.equal((await alice.call('POST', '/api/library/clips', { job_id: job }, { Origin: 'https://evil.example' })).status, 403);
});

test('publication : fichier et affiche, liste publique sans empreinte, privé visible du seul propriétaire', { skip: !enabled }, async () => {
  const alice = browser();
  const clip = await publishAs(alice);
  const stored = await pool.query('SELECT * FROM library_clips WHERE id = $1', [clip.id]);
  assert.ok(await fs.stat(path.join(process.env.STORAGE_DIR, 'library', `${clip.id}.mp4`)));
  assert.equal(stored.rows[0].has_poster, true);
  assert.equal(stored.rows[0].req.framing, undefined);
  const anon = browser();
  // list filtrée sur la vidéo du test : d'autres clips publics (base de dev partagée) ne faussent pas les comptes
  const list = await anon.call('GET', `/api/library?v=${YT}`);
  assert.equal(list.body.total, 1);
  // « interviews » est un widget global (top clips) : on ne contrôle que la présence de la vidéo du test
  assert.ok(list.body.interviews.some((i) => i.youtube_id === YT), 'l’interview du test est proposée');
  const raw = JSON.stringify(list.body);
  assert.ok(!raw.includes(stored.rows[0].owner_key) && !raw.includes('owner_key') && !raw.includes('127.0.0.1'));
  assert.equal(list.body.clips[0].mine, false);
  const poster = await anon.call('GET', `/api/library/clips/${clip.id}/poster`);
  assert.equal(poster.status, 200);
  assert.equal(poster.headers.get('content-type'), 'image/jpeg');

  assert.equal((await alice.call('PATCH', `/api/library/clips/${clip.id}`, { visibility: 'private' })).status, 200);
  assert.equal((await anon.call('GET', `/api/library?v=${YT}`)).body.total, 0);
  assert.equal((await anon.call('GET', `/api/library/clips/${clip.id}`)).status, 404);
  assert.equal((await alice.call('GET', `/api/library/clips/${clip.id}`)).status, 200);
  const mine = await alice.call('GET', '/api/library/mine');
  assert.equal(mine.body.clips.length, 1);
  assert.equal(mine.body.active, 1);
  assert.equal((await anon.call('PATCH', `/api/library/clips/${clip.id}`, { visibility: 'public' })).status, 404);
});

test('fichier : lecture partielle, téléchargements comptés une fois par personne', { skip: !enabled }, async () => {
  const alice = browser();
  const clip = await publishAs(alice);
  const anon = browser();
  const part = await anon.call('GET', `/api/library/clips/${clip.id}/file`, null, { Range: 'bytes=0-99' });
  assert.equal(part.status, 206);
  assert.equal(part.body.length, 100);
  const dl = await anon.call('GET', `/api/library/clips/${clip.id}/file?use=download`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  await anon.call('GET', `/api/library/clips/${clip.id}/file?use=download`);
  await alice.call('GET', `/api/library/clips/${clip.id}/file?use=download`);
  assert.equal((await anon.call('GET', `/api/library/clips/${clip.id}`)).body.downloads, 2);
  const who = await pool.query('SELECT who FROM library_downloads WHERE clip_id = $1', [clip.id]);
  assert.ok(who.rows.every((r) => !r.who.includes('127.0.0.1')));
});

test('notes : pas sur son propre clip, une par personne, modifiable, classement bayésien', { skip: !enabled }, async () => {
  const alice = browser();
  const a = await publishAs(alice);
  const bob = browser();
  const b = await publishAs(bob);
  assert.equal((await alice.call('PUT', `/api/library/clips/${a.id}/rating`, { stars: 5 })).status, 403);
  assert.equal((await bob.call('PUT', `/api/library/clips/${a.id}/rating`, { stars: 7 })).status, 400);
  assert.equal((await bob.call('PUT', `/api/library/clips/${a.id}/rating`, { stars: 2 })).body.rating, 2);
  const r = await bob.call('PUT', `/api/library/clips/${a.id}/rating`, { stars: 5 });
  assert.deepEqual([r.body.rating, r.body.rating_count, r.body.my_rating], [5, 1, 5]);
  await alice.call('PUT', `/api/library/clips/${b.id}/rating`, { stars: 3 });
  const top = await browser().call('GET', `/api/library?sort=rating&v=${YT}`);
  assert.deepEqual(top.body.clips.map((c) => c.id), [a.id, b.id]);
  const cleared = await bob.call('DELETE', `/api/library/clips/${a.id}/rating`);
  assert.deepEqual([cleared.body.rating, cleared.body.rating_count], [null, 0]);
});

test('signalements : toujours 204, masquage automatique au-delà du seuil', { skip: !enabled }, async () => {
  process.env.LIBRARY_AUTOHIDE_REPORTS = '2';
  const clip = await publishAs(browser());
  const one = browser();
  await renderAs(one); // pose un cookie de propriétaire
  assert.equal((await one.call('POST', `/api/library/clips/${clip.id}/report`, { reason: 'test' })).status, 204);
  assert.equal((await one.call('POST', `/api/library/clips/${clip.id}/report`, { reason: 'encore' })).status, 204);
  assert.equal((await browser().call('GET', `/api/library?v=${YT}`)).body.total, 1, 'un même visiteur ne compte qu’une fois');
  const sameNet = browser();
  await sameNet.call('POST', `/api/library/clips/${clip.id}/report`, {});
  assert.equal((await browser().call('GET', `/api/library?v=${YT}`)).body.total, 1, 'un nouveau cookie sur la même connexion ne compte pas');
  const two = browser('10.0.0.2');
  assert.equal((await two.call('POST', `/api/library/clips/${'f'.repeat(24)}/report`, {})).status, 204);
  await two.call('POST', `/api/library/clips/${clip.id}/report`, {});
  assert.equal((await browser().call('GET', `/api/library?v=${YT}`)).body.total, 0);
});

test('republication : dans « Mes clips » seulement, fichier de l’original, retirée avec lui', { skip: !enabled }, async () => {
  const alice = browser();
  const clip = await publishAs(alice);
  const bob = browser();
  assert.equal((await alice.call('POST', `/api/library/clips/${clip.id}/repost`)).status, 400);
  const rp = await bob.call('POST', `/api/library/clips/${clip.id}/repost`);
  assert.equal(rp.status, 201);
  assert.equal((await bob.call('POST', `/api/library/clips/${clip.id}/repost`)).body.id, rp.body.id);
  assert.equal((await browser().call('GET', `/api/library?v=${YT}`)).body.total, 1);
  const mine = await bob.call('GET', '/api/library/mine');
  assert.equal(mine.body.clips[0].original.id, clip.id);
  assert.equal(mine.body.active, 0, 'une republication ne compte pas dans le plafond');
  assert.equal((await bob.call('GET', `/api/library/clips/${rp.body.id}/file`, null, { Range: 'bytes=0-9' })).status, 206);
  const req = await bob.call('GET', `/api/library/clips/${rp.body.id}/request`);
  assert.equal(req.body.id, clip.id);
  assert.equal(req.body.req.edits['1000'], 'Texte corrigé');
  await alice.call('PATCH', `/api/library/clips/${clip.id}`, { visibility: 'private' });
  assert.equal((await bob.call('GET', `/api/library/clips/${rp.body.id}/file`)).status, 404, 'original privé : plus servi');
  assert.equal((await bob.call('GET', `/api/library/clips/${rp.body.id}/request`)).status, 404);
  const gone = await bob.call('GET', `/api/library/clips/${rp.body.id}`);
  assert.deepEqual([gone.status, gone.body.original], [200, null], 'la republication reste ouvrable pour être retirée');
  assert.equal((await bob.call('GET', '/api/library/mine')).body.clips[0].original, null);
  await alice.call('PATCH', `/api/library/clips/${clip.id}`, { visibility: 'public' });
  assert.equal((await alice.call('DELETE', `/api/library/clips/${clip.id}`)).status, 204);
  assert.equal((await bob.call('GET', '/api/library/mine')).body.clips.length, 0);
  await assert.rejects(fs.stat(path.join(process.env.STORAGE_DIR, 'library', `${clip.id}.mp4`)));
});

test('« Modifier » : les réglages enregistrés repassent la validation du studio à l’identique', { skip: !enabled }, async () => {
  const clip = await publishAs(browser());
  const { body } = await browser().call('GET', `/api/library/clips/${clip.id}/request`);
  const { rows } = await pool.query('SELECT file_duration_s FROM videos WHERE youtube_id = $1', [YT]);
  const once = studio.normalizeRequest(body.req, rows[0]);
  assert.deepEqual(studio.normalizeRequest(lib.storedRequest(once), rows[0]), once);
  assert.deepEqual(once.edits, [{ start_ms: 1000, text: 'Texte corrigé' }]);
  const remix = await publishAs(browser(), { remix_of: clip.id });
  assert.equal(remix.remix_of, clip.id);
});

test('plafonds : fichiers par propriétaire, taille totale', { skip: !enabled }, async () => {
  const alice = browser();
  await publishAs(alice);
  process.env.LIBRARY_MAX_PER_OWNER = '1';
  const job = await renderAs(alice);
  assert.equal((await alice.call('POST', '/api/library/clips', { job_id: job })).status, 429);
  process.env.LIBRARY_MAX_PER_OWNER = '30';
  process.env.LIBRARY_MAX_MB = '0';
  const full = await alice.call('POST', '/api/library/clips', { job_id: job });
  assert.equal(full.status, 507);
});

test('expiration : fichier archivé (affiche gardée), puis recréé avec les mêmes réglages', { skip: !enabled }, async () => {
  const alice = browser();
  const clip = await publishAs(alice);
  const file = path.join(process.env.STORAGE_DIR, 'library', `${clip.id}.mp4`);
  await lib.libraryMaintenance(Date.now() + 31 * 86400_000);
  await assert.rejects(fs.stat(file));
  assert.ok(await fs.stat(path.join(process.env.STORAGE_DIR, 'library', `${clip.id}.jpg`)));
  const anon = browser();
  assert.equal((await anon.call('GET', `/api/library/clips/${clip.id}`)).body.file_state, 'archived');
  assert.equal((await anon.call('GET', `/api/library/clips/${clip.id}/file`)).status, 410);
  await renderAs(anon);
  const rc = await anon.call('POST', `/api/library/clips/${clip.id}/recreate`);
  assert.equal(rc.status, 202, JSON.stringify(rc.body));
  assert.equal(rc.body.file_state, 'pending');
  const t0 = Date.now();
  let state;
  do {
    await new Promise((x) => setTimeout(x, 200));
    state = (await anon.call('GET', `/api/library/clips/${clip.id}`)).body;
  } while (state.file_state === 'pending' && Date.now() - t0 < 60_000);
  assert.equal(state.file_state, 'active');
  assert.equal(state.file_version, 2);
  assert.ok(await fs.stat(file));
  await lib.libraryMaintenance();
  assert.ok(await fs.stat(file), 'un fichier actif n’est pas un orphelin');
});

test('interview remplacée : recréation refusée, « Modifier » proposé', { skip: !enabled }, async () => {
  const clip = await publishAs(browser());
  await lib.libraryMaintenance(Date.now() + 31 * 86400_000);
  await pool.query('UPDATE videos SET file_uploaded_at = now() + interval \'1 minute\' WHERE youtube_id = $1', [YT]);
  const b = browser();
  await renderAs(b);
  const rc = await b.call('POST', `/api/library/clips/${clip.id}/recreate`);
  assert.equal(rc.status, 409);
  assert.equal(rc.body.edit, true);
});

test('mode adhérents : lecture ouverte, actions réservées aux adhérents connectés', { skip: !enabled }, async () => {
  const clip = await publishAs(browser());
  Object.assign(process.env, { MEMBERS_ONLY: 'on', OIDC_CLIENT_ID: 'studio', OIDC_CLIENT_SECRET: 'secret' });
  const anon = browser();
  const list = await anon.call('GET', '/api/library');
  assert.equal(list.status, 200);
  assert.equal(list.body.can_write, false);
  const denied = await anon.call('PUT', `/api/library/clips/${clip.id}/rating`, { stars: 4 });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.login, '/api/auth/login');
  assert.equal(anon.jar.size, 0);
  const member = browser();
  member.jar.set('mbr', sealMember('sub-1'));
  assert.equal((await member.call('PUT', `/api/library/clips/${clip.id}/rating`, { stars: 4 })).status, 200);
  assert.equal(member.jar.has('own'), false);
});

test('admin : vue d’ensemble, masquage d’un auteur, archivage, suppression', { skip: !enabled }, async () => {
  const alice = browser();
  const clip = await publishAs(alice);
  const admin = browser();
  assert.equal((await admin.call('GET', '/api/admin/library')).status, 401);
  await admin.call('POST', '/api/admin/login', { password: 'pw-test' });
  const o = await admin.call('GET', '/api/admin/library');
  assert.equal(o.status, 200);
  const row = o.body.clips.find((c) => c.id === clip.id);
  assert.ok(row && o.body.counts.clips >= 1 && o.body.disk.used > 0);
  await admin.call('PUT', `/api/admin/library/owners/${row.owner}`, { hidden: true });
  assert.equal((await browser().call('GET', `/api/library?v=${YT}`)).body.total, 0);
  await admin.call('PUT', `/api/admin/library/owners/${row.owner}`, { hidden: false });
  await admin.call('PATCH', `/api/admin/library/clips/${clip.id}`, { hidden: true });
  assert.equal((await browser().call('GET', `/api/library?v=${YT}`)).body.total, 0);
  await admin.call('DELETE', `/api/admin/library/clips/${clip.id}/file`);
  assert.equal((await alice.call('GET', `/api/library/clips/${clip.id}`)).body.file_state, 'archived');
  await admin.call('DELETE', `/api/admin/library/clips/${clip.id}`);
  assert.equal((await alice.call('GET', `/api/library/clips/${clip.id}`)).status, 404);
});

test('effacer mes données : clips, notes et cookie supprimés', { skip: !enabled }, async () => {
  const alice = browser();
  const a = await publishAs(alice);
  const bob = browser();
  const b = await publishAs(bob);
  await alice.call('PUT', `/api/library/clips/${b.id}/rating`, { stars: 1 });
  assert.equal((await alice.call('DELETE', '/api/library/mine')).status, 204);
  assert.equal(alice.jar.has('own'), false);
  assert.equal((await browser().call('GET', `/api/library/clips/${a.id}`)).status, 404);
  assert.equal((await bob.call('GET', `/api/library/clips/${b.id}`)).body.rating_count, 0);
});

test('écran de fin : téléchargeable avec ou sans, réglage conservé pour « Modifier »', { skip: !enabled }, async () => {
  const alice = browser();
  const plain = await publishAs(alice);
  assert.equal(plain.end_card_s, 0);
  assert.equal((await alice.call('GET', `/api/library/clips/${plain.id}/file?use=download&end=0`)).status, 404);
  const job = await renderAs(alice, { end_card: { on: true, source: true, text: 'Partage', dur: 2 } });
  const clip = (await alice.call('POST', '/api/library/clips', { job_id: job })).body;
  assert.equal(clip.end_card_s, 2);
  assert.ok(Math.abs(clip.duration_s - 5) < 0.01, `durée ${clip.duration_s}`);
  const seconds = async (q) => {
    const r = await browser().call('GET', `/api/library/clips/${clip.id}/file${q}`);
    assert.equal(r.status, 200);
    const f = path.join(dir, `dl-${Date.now()}.mp4`);
    await fs.writeFile(f, r.body);
    return { d: Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' })), name: r.headers.get('content-disposition') };
  };
  const without = await seconds('?use=download&end=0');
  assert.ok(Math.abs(without.d - 3) < 0.3, `sans : ${without.d}`);
  assert.match(without.name, /-sans-fin\.mp4/);
  assert.ok(Math.abs((await seconds('?end=0')).d - 3) < 0.3, 'même fichier, réutilisé');
  const { body } = await browser().call('GET', `/api/library/clips/${clip.id}/request`);
  assert.deepEqual(body.req.end_card, { on: true, source: true, text: 'Partage', dur: 2 });
  await alice.call('DELETE', `/api/library/clips/${clip.id}`);
  await assert.rejects(fs.stat(path.join(process.env.STORAGE_DIR, 'library', `${clip.id}.noend.mp4`)));
});

test('visuel de fin : gardé avec le clip, servi pour « Modifier », remis en place pour « Recréer »', { skip: !enabled }, async () => {
  const alice = browser();
  const jpg = path.join(dir, 'libcard.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=1080x1920', '-frames:v', '1', jpg]);
  const up = await (await fetch(`${base}/api/studio/endcard`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: await fs.readFile(jpg) })).json();
  const job = await renderAs(alice, { end_card: { on: true, source: false, image: up.id, dur: 2, design: { template: 'headline', values: { title: 'Bonjour' } } } });
  const clip = (await alice.call('POST', '/api/library/clips', { job_id: job })).body;
  const card = await browser().call('GET', `/api/library/clips/${clip.id}/card`);
  assert.equal(card.status, 200);
  assert.equal(card.headers.get('content-type'), 'image/jpeg');
  const { body } = await browser().call('GET', `/api/library/clips/${clip.id}/request`);
  assert.equal(body.req.end_card.image, up.id);
  assert.deepEqual(body.req.end_card.design.values, { title: 'Bonjour' });
  assert.equal((await browser().call('GET', `/api/library/clips/${'0'.repeat(24)}/card`)).status, 404);
  // the temporary visual is gone, the clip expires, then is re-created from its own copy
  await fs.rm(path.join(process.env.STORAGE_DIR, 'cards', `${up.id}.jpg`), { force: true });
  await lib.libraryMaintenance(Date.now() + 31 * 86400_000);
  assert.ok(await fs.stat(path.join(process.env.STORAGE_DIR, 'library', `${clip.id}.card.jpg`)), 'visuel gardé après l’archivage');
  const rc = await alice.call('POST', `/api/library/clips/${clip.id}/recreate`);
  assert.equal(rc.status, 202, JSON.stringify(rc.body));
  const t0 = Date.now();
  let st;
  do {
    await new Promise((x) => setTimeout(x, 200));
    st = (await alice.call('GET', `/api/library/clips/${clip.id}`)).body;
  } while (st.file_state === 'pending' && Date.now() - t0 < 60_000);
  assert.equal(st.file_state, 'active');
});

test('logo du compte : la bibliothèque publie la version sans logo et n’en garde pas le réglage', { skip: !enabled }, async () => {
  const alice = browser();
  const png = path.join(dir, 'liblogo.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=200x200', '-frames:v', '1', png]);
  const up = await (await fetch(`${base}/api/studio/logo`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await fs.readFile(png) })).json();
  const job = await renderAs(alice, { logo: { image: up.id, pos: 'tl', size: 0.3, opacity: 1 } });
  const clip = (await alice.call('POST', '/api/library/clips', { job_id: job })).body;
  const file = await browser().call('GET', `/api/library/clips/${clip.id}/file?use=download`);
  const f = path.join(dir, 'libclean.mp4');
  await fs.writeFile(f, file.body);
  const px = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', f, '-frames:v', '1', '-vf', 'crop=40:40:70:130,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.ok(!(px[0] > 200 && px[1] < 60 && px[2] < 60), `aucun logo dans la bibliothèque ${[...px]}`);
  const { body } = await browser().call('GET', `/api/library/clips/${clip.id}/request`);
  assert.equal(body.req.logo, undefined);
});
