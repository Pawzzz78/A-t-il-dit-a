// Reads are public; writes need an owner (member in members-only mode, else the anonymous cookie)
import express, { Router } from 'express';
import { HttpError, ah, jsonErrors } from '../http-error.js';
import { createLimiter, ipKey, trimMap } from '../ip.js';
import { membersOnly } from '../members/oidc.js';
import {
  SORTS, clipFile, clipPoster, clipRequest, countDownload, deleteClip, deleteOwnerData, downloadName, getClip, libraryConfig, listMine, listPublic,
  mediaClip, present, withoutEndCard, cardOf, publishFromJob, rate, recreate, report, repost, setVisibility,
} from '../library/library.js';
import { ensureVariant, variantFile, variantState } from '../library/uniq.js';
import { clearOwner, libraryConfigured, optionalOwner, requireOwner } from '../library/owner.js';
import { getJob } from '../studio/render.js';
import { visitorHash } from '../studio/stats.js';

// « Personne » d'une variante : la clé du propriétaire (adhérent ou cookie anonyme), sinon l'empreinte de la connexion
const whoOf = (req) => req.owner?.key || visitorHash(ipKey(req.ip)) || null;

export const libraryRouter = Router();
libraryRouter.use(express.json({ limit: '10kb' }));
libraryRouter.use((_req, res, next) => (libraryConfigured() ? next() : res.status(503).json({ error: "La bibliothèque n'est pas disponible." })));

// One variant per person per clip is cached on disk; this only bounds how fast new encodes are started
const variantLimiter = createLimiter();

// Bytes served per visitor and hour: bounds the bandwidth a scraper can pull
const served = new Map();
const bytesBudgetLeft = (ip) => {
  const rec = served.get(ipKey(ip));
  return !rec || rec.resetAt <= Date.now() || rec.bytes < libraryConfig().bytesPerHourMb * 1024 * 1024;
};
const addBytes = (ip, n) => {
  const key = ipKey(ip);
  const now = Date.now();
  const rec = served.get(key);
  if (!rec || rec.resetAt <= now) {
    served.delete(key);
    served.set(key, { bytes: n, resetAt: now + 3600_000 });
  } else rec.bytes += n;
  trimMap(served, 5000, (r) => r.resetAt <= now);
};
export const resetLibraryRoutes = () => {
  served.clear();
  variantLimiter.clear();
};

libraryRouter.get(
  '/',
  optionalOwner,
  ah(async (req, res) => {
    const sort = String(req.query.sort ?? 'recent');
    if (!Object.hasOwn(SORTS, sort)) throw new HttpError(400, 'Classement inconnu.');
    const list = await listPublic({ sort, youtube: req.query.v ?? null, limit: req.query.limit, offset: req.query.offset, owner: req.owner?.key });
    res.set('Cache-Control', req.owner ? 'private, no-cache' : 'public, max-age=30');
    res.json({ ...list, sort, members_only: membersOnly(), can_write: Boolean(req.owner) || !membersOnly(), retention_days: libraryConfig().retentionDays });
  }),
);

libraryRouter.get(
  '/mine',
  optionalOwner,
  ah(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.owner) return res.json({ clips: [], active: 0, limit: libraryConfig().maxPerOwner });
    res.json(await listMine(req.owner.key));
  }),
);

libraryRouter.get(
  '/clips/:id',
  optionalOwner,
  ah(async (req, res) => {
    const r = await getClip(req.params.id, req.owner?.key);
    const clip = present(r, req.owner?.key);
    if (r.kind === 'repost') clip.original = await mediaClip(r.id, req.owner?.key).then((o) => present(o, req.owner?.key), () => null);
    res.set('Cache-Control', 'no-store');
    res.json(clip);
  }),
);

libraryRouter.get(
  '/clips/:id/request',
  optionalOwner,
  ah(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await clipRequest(req.params.id, req.owner?.key));
  }),
);

libraryRouter.get(
  '/clips/:id/card',
  optionalOwner,
  ah(async (req, res) => {
    const row = await mediaClip(req.params.id, req.owner?.key);
    if (!row.req?.end_card?.image) throw new HttpError(404, "Ce clip n'a pas de visuel de fin.");
    res.sendFile(cardOf(row.id), { headers: { 'Cache-Control': 'private, max-age=3600', 'Content-Type': 'image/jpeg' } }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Visuel introuvable.' });
    });
  }),
);

libraryRouter.get(
  '/clips/:id/poster',
  optionalOwner,
  ah(async (req, res) => {
    const file = clipPoster(await mediaClip(req.params.id, req.owner?.key));
    if (!file) throw new HttpError(404, 'Affiche introuvable.');
    res.sendFile(file, { headers: { 'Cache-Control': 'private, max-age=3600', 'Content-Type': 'image/jpeg' } }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Affiche introuvable.' });
    });
  }),
);

libraryRouter.get(
  '/clips/:id/file',
  optionalOwner,
  ah(async (req, res) => {
    const row = await mediaClip(req.params.id, req.owner?.key);
    const file = clipFile(row);
    if (!file) throw new HttpError(410, 'Ce clip est archivé : recrée-le pour le télécharger.');
    if (!bytesBudgetLeft(req.ip)) throw new HttpError(429, 'Trop de vidéos téléchargées depuis cette connexion : réessaie dans une heure.');
    const socket = req.socket;
    const before = socket.bytesWritten;
    res.on('close', () => addBytes(req.ip, Math.max(0, socket.bytesWritten - before)));
    const download = req.query.use === 'download';
    const noEnd = req.query.end === '0';
    let target = noEnd ? await withoutEndCard(row, req.ip) : file;
    if (!target) throw new HttpError(404, "Ce clip n'a pas d'écran de fin.");
    if (download && noEnd) await countDownload(row, { owner: req.owner?.key, ip: req.ip });
    else if (download) {
      await countDownload(row, { owner: req.owner?.key, ip: req.ip });
      const who = whoOf(req);
      if (who) target = (await variantFile(row.id, who)) ?? file; // la version unique de la personne, sinon l'original
    }
    const headers = { 'Cache-Control': 'private, max-age=3600', 'Content-Type': 'video/mp4' };
    const done = (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Clip introuvable.' });
    };
    if (download) res.download(target, noEnd ? downloadName(row).replace(/\.mp4$/, '-sans-fin.mp4') : downloadName(row), { headers }, done);
    else res.sendFile(target, { acceptRanges: true, headers }, done);
  }),
);

// Version unique par (clip, personne) : une deuxième passe ffmpeg avec des micro-transforms invisibles,
// préparée en arrière-plan à l'ouverture du clip et servie au téléchargement. Le fichier original reste
// toujours servi si la variante n'est pas prête — un téléchargement n'échoue jamais.
libraryRouter.get(
  '/clips/:id/variant',
  optionalOwner,
  ah(async (req, res) => {
    const row = await mediaClip(req.params.id, req.owner?.key);
    if (!clipFile(row)) throw new HttpError(410, 'Ce clip est archivé : recrée-le pour le télécharger.');
    res.set('Cache-Control', 'no-store');
    res.json(await variantState(row.id, whoOf(req)));
  }),
);

libraryRouter.post(
  '/clips/:id/variant',
  optionalOwner,
  ah(async (req, res) => {
    const row = await mediaClip(req.params.id, req.owner?.key);
    const file = clipFile(row);
    if (!file) throw new HttpError(410, 'Ce clip est archivé : recrée-le pour le télécharger.');
    const who = whoOf(req);
    if (!who) return res.json({ state: 'disabled', progress: 0 });
    res.set('Cache-Control', 'no-store');
    const st = await variantState(row.id, who);
    if (['ready', 'queued', 'running'].includes(st.state)) return res.json(st); // rien de nouveau : le quota n'est pas consommé
    if (!variantLimiter.take(`variant:${ipKey(req.ip)}`, 120)) throw new HttpError(429, 'Trop de préparations pour le moment : réessaie plus tard.');
    res.json(await ensureVariant({ id: row.id, who, file, quality: row.quality, durationS: Number(row.duration_s) }));
  }),
);

libraryRouter.post(
  '/clips',
  requireOwner,
  ah(async (req, res) => {
    const job = getJob(String(req.body?.job_id ?? ''));
    const clip = await publishFromJob({ job, owner: req.owner.key, ip: req.ip, visibility: req.body?.visibility, remixOf: req.body?.remix_of ?? null });
    res.status(201).json(clip);
  }),
);

libraryRouter.patch(
  '/clips/:id',
  requireOwner,
  ah(async (req, res) => {
    res.json(await setVisibility(req.params.id, req.owner.key, req.body?.visibility));
  }),
);

libraryRouter.delete(
  '/clips/:id',
  requireOwner,
  ah(async (req, res) => {
    await deleteClip(req.params.id, req.owner.key);
    res.status(204).end();
  }),
);

libraryRouter.post(
  '/clips/:id/repost',
  requireOwner,
  ah(async (req, res) => {
    res.status(201).json(await repost(req.params.id, req.owner.key, req.ip));
  }),
);

libraryRouter.put(
  '/clips/:id/rating',
  requireOwner,
  ah(async (req, res) => {
    res.json(await rate(req.params.id, req.owner.key, req.body?.stars ?? 0, req.ip));
  }),
);

libraryRouter.delete(
  '/clips/:id/rating',
  requireOwner,
  ah(async (req, res) => {
    res.json(await rate(req.params.id, req.owner.key, null, req.ip));
  }),
);

// Always 204: the reporter learns nothing about the clip or other reports
libraryRouter.post(
  '/clips/:id/report',
  requireOwner,
  ah(async (req, res) => {
    await report(req.params.id, req.owner.key, req.body?.reason, req.ip);
    res.status(204).end();
  }),
);

libraryRouter.post(
  '/clips/:id/recreate',
  requireOwner,
  ah(async (req, res) => {
    res.status(202).json(await recreate(req.params.id, req.owner.key, req.ip));
  }),
);

libraryRouter.delete(
  '/mine',
  requireOwner,
  ah(async (req, res) => {
    await deleteOwnerData(req.owner.key);
    if (!req.owner.member) clearOwner(req, res);
    res.status(204).end();
  }),
);

libraryRouter.use(jsonErrors());
