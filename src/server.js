import express from 'express';
import { authConfigured } from './auth.js';
import { initDb } from './db.js';
import { adminRouter } from './routes/admin.js';
import { publicRouter } from './routes/public.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY',
    });
    next();
  });

  const publicDir = new URL('../public', import.meta.url).pathname;
  app.use('/api/admin', express.json({ limit: '10mb' }), adminRouter);
  app.use('/api', publicRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Route inconnue.' }));
  app.use(express.static(publicDir, { extensions: ['html'], maxAge: '5m' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Erreur interne.' });
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await initDb();
  if (!authConfigured()) {
    console.warn('ADMIN_PASSWORD / SESSION_SECRET (16+ caractères) manquants : l\'admin est désactivée.');
  }
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`A-t-il dit ça ? → http://localhost:${port}`));
}
