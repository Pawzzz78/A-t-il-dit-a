import { Router } from 'express';
import { pool } from '../db.js';
import { HttpError } from '../http-error.js';

export const publicRouter = Router();

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

publicRouter.get(
  '/health',
  ah(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }),
);

// eslint-disable-next-line no-unused-vars
publicRouter.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  console.error(err);
  res.status(500).json({ error: 'Erreur interne.' });
});
