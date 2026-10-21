// Clip library: <STORAGE_DIR>/library/<id>.mp4 kept LIBRARY_RETENTION_DAYS days then archived (settings and poster kept)
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pool } from '../db.js';
import { HttpError } from '../http-error.js';
import { createLimiter, ipKey } from '../ip.js';
import { stampOf, storageDir } from '../media.js';
import { CLIPPABLE, COLS, linesOf } from '../routes/studio.js';
import { framingForRequest } from '../studio/faces.js';
import { ensureMusic } from '../studio/music.js';
import { enqueueRender, normalizeRequest } from '../studio/render.js';
import { visitorHash } from '../studio/stats.js';
import { removeVariants, sweepVariants, variantsBytes } from './uniq.js';

const run = promisify(execFile);
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

export const libraryConfig = () => ({
  retentionDays: Math.max(1, num(process.env.LIBRARY_RETENTION_DAYS, 30)),
  maxMb: num(process.env.LIBRARY_MAX_MB, 1500),
  minFreeMb: num(process.env.LIBRARY_MIN_FREE_MB, 500),
  maxPerOwner: num(process.env.LIBRARY_MAX_PER_OWNER, 30),
  publishPerHour: num(process.env.LIBRARY_PUBLISH_PER_HOUR, 20),
  autohideReports: num(process.env.LIBRARY_AUTOHIDE_REPORTS, 5),
  bytesPerHourMb: num(process.env.LIBRARY_BYTES_PER_HOUR_MB, 2000),
});

export const libraryDir = () => path.join(storageDir(), 'library');
const ID = /^[0-9a-f]{24}$/;
const fileOf = (id) => path.join(libraryDir(), `${id}.mp4`);
const posterOf = (id) => path.join(libraryDir(), `${id}.jpg`);
const noEndOf = (id) => path.join(libraryDir(), `${id}.noend.mp4`);
const validId = (id) => {
  if (!ID.test(String(id))) throw new HttpError(404, 'Clip introuvable.');
  return String(id);
};

const limiter = createLimiter();
export const resetLibraryState = () => limiter.clear();

// Public listing rule: reposts never appear, hidden owners and disabled interviews neither
const VISIBLE = `c.visibility = 'public' AND NOT c.hidden AND c.kind = 'clip' AND v.clips_enabled
  AND NOT EXISTS (SELECT 1 FROM library_hidden_owners h WHERE h.owner_key = c.owner_key)`;
const BAYES = '(c.rating_sum + 3 * 3.5) / (c.rating_count + 3)';
export const SORTS = { recent: 'c.created_at DESC', downloads: 'c.downloads DESC, c.created_at DESC', rating: `${BAYES} DESC, c.rating_count DESC, c.created_at DESC` };

// Never exposes owner_key; `owner` is the viewer's key
export function present(r, owner = null) {
  return {
    id: r.id,
    kind: r.kind,
    remix_of: r.remix_of ?? null,
    youtube_id: r.youtube_id,
    video_title: r.video_title,
    video_published_at: r.video_published_at ?? null,
    visibility: r.visibility,
    hidden: r.hidden,
    duration_s: Number(r.duration_s),
    quality: r.quality,
    downloads: r.downloads,
    rating: r.rating_count ? Math.round((r.rating_sum / r.rating_count) * 10) / 10 : null,
    rating_count: r.rating_count,
    file_state: r.file_state,
    file_version: r.file_version,
    has_poster: r.has_poster,
    end_card_s: endCardSeconds(r),
    created_at: r.created_at,
    expires_at: r.file_state === 'active' ? r.file_expires_at : null,
    mine: Boolean(owner && r.owner_key === owner),
    my_rating: r.my_rating ?? null,
  };
}

async function freeBytes() {
  try {
    const st = await fs.statfs(storageDir());
    return st.bavail * st.bsize;
  } catch {
    return Infinity;
  }
}

export async function usedBytes() {
  const { rows } = await pool.query("SELECT COALESCE(sum(size_bytes), 0)::bigint AS n FROM library_clips WHERE file_state = 'active'");
  return Number(rows[0].n);
}

async function checkDisk(size) {
  const cfg = libraryConfig();
  if ((await usedBytes()) + (await variantsBytes()) + size > cfg.maxMb * 1024 * 1024) throw new HttpError(507, 'La bibliothèque est pleine pour le moment : réessaie dans quelques jours.');
  if ((await freeBytes()) - size < cfg.minFreeMb * 1024 * 1024) throw new HttpError(507, "Pas assez d'espace libre sur le serveur pour publier ce clip.");
}

async function makePoster(id, duration) {
  const at = Math.min(1, Math.max(0, duration / 3));
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', String(at), '-i', fileOf(id), '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5', posterOf(id)], { timeout: 30_000 });
    return true;
  } catch (e) {
    console.error(`Bibliothèque ${id} : affiche impossible (${e.message})`);
    return false;
  }
}

// Stored as a studio request body so normalizeRequest can replay it
export function storedRequest(req) {
  const { framing: _f, total: _t, outTotal: _o, edits = [], ...rest } = req;
  return { ...rest, edits: Object.fromEntries(edits.map((e) => [String(e.start_ms), e.text])) };
}

async function ownerFileCount(owner) {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM library_clips WHERE owner_key = $1 AND kind = 'clip' AND file_state <> 'archived'", [owner]);
  return rows[0].n;
}

export async function publishFromJob({ job, owner, ip, visibility = 'public', remixOf = null }) {
  if (!job) throw new HttpError(404, 'Clip introuvable ou expiré (les clips sont conservés une heure).');
  if (!job.owner || job.owner !== owner) throw new HttpError(403, "Ce clip n'a pas été créé depuis ce navigateur.");
  if (job.status !== 'done') throw new HttpError(409, "Le clip n'est pas encore prêt.");
  const { rows: existing } = await pool.query('SELECT * FROM library_clips WHERE job_id = $1', [job.id]);
  if (existing[0]) return present(existing[0], owner);
  const cfg = libraryConfig();
  if ((await ownerFileCount(owner)) >= cfg.maxPerOwner) throw new HttpError(429, `Tu as déjà ${cfg.maxPerOwner} clips dans la bibliothèque : retires-en un pour publier celui-ci.`);
  if (!limiter.take(`publish:${owner}`, cfg.publishPerHour) || !limiter.take(`publish:${ipKey(ip)}`, cfg.publishPerHour * 2)) {
    throw new HttpError(429, 'Trop de publications pour le moment : réessaie dans une heure.');
  }
  await checkDisk(job.size ?? 0);
  let remix = null;
  if (remixOf && ID.test(String(remixOf))) {
    const { rows } = await pool.query("SELECT id FROM library_clips WHERE id = $1 AND kind = 'clip'", [remixOf]);
    remix = rows[0]?.id ?? null;
  }
  const id = crypto.randomBytes(12).toString('hex');
  await fs.mkdir(libraryDir(), { recursive: true });
  // A hard link keeps the file when the hourly studio cleanup removes the render
  await fs.link(job.out, fileOf(id)).catch(() => fs.copyFile(job.out, fileOf(id)));
  // le lien garde la date du rendu (jusqu'à 1 h) : sans ça l'épuration des orphelins peut le prendre avant l'INSERT
  const now = new Date();
  await fs.utimes(fileOf(id), now, now);
  const hasPoster = await makePoster(id, job.total);
  try {
    const { rows } = await pool.query(
      `INSERT INTO library_clips (id, owner_key, kind, remix_of, video_id, youtube_id, video_title, job_id, visibility, req, duration_s, quality,
         file_stamp, text_hash, size_bytes, has_poster, file_expires_at)
       VALUES ($1, $2, 'clip', $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, now() + make_interval(days => $16::int))
       ON CONFLICT (job_id) DO NOTHING RETURNING *`,
      [id, owner, remix, job.video.id, job.youtube_id, job.video.title ?? '', job.id, visibility === 'private' ? 'private' : 'public', JSON.stringify(storedRequest(job.req)), job.total,
        job.req.layout.quality, job.video.stamp, job.video.text_hash, job.size ?? 0, hasPoster, cfg.retentionDays],
    );
    if (rows[0]) return present(rows[0], owner);
  } catch (e) {
    await removeFiles(id);
    throw e;
  }
  // Concurrent publish of the same render won the race
  await removeFiles(id);
  const { rows } = await pool.query('SELECT * FROM library_clips WHERE job_id = $1', [job.id]);
  return present(rows[0], owner);
}

async function removeFiles(id, { poster = true } = {}) {
  await fs.rm(fileOf(id), { force: true });
  await fs.rm(noEndOf(id), { force: true });
  if (poster) await fs.rm(posterOf(id), { force: true });
  await removeVariants(id);
}

export async function listPublic({ sort = 'recent', youtube = null, limit = 24, offset = 0, owner = null } = {}) {
  const order = SORTS[sort] ?? SORTS.recent;
  const lim = Math.min(60, Math.max(1, Math.trunc(Number(limit)) || 24));
  const off = Math.min(10_000, Math.max(0, Math.trunc(Number(offset)) || 0));
  const yt = typeof youtube === 'string' && /^[A-Za-z0-9_-]{11}$/.test(youtube) ? youtube : null;
  const [{ rows }, { rows: total }, { rows: interviews }] = await Promise.all([
    pool.query(
      `SELECT c.*, r.stars AS my_rating, v.published_at AS video_published_at FROM library_clips c JOIN videos v ON v.id = c.video_id
       LEFT JOIN library_ratings r ON r.clip_id = c.id AND r.owner_key = $4
       WHERE ${VISIBLE} AND ($1::text IS NULL OR c.youtube_id = $1) ORDER BY ${order}, c.id DESC LIMIT $2 OFFSET $3`,
      [yt, lim, off, owner],
    ),
    pool.query(`SELECT count(*)::int AS n FROM library_clips c JOIN videos v ON v.id = c.video_id WHERE ${VISIBLE} AND ($1::text IS NULL OR c.youtube_id = $1)`, [yt]),
    pool.query(`SELECT c.youtube_id, max(v.title) AS title, count(*)::int AS clips FROM library_clips c JOIN videos v ON v.id = c.video_id WHERE ${VISIBLE} GROUP BY c.youtube_id ORDER BY clips DESC, title LIMIT 100`),
  ]);
  return { clips: rows.map((r) => present(r, owner)), total: total[0].n, interviews };
}

export async function listMine(owner) {
  const { rows } = await pool.query('SELECT * FROM library_clips WHERE owner_key = $1 ORDER BY created_at DESC LIMIT 200', [owner]);
  const originals = rows.filter((r) => r.kind === 'repost').map((r) => r.remix_of);
  const { rows: orig } = originals.length
    ? await pool.query(
      `SELECT c.*, r.stars AS my_rating, v.published_at AS video_published_at FROM library_clips c JOIN videos v ON v.id = c.video_id
       LEFT JOIN library_ratings r ON r.clip_id = c.id AND r.owner_key = $2 WHERE c.id = ANY($1) AND ${VISIBLE}`,
      [originals, owner],
    )
    : { rows: [] };
  const byId = new Map(orig.map((o) => [o.id, o]));
  const clips = rows.map((r) => ({ ...present(r, owner), original: r.kind === 'repost' && byId.get(r.remix_of) ? present(byId.get(r.remix_of), owner) : null }));
  return { clips, active: await ownerFileCount(owner), limit: libraryConfig().maxPerOwner };
}

export async function getClip(id, owner = null) {
  const { rows } = await pool.query(
    `SELECT c.*, r.stars AS my_rating, v.published_at AS video_published_at, (${VISIBLE}) AS visible FROM library_clips c JOIN videos v ON v.id = c.video_id
     LEFT JOIN library_ratings r ON r.clip_id = c.id AND r.owner_key = $2 WHERE c.id = $1`,
    [validId(id), owner],
  );
  const r = rows[0];
  if (!r || !(r.visible || (owner && r.owner_key === owner))) throw new HttpError(404, 'Clip introuvable.');
  return r;
}

export async function mediaClip(id, owner = null) {
  const r = await getClip(id, owner);
  if (r.kind !== 'repost') return r;
  return originalOf(r, owner);
}

// A repost follows its original: gone once the original is private, hidden or withdrawn
async function originalOf(r, owner) {
  const o = await getClip(r.remix_of, owner).catch(() => null);
  if (!o) throw new HttpError(404, "L'original de ce clip a été retiré.");
  return o;
}
export const clipFile = (row) => (row.file_state === 'active' ? fileOf(row.id) : null);
const endCardSeconds = (r) => Number(r.req?.end_card?.dur) || 0;

const cutting = new Map();
// Copy of the clip without its end card, cut without re-encoding and kept next to it (rebuilt when the clip is re-created)
export async function withoutEndCard(row) {
  const file = clipFile(row);
  const keep = Number(row.duration_s) - endCardSeconds(row);
  if (!file || !endCardSeconds(row) || !(keep > 0)) return null;
  const out = noEndOf(row.id);
  const [src, done] = await Promise.all([fs.stat(file).catch(() => null), fs.stat(out).catch(() => null)]);
  if (src && done && done.mtimeMs >= src.mtimeMs) return out;
  if (!cutting.has(row.id)) {
    const tmp = `${out}.tmp.mp4`;
    cutting.set(row.id, run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-t', String(keep), '-map', '0', '-c', 'copy', '-movflags', '+faststart', tmp], { timeout: 60_000 })
      .then(() => fs.rename(tmp, out))
      .catch(async (e) => {
        console.error(`Bibliothèque ${row.id} : coupe de l'écran de fin impossible (${e.message})`);
        await fs.rm(tmp, { force: true });
        throw new HttpError(500, 'Version sans écran de fin indisponible pour le moment : réessaie, ou télécharge la version complète.');
      })
      .finally(() => cutting.delete(row.id)));
  }
  await cutting.get(row.id);
  return out;
}

export const clipPoster = (row) => (row.has_poster ? posterOf(row.id) : null);
export const downloadName = (row) => `lisnard-studio-${row.id.slice(0, 8)}.mp4`;

export async function countDownload(row, { owner, ip }) {
  const hash = owner ? null : visitorHash(ipKey(ip));
  const v = owner ? `o:${owner}` : hash ? `v:${hash}` : null;
  if (!v) return false;
  const { rowCount } = await pool.query('INSERT INTO library_downloads (clip_id, who) VALUES ($1, $2) ON CONFLICT DO NOTHING', [row.id, v]);
  if (rowCount) await pool.query('UPDATE library_clips SET downloads = downloads + 1 WHERE id = $1', [row.id]);
  return rowCount > 0;
}

async function ownClip(id, owner) {
  const { rows } = await pool.query('SELECT * FROM library_clips WHERE id = $1 AND owner_key = $2', [validId(id), owner]);
  if (!rows[0]) throw new HttpError(404, 'Clip introuvable.');
  return rows[0];
}

export async function setVisibility(id, owner, visibility) {
  if (!['public', 'private'].includes(visibility)) throw new HttpError(400, 'Visibilité inconnue.');
  const r = await ownClip(id, owner);
  if (r.kind !== 'clip') throw new HttpError(400, 'Une republication reste dans « Mes clips ».');
  const { rows } = await pool.query('UPDATE library_clips SET visibility = $2, updated_at = now() WHERE id = $1 RETURNING *, (SELECT published_at FROM videos WHERE id = video_id) AS video_published_at', [r.id, visibility]);
  return present(rows[0], owner);
}

async function deleteRows(ids) {
  if (!ids.length) return;
  // Reposts of a removed clip become empty shells: remove them too
  const { rows } = await pool.query("DELETE FROM library_clips WHERE id = ANY($1) OR (kind = 'repost' AND remix_of = ANY($1)) RETURNING id", [ids]);
  for (const r of rows) await removeFiles(r.id);
}

export async function deleteClip(id, owner) {
  const r = await ownClip(id, owner);
  await deleteRows([r.id]);
}

export async function deleteOwnerData(owner) {
  const { rows } = await pool.query('SELECT id FROM library_clips WHERE owner_key = $1', [owner]);
  await deleteRows(rows.map((r) => r.id));
  const { rows: rated } = await pool.query('DELETE FROM library_ratings WHERE owner_key = $1 RETURNING clip_id', [owner]);
  for (const r of rated) await refreshRating(r.clip_id);
  await pool.query('DELETE FROM library_reports WHERE owner_key = $1', [owner]);
  await pool.query('DELETE FROM library_downloads WHERE who = $1', [`o:${owner}`]);
}

async function publicClip(id) {
  const { rows } = await pool.query(`SELECT c.* FROM library_clips c JOIN videos v ON v.id = c.video_id WHERE c.id = $1 AND ${VISIBLE}`, [validId(id)]);
  if (!rows[0]) throw new HttpError(404, 'Clip introuvable.');
  return rows[0];
}

const refreshRating = (id) =>
  pool.query(
    `UPDATE library_clips SET (rating_sum, rating_count) = (SELECT COALESCE(sum(stars), 0)::int, count(*)::int FROM library_ratings WHERE clip_id = $1) WHERE id = $1 RETURNING *`,
    [id],
  );

export async function rate(id, owner, stars, ip) {
  const r = await publicClip(id);
  if (r.owner_key === owner) throw new HttpError(403, 'Tu ne peux pas noter ton propre clip.');
  if (stars === null) await pool.query('DELETE FROM library_ratings WHERE clip_id = $1 AND owner_key = $2', [r.id, owner]);
  else {
    const n = Number(stars);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new HttpError(400, 'La note va de 1 à 5 étoiles.');
    if (!limiter.take(`rate:${owner}`, 120) || !limiter.take(`rate-ip:${ipKey(ip)}`, 60)) throw new HttpError(429, 'Trop de notes pour le moment : réessaie plus tard.');
    await pool.query(
      'INSERT INTO library_ratings (clip_id, owner_key, stars) VALUES ($1, $2, $3) ON CONFLICT (clip_id, owner_key) DO UPDATE SET stars = EXCLUDED.stars, created_at = now()',
      [r.id, owner, n],
    );
  }
  const { rows } = await refreshRating(r.id);
  return present({ ...rows[0], my_rating: stars === null ? null : Number(stars) }, owner);
}

// One report per person and per connection: fresh cookies alone cannot reach the auto-hide threshold
export async function report(id, owner, reason = '', ip = '') {
  const r = await publicClip(id).catch(() => null);
  if (!r || r.owner_key === owner) return;
  if (!limiter.take(`report:${owner}`, 30) || !limiter.take(`report-ip:${ipKey(ip)}`, 20)) return;
  const text = String(reason ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300);
  const { rowCount } = await pool.query(
    `INSERT INTO library_reports (clip_id, owner_key, reason, visitor) SELECT $1, $2, $3, $4
     WHERE NOT EXISTS (SELECT 1 FROM library_reports WHERE clip_id = $1 AND visitor = $4) ON CONFLICT DO NOTHING`,
    [r.id, owner, text, visitorHash(ipKey(ip))],
  );
  if (!rowCount) return;
  const auto = libraryConfig().autohideReports;
  await pool.query('UPDATE library_clips SET reports = reports + 1, hidden = hidden OR ($2::int > 0 AND reports + 1 >= $2::int) WHERE id = $1', [r.id, auto]);
}

export async function repost(id, owner, ip) {
  const r = await publicClip(id);
  if (r.owner_key === owner) throw new HttpError(400, 'Ce clip est déjà le tien.');
  const { rows: found } = await pool.query("SELECT * FROM library_clips WHERE owner_key = $1 AND kind = 'repost' AND remix_of = $2", [owner, r.id]);
  if (found[0]) return present(found[0], owner);
  if (!limiter.take(`repost:${owner}`, 60) || !limiter.take(`repost-ip:${ipKey(ip)}`, 120)) throw new HttpError(429, 'Trop de republications pour le moment : réessaie plus tard.');
  const { rows } = await pool.query(
    `INSERT INTO library_clips (id, owner_key, kind, remix_of, video_id, youtube_id, video_title, visibility, duration_s, quality, file_state, has_poster)
     VALUES ($1, $2, 'repost', $3, $4, $5, $6, 'private', $7, $8, 'archived', FALSE) RETURNING *`,
    [crypto.randomBytes(12).toString('hex'), owner, r.id, r.video_id, r.youtube_id, r.video_title, r.duration_s, r.quality],
  );
  return present(rows[0], owner);
}

export async function clipRequest(id, owner) {
  const r = await getClip(id, owner);
  const src = r.kind === 'repost' ? await originalOf(r, owner) : r;
  if (!src.req) throw new HttpError(404, "Les réglages de ce clip ne sont plus disponibles.");
  return { id: src.id, youtube_id: src.youtube_id, req: src.req };
}

async function loadClippable(videoId) {
  const { rows } = await pool.query(`SELECT ${COLS} FROM videos v WHERE v.id = $1 AND ${CLIPPABLE}`, [videoId]);
  if (!rows[0]) throw new HttpError(404, "Cette interview n'est plus disponible dans le studio.");
  return rows[0];
}

export async function recreate(id, owner, ip) {
  const r = await getClip(id, owner);
  if (r.kind !== 'clip') throw new HttpError(400, "Recrée l'original de ce clip.");
  if (r.file_state !== 'archived') return present(r, owner);
  const video = await loadClippable(r.video_id);
  if (stampOf(video) !== r.file_stamp) {
    throw new HttpError(409, "L'interview a été remplacée depuis : ouvre ce clip dans l'éditeur pour le refaire.", { edit: true });
  }
  await checkDisk(Number(r.size_bytes) || 0);
  await ensureMusic();
  const request = normalizeRequest(r.req, video);
  request.framing = await framingForRequest(video, request);
  const { rowCount } = await pool.query("UPDATE library_clips SET file_state = 'pending', updated_at = now() WHERE id = $1 AND file_state = 'archived'", [r.id]);
  if (!rowCount) return present((await pool.query('SELECT * FROM library_clips WHERE id = $1', [r.id])).rows[0], owner);
  try {
    await enqueueRender({ video, req: request, lines: await linesOf(video.id), ip, onDone: (job) => adoptRender(r.id, job) });
  } catch (e) {
    await pool.query("UPDATE library_clips SET file_state = 'archived' WHERE id = $1 AND file_state = 'pending'", [r.id]);
    throw e;
  }
  return present({ ...r, file_state: 'pending' }, owner);
}

async function adoptRender(id, job) {
  if (job.status !== 'done') {
    await pool.query("UPDATE library_clips SET file_state = 'archived' WHERE id = $1 AND file_state = 'pending'", [id]);
    return;
  }
  await fs.mkdir(libraryDir(), { recursive: true });
  await fs.rename(job.out, fileOf(id)).catch(() => fs.copyFile(job.out, fileOf(id)));
  await removeVariants(id); // nouveau fichier canonique : les variantes, dérivées de l'ancien, sont invalidées
  const hasPoster = (await fs.stat(posterOf(id)).then(() => true, () => false)) || (await makePoster(id, job.total));
  const { rowCount } = await pool.query(
    `UPDATE library_clips SET file_state = 'active', file_version = file_version + 1, size_bytes = $2, has_poster = $3,
       file_expires_at = now() + make_interval(days => $4::int), updated_at = now() WHERE id = $1 AND file_state = 'pending'`,
    [id, job.size ?? 0, hasPoster, libraryConfig().retentionDays],
  );
  if (!rowCount) await removeFiles(id, { poster: false }); // deleted while rendering
}

export async function libraryMaintenance(now = Date.now()) {
  const { rows: expired } = await pool.query(
    "UPDATE library_clips SET file_state = 'archived', updated_at = now() WHERE file_state = 'active' AND file_expires_at < to_timestamp($1 / 1000.0) RETURNING id",
    [now],
  );
  for (const r of expired) {
    await fs.rm(fileOf(r.id), { force: true });
    await fs.rm(noEndOf(r.id), { force: true });
    await removeVariants(r.id);
  }
  await pool.query("UPDATE library_clips SET file_state = 'archived' WHERE file_state = 'pending' AND updated_at < to_timestamp($1 / 1000.0) - interval '30 minutes'", [now]);
  const names = await fs.readdir(libraryDir()).catch(() => []);
  if (names.length) {
    const { rows } = await pool.query('SELECT id, file_state FROM library_clips WHERE id = ANY($1)', [[...new Set(names.map((n) => n.split('.')[0]).filter((id) => /^[0-9a-f]{24}$/.test(id)))]]);
    const state = new Map(rows.map((r) => [r.id, r.file_state]));
    for (const name of names) {
      const st = await fs.stat(path.join(libraryDir(), name)).catch(() => null);
      if (!st?.isFile()) continue; // « variants » est un sous-dossier : son propre entretien (sweepVariants)
      const [id, ext] = name.split('.');
      const keep = ext === 'jpg' ? state.has(id) : name.endsWith('.tmp.mp4') ? false : state.get(id) === 'active' || state.get(id) === 'pending';
      if (keep) continue;
      if (now - st.mtimeMs > 3600_000) await fs.rm(path.join(libraryDir(), name), { force: true });
    }
  }
  // variantes gardées seulement pour les clips dont le fichier existe : un clip archivé ne garde pas d'empreintes
  const { rows: active } = await pool.query("SELECT id FROM library_clips WHERE file_state = 'active'");
  await sweepVariants(new Set(active.map((r) => r.id)));
  return { expired: expired.length };
}

let maintenanceTimer;
export function startLibraryMaintenance() {
  libraryMaintenance().catch((e) => console.error(`Bibliothèque : ${e.message}`));
  maintenanceTimer ??= setInterval(() => libraryMaintenance().catch((e) => console.error(`Bibliothèque : ${e.message}`)), 10 * 60 * 1000).unref();
}

const ADMIN_FILTERS = {
  recent: 'TRUE',
  reported: 'c.reports > 0',
  hidden: 'c.hidden OR EXISTS (SELECT 1 FROM library_hidden_owners h WHERE h.owner_key = c.owner_key)',
  archived: "c.file_state = 'archived'",
};

export async function libraryOverview({ filter = 'recent', limit = 50, offset = 0 } = {}) {
  const where = ADMIN_FILTERS[filter] ?? ADMIN_FILTERS.recent;
  const lim = Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 50));
  const off = Math.max(0, Math.trunc(Number(offset)) || 0);
  const { rows } = await pool.query(
    `SELECT c.*, EXISTS (SELECT 1 FROM library_hidden_owners h WHERE h.owner_key = c.owner_key) AS owner_hidden,
       (SELECT json_agg(json_build_object('reason', x.reason, 'at', x.created_at) ORDER BY x.created_at DESC) FROM (SELECT * FROM library_reports WHERE clip_id = c.id ORDER BY created_at DESC LIMIT 5) x) AS report_list
     FROM library_clips c WHERE c.kind = 'clip' AND (${where}) ORDER BY ${filter === 'reported' ? 'c.reports DESC, ' : ''}c.created_at DESC LIMIT $1 OFFSET $2`,
    [lim, off],
  );
  const { rows: counts } = await pool.query(
    `SELECT count(*) FILTER (WHERE kind = 'clip')::int AS clips, count(*) FILTER (WHERE kind = 'clip' AND visibility = 'public')::int AS public,
       count(*) FILTER (WHERE kind = 'clip' AND file_state = 'active')::int AS active, count(*) FILTER (WHERE kind = 'clip' AND reports > 0)::int AS reported,
       count(*) FILTER (WHERE hidden)::int AS hidden, count(DISTINCT owner_key)::int AS owners, COALESCE(sum(downloads), 0)::int AS downloads
     FROM library_clips`,
  );
  const cfg = libraryConfig();
  return {
    clips: rows.map((r) => ({ ...present(r), owner: r.owner_key, owner_short: r.owner_key.slice(0, 8), owner_hidden: r.owner_hidden, reports: r.reports, report_list: r.report_list ?? [] })),
    counts: counts[0],
    disk: { used: await usedBytes(), max: cfg.maxMb * 1024 * 1024, free: Number.isFinite(await freeBytes()) ? await freeBytes() : null },
    config: cfg,
  };
}

export async function adminPoster(id) {
  const { rows } = await pool.query('SELECT id, has_poster FROM library_clips WHERE id = $1', [validId(id)]);
  return rows[0]?.has_poster ? posterOf(rows[0].id) : null;
}

export async function adminSetHidden(id, hidden) {
  const { rowCount } = await pool.query('UPDATE library_clips SET hidden = $2, updated_at = now() WHERE id = $1', [validId(id), hidden]);
  if (!rowCount) throw new HttpError(404, 'Clip introuvable.');
}

export async function adminSetOwnerHidden(owner, hidden) {
  if (!/^[0-9a-f]{32}$/.test(String(owner))) throw new HttpError(400, 'Auteur inconnu.');
  if (hidden) await pool.query('INSERT INTO library_hidden_owners (owner_key) VALUES ($1) ON CONFLICT DO NOTHING', [owner]);
  else await pool.query('DELETE FROM library_hidden_owners WHERE owner_key = $1', [owner]);
}

export async function adminArchive(id) {
  const { rows } = await pool.query("UPDATE library_clips SET file_state = 'archived', updated_at = now() WHERE id = $1 AND kind = 'clip' RETURNING id", [validId(id)]);
  if (!rows[0]) throw new HttpError(404, 'Clip introuvable.');
  await fs.rm(fileOf(rows[0].id), { force: true });
  await removeVariants(rows[0].id);
}

export async function adminDelete(id) {
  await deleteRows([validId(id)]);
}

export async function adminClearReports(id) {
  await pool.query('DELETE FROM library_reports WHERE clip_id = $1', [validId(id)]);
  await pool.query('UPDATE library_clips SET reports = 0 WHERE id = $1', [id]);
}
