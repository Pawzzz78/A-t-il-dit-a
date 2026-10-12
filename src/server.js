import express from 'express';
import { authConfigured } from './auth.js';
import { initDb } from './db.js';
import { ffmpegAvailable, storageDir } from './media.js';
import { adminRouter } from './routes/admin.js';
import { publicRouter } from './routes/public.js';
import { studioRouter } from './routes/studio.js';
import { startStudioCleanup, studioCapabilities } from './studio/render.js';
import { startSummaryScheduler } from './auto-summaries.js';
import { startScheduler } from './sync.js';

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
  app.use('/api/studio', studioRouter);
  app.use('/api', publicRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Route inconnue.' }));
  app.use(
    express.static(publicDir, {
      extensions: ['html'],
      setHeaders: (res, file) => {
        // Polices : immuables. Le reste (pages, JS, CSS) est revalidé à chaque visite pour que les mises à jour
        // s'affichent tout de suite (réponse 304 sans corps si rien n'a changé).
        res.setHeader('Cache-Control', file.endsWith('.woff2') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );

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
  createApp().listen(port, () => console.log(`Lisnard Facts → http://localhost:${port}`));
  ffmpegAvailable().then(async (ok) => {
    const cap = ok ? await studioCapabilities() : null;
    console.log(`Studio de clips : ffmpeg ${ok ? 'disponible' : 'ABSENT (dépôt de vidéos impossible)'}${cap ? ` · sous-titres (libass) ${cap.ass ? 'oui' : 'NON'} · H.264 ${cap.x264 ? 'oui' : 'NON'} · AAC ${cap.aac ? 'oui' : 'NON'} · zooms et images ${cap.zoom ? 'oui' : 'NON'}` : ''} · stockage ${storageDir()}`);
  });
  startScheduler();
  startSummaryScheduler();
  startStudioCleanup();
}
