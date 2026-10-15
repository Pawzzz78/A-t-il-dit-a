import { Router } from 'express';
import { pool } from '../db.js';
import { ah, jsonErrors } from '../http-error.js';

export const publicRouter = Router();


publicRouter.get(
  '/health',
  ah(async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  }),
);

publicRouter.use(jsonErrors());
