import { Router } from 'express';
import { HttpError, ah } from '../http-error.js';
import { adminArchive, adminPoster, adminClearReports, adminDelete, adminSetHidden, adminSetOwnerHidden, libraryOverview } from '../library/library.js';

export const libraryAdminRouter = Router();

libraryAdminRouter.get(
  '/',
  ah(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await libraryOverview({ filter: String(req.query.filter ?? 'recent'), limit: req.query.limit, offset: req.query.offset }));
  }),
);

libraryAdminRouter.get(
  '/clips/:id/poster',
  ah(async (req, res) => {
    const file = await adminPoster(req.params.id);
    if (!file) throw new HttpError(404, 'Affiche introuvable.');
    res.sendFile(file, { headers: { 'Cache-Control': 'private, max-age=3600', 'Content-Type': 'image/jpeg' } });
  }),
);

libraryAdminRouter.patch(
  '/clips/:id',
  ah(async (req, res) => {
    await adminSetHidden(req.params.id, req.body?.hidden === true);
    res.json({ ok: true });
  }),
);

libraryAdminRouter.put(
  '/owners/:key',
  ah(async (req, res) => {
    await adminSetOwnerHidden(req.params.key, req.body?.hidden === true);
    res.json({ ok: true });
  }),
);

libraryAdminRouter.delete(
  '/clips/:id/file',
  ah(async (req, res) => {
    await adminArchive(req.params.id);
    res.json({ ok: true });
  }),
);

libraryAdminRouter.delete(
  '/clips/:id/reports',
  ah(async (req, res) => {
    await adminClearReports(req.params.id);
    res.json({ ok: true });
  }),
);

libraryAdminRouter.delete(
  '/clips/:id',
  ah(async (req, res) => {
    await adminDelete(req.params.id);
    res.json({ ok: true });
  }),
);
