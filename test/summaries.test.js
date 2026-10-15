// Résumés automatiques et « Dernières vidéos » (nécessite Postgres via DATABASE_URL, sinon ignorés).
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

const enabled = Boolean(process.env.DATABASE_URL);
const P = 'SUMtest_';
const id = (n) => `${P}${String(n).padStart(3, '0')}`;
let db;
let svc;
let auto;
let settings;
let LlmError;

const REPLY = '## En bref\nLe résumé de la vidéo, en deux phrases courtes et fidèles au texte.\n## [00:00] Début\n- Un **point** clé.';
const counting = (reply = REPLY, delay = 0) => {
  const f = async () => {
    f.calls += 1;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return reply;
  };
  f.calls = 0;
  return f;
};
const failing = (message = 'boom secret', code = 'upstream') => {
  const f = async () => {
    f.calls += 1;
    throw new LlmError(message, code);
  };
  f.calls = 0;
  return f;
};
const addVideo = async (n, { published = null, texts = ['bonjour à tous', 'merci'], source = 'manual', translated = false, duration = null, aged = true } = {}) => {
  const { rows } = await db.pool.query(
    `INSERT INTO videos (youtube_id, title, channel, published_at, source, lang, translated, duration_s) VALUES ($1, $2, 'Chaîne', $3, $4, 'fr', $5, $6) RETURNING id`,
    [id(n), `Vidéo ${n}`, published, source, translated, duration],
  );
  if (texts) await db.withTransaction((c) => db.replaceSegments(c, rows[0].id, texts.map((text, i) => ({ start_ms: i * 60000, text }))));
  if (aged) await age(rows[0].id);
  return rows[0].id;
};
/** Vieillit la dernière modification : le délai de grâce avant résumé est écoulé. */
const age = (vid) => db.pool.query(`UPDATE videos SET updated_at = now() - interval '1 hour' WHERE id = $1`, [vid]);
const cycle = (complete, extra = {}) => auto.runSummaryCycle({ complete, idPrefix: P, ...extra });
const stored = async (n) =>
  (await db.pool.query('SELECT s.content, s.source_hash, s.model FROM video_summaries s JOIN videos v ON v.id = s.video_id WHERE v.youtube_id = $1', [id(n)])).rows[0];
const vrow = async (n) => (await db.pool.query('SELECT * FROM videos WHERE youtube_id = $1', [id(n)])).rows[0];
const err = async (p) => p.then(() => null, (e) => e);

before(async () => {
  if (!enabled) return;
  process.env.OPENROUTER_API_KEY ||= 'test-key';
  db = await import('../src/db.js');
  svc = await import('../src/summaries.js');
  auto = await import('../src/auto-summaries.js');
  settings = await import('../src/settings.js');
  ({ LlmError } = await import('../src/openrouter.js'));
  await db.initDb();
});
const resetSettings = async () => {
  await settings.setSetting('summaries_paused', false);
  await settings.setSetting('summary_cooldown_until', null);
  await settings.setSetting('llm_last_error', null);
};
beforeEach(async () => {
  if (!enabled) return;
  svc.resetSummaryState();
  auto.resetAutoSummaryState();
  await resetSettings();
  await db.pool.query(`DELETE FROM videos WHERE youtube_id LIKE '${P}%'`);
});
after(async () => {
  if (!enabled) return;
  await resetSettings();
  await db.pool.query(`DELETE FROM videos WHERE youtube_id LIKE '${P}%'`);
  await db.pool.end();
});

test('auto : une vidéo transcrite reçoit son résumé en arrière-plan, une seule fois', { skip: !enabled }, async () => {
  await addVideo(1);
  const complete = counting();
  const r = await cycle(complete);
  assert.equal(r.done, 1);
  assert.equal(complete.calls, 1);
  const s = await stored(1);
  assert.match(s.content, /^## En bref/);
  assert.match(s.source_hash, /^[0-9a-f]{32}:v\d+$/);
  assert.equal(s.source_hash.split(':')[0], (await vrow(1)).text_hash);
  // deuxième passe : rien à faire
  assert.equal((await cycle(complete)).done, 0);
  assert.equal(complete.calls, 1);
});

test('auto : seules les vidéos indexées sont résumées (ni Short, ni sans transcription)', { skip: !enabled }, async () => {
  await addVideo(1, { published: '2099-01-01' });
  await addVideo(2, { published: '2099-03-01' });
  await addVideo(3, { published: '2099-04-01', texts: null }); // pas transcrite
  await addVideo(4, { published: '2099-05-01', duration: 40 }); // Short
  const complete = counting();
  const r = await cycle(complete);
  assert.equal(r.done, 2);
  assert.ok((await stored(1)) && (await stored(2)));
  assert.ok(!(await stored(3)) && !(await stored(4)));
  const o = await auto.summariesOverview();
  assert.ok(o.ready >= 2);
});

test('auto : la plus récente est traitée en premier, dans la limite par passe', { skip: !enabled }, async () => {
  await addVideo(1, { published: '2099-01-01' });
  await addVideo(2, { published: '2099-03-01' });
  await addVideo(3, { published: '2099-02-01' });
  const complete = counting();
  assert.equal((await cycle(complete, { perCycle: 1 })).done, 1);
  assert.ok(await stored(2));
  assert.ok(!(await stored(1)) && !(await stored(3)));
  await cycle(complete, { perCycle: 1 });
  assert.ok(await stored(3)); // puis la suivante
  assert.ok(!(await stored(1)));
});

test('auto : délai de grâce après une modification', { skip: !enabled }, async () => {
  const vid = await addVideo(1, { aged: false });
  const complete = counting();
  assert.equal((await cycle(complete)).done, 0); // vient d'être modifiée : on attend
  assert.equal(complete.calls, 0);
  await age(vid);
  assert.equal((await cycle(complete)).done, 1);
  // le bouton « Lancer maintenant » ignore le délai
  const v2 = await addVideo(2, { aged: false });
  assert.equal((await cycle(complete, { graceMinutes: 0 })).done, 1);
  assert.ok(v2 && (await stored(2)));
});

test('auto : un résumé existant n\'est JAMAIS refait, même si la transcription est corrigée ensuite', { skip: !enabled }, async () => {
  const vid = await addVideo(1);
  const complete = counting();
  await cycle(complete);
  const first = await stored(1);
  await db.withTransaction((c) => db.replaceSegments(c, vid, [{ start_ms: 0, text: 'texte corrigé à la main' }], { edited: true }));
  await age(vid);
  for (let i = 0; i < 3; i++) assert.equal((await cycle(complete)).done, 0); // on ne repasse pas en boucle
  assert.equal(complete.calls, 1);
  assert.equal((await stored(1)).content, first.content);
  const o = await auto.summariesOverview();
  assert.ok(o.ready >= 1);
});

test('auto : un résumé écrit avec d\'anciennes consignes (ou sans empreinte) n\'est pas refait', { skip: !enabled }, async () => {
  const vid = await addVideo(1);
  const old = '## En bref\nL\'invité estime que tout va bien, et il le dit longuement ici.';
  await db.pool.query(
    `INSERT INTO video_summaries (video_id, content, model, source_hash)
     SELECT id, $2, 'm', text_hash || ':v0' FROM videos WHERE id = $1`,
    [vid, old],
  );
  const complete = counting();
  for (let i = 0; i < 2; i++) assert.equal((await cycle(complete)).done, 0);
  assert.equal(complete.calls, 0);
  assert.equal((await stored(1)).content, old);
  // seule la régénération explicite de l'admin le remplace
  await svc.regenerateNow(vid, { complete });
  assert.doesNotMatch((await stored(1)).content, /invité/);
  assert.equal(complete.calls, 1);
});

test('auto : échec → nouvelle tentative espacée, abandon après 5 essais, « Réessayer » remet à zéro', { skip: !enabled }, async () => {
  await addVideo(1);
  const down = failing('boom secret');
  const r = await cycle(down);
  assert.equal(r.failed, 1);
  let v = await vrow(1);
  assert.equal(v.summary_attempts, 1);
  assert.match(v.summary_error, /boom secret/);
  assert.ok(new Date(v.summary_next_at) > new Date(Date.now() + 25 * 60_000)); // ~30 min
  assert.equal((await cycle(down)).failed, 0); // trop tôt : pas de nouvelle tentative
  assert.equal(down.calls, 1);
  // la vraie raison est mémorisée pour l'admin
  const last = await settings.getSetting('llm_last_error', null);
  assert.equal(last.feature, 'résumé');
  assert.match(last.message, /boom secret/);

  // 5 tentatives : la vidéo est abandonnée
  await db.pool.query(`UPDATE videos SET summary_attempts = 4, summary_next_at = NULL WHERE youtube_id = $1`, [id(1)]);
  await cycle(down);
  v = await vrow(1);
  assert.equal(v.summary_attempts, 5);
  await db.pool.query(`UPDATE videos SET summary_next_at = NULL WHERE youtube_id = $1`, [id(1)]);
  const calls = down.calls;
  await cycle(down);
  assert.equal(down.calls, calls);
  const overview = await auto.summariesOverview();
  assert.ok(overview.failed_list.some((f) => f.id === v.id));

  // l'admin relance
  assert.equal(await auto.retrySummary(v.id), true);
  assert.equal((await cycle(counting())).done, 1);
  v = await vrow(1);
  assert.deepEqual([v.summary_attempts, v.summary_next_at, v.summary_error], [0, null, null]);
});

test('auto : crédits épuisés ou clé refusée → la passe s\'arrête et la génération est suspendue', { skip: !enabled }, async () => {
  await addVideo(1, { published: '2099-02-01' });
  await addVideo(2, { published: '2099-01-01' });
  const out = failing('crédits épuisés', 'quota');
  const r = await cycle(out);
  assert.equal(r.stopped.code, 'quota');
  assert.equal(out.calls, 1); // pas d'acharnement sur la seconde vidéo
  const until = new Date(await settings.getSetting('summary_cooldown_until', null));
  assert.ok(until > new Date(Date.now() + 50 * 60_000));
  assert.equal((await vrow(1)).summary_attempts, 0); // la vidéo n'est pas pénalisée : le problème est général
  // suspendu : la passe suivante ne fait rien
  const ok = counting();
  assert.match((await cycle(ok)).skipped, /suspendu/);
  assert.equal(ok.calls, 0);
  const overview = await auto.summariesOverview();
  assert.ok(overview.cooldown_until);
});

test('auto : trois échecs d\'affilée arrêtent la passe', { skip: !enabled }, async () => {
  for (let n = 1; n <= 5; n++) await addVideo(n, { published: `2099-0${n}-01` });
  const down = failing('indisponible');
  const r = await cycle(down);
  assert.equal(r.failed, 3);
  assert.equal(r.stopped.code, 'streak');
  assert.equal(down.calls, 3);
});

test('auto : en pause, sans clé, ou au-delà du plafond quotidien → rien n\'est généré', { skip: !enabled }, async () => {
  await addVideo(1, { published: '2099-02-01' });
  await addVideo(2, { published: '2099-01-01' });
  const complete = counting();

  await settings.setSetting('summaries_paused', true);
  assert.equal((await cycle(complete)).skipped, 'en pause');
  assert.equal(await auto.summariesActive(), false);
  await settings.setSetting('summaries_paused', false);
  assert.equal(await auto.summariesActive(), true);

  const key = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    assert.match((await auto.runSummaryCycle({ idPrefix: P })).skipped, /clé/);
    assert.equal(await auto.summariesActive(), false);
  } finally {
    process.env.OPENROUTER_API_KEY = key;
  }
  assert.equal(complete.calls, 0);

  process.env.SUMMARY_DAILY_CAP = '1';
  try {
    const r = await cycle(complete);
    assert.equal(r.done, 1);
    assert.equal(r.stopped.code, 'cap');
    assert.equal(complete.calls, 1);
  } finally {
    delete process.env.SUMMARY_DAILY_CAP;
  }
});

test('auto : deux passes simultanées ne génèrent qu\'une fois', { skip: !enabled }, async () => {
  await addVideo(1);
  const complete = counting(REPLY, 100);
  const [a, b] = await Promise.all([cycle(complete), cycle(complete)]);
  assert.equal(complete.calls, 1);
  assert.equal((a.done ?? 0) + (b.done ?? 0), 1);
  assert.ok([a, b].some((r) => r.skipped === 'déjà en cours')); // l'autre passe a vu le verrou
});

test('auto : un nouveau transcript remet les tentatives à zéro et enregistre l\'empreinte', { skip: !enabled }, async () => {
  const vid = await addVideo(1);
  await cycle(failing());
  assert.equal((await vrow(1)).summary_attempts, 1);
  await db.withTransaction((c) => db.replaceSegments(c, vid, [{ start_ms: 0, text: 'Nouveau texte, corrigé' }], { edited: true }));
  const v = await vrow(1);
  assert.deepEqual([v.summary_attempts, v.summary_next_at, v.summary_error], [0, null, null]);
  assert.match(v.text_hash, /^[0-9a-f]{32}$/);
  // transcription vidée : plus d'empreinte, plus de résumé à produire
  await db.withTransaction((c) => db.replaceSegments(c, vid, []));
  assert.equal((await vrow(1)).text_hash, null);
});

test('édition manuelle : résumé corrigé à la main, protégé de la régénération automatique', { skip: !enabled }, async () => {
  const vid = await addVideo(1);
  await cycle(counting());
  const auto0 = await stored(1);
  const e = await svc.saveEditedSummary(vid, '## En bref\nUn résumé <b>corrigé</b> à la main par l\'équipe, [avec un lien](http://x.y).\n## [01:00] Une section\n- Un **point** corrigé.');
  assert.doesNotMatch(e.markdown, /<b>|http/); // même nettoyage que le résumé IA
  assert.match(e.markdown, /## \[01:00\] Une section/); // le repère écrit par l'admin est conservé
  let s = await stored(1);
  assert.equal(s.model, 'manuel');
  assert.notEqual(s.content, auto0.content);
  assert.equal((await db.pool.query('SELECT edited_at FROM video_summaries WHERE video_id = $1', [vid])).rows[0].edited_at !== null, true);

  // la génération automatique ne le touche pas
  const complete = counting();
  assert.equal((await cycle(complete)).done, 0);
  assert.equal(complete.calls, 0);
  // une génération qui se termine après l'édition ne l'écrase pas non plus
  const v = { id: vid, youtube_id: id(1), text_hash: (await vrow(1)).text_hash };
  assert.equal((await svc.generateSummary(v, { complete })).skipped, 'résumé déjà présent');
  const callsAfterRace = complete.calls;
  assert.equal((await stored(1)).content, s.content);

  // il reste en place, même si la transcription est corrigée ensuite
  await db.withTransaction((c) => db.replaceSegments(c, vid, [{ start_ms: 0, text: 'transcription corrigée' }], { edited: true }));
  assert.match((await stored(1)).content, /corrigé/);
  await age(vid);
  assert.equal((await cycle(complete)).done, 0);
  assert.equal(complete.calls, callsAfterRace); // le travail de fond n'a rien tenté
  assert.ok((await auto.summariesOverview()).ready >= 1);

  // « Régénérer » le remplace, et il redevient un résumé automatique
  await svc.regenerateNow(vid, { complete: counting() });
  s = await stored(1);
  assert.notEqual(s.model, 'manuel');
  assert.equal((await db.pool.query('SELECT edited_at FROM video_summaries WHERE video_id = $1', [vid])).rows[0].edited_at, null);
});

test('édition manuelle : sur une vidéo sans résumé, et erreurs claires', { skip: !enabled }, async () => {
  const vid = await addVideo(1);
  await addVideo(2, { texts: null });
  const e = await svc.saveEditedSummary(vid, '## En bref\nRésumé écrit entièrement à la main, avant tout travail de l\'IA.');
  assert.match(e.markdown, /^## En bref/);
  const complete = counting();
  assert.equal((await cycle(complete)).done, 0); // plus rien à résumer automatiquement
  assert.equal((await err(svc.saveEditedSummary(vid, '   '))).status, 400);
  assert.equal((await err(svc.saveEditedSummary(vid, 'x'.repeat(20000)))).status, 400);
  assert.equal((await err(svc.saveEditedSummary(999999999, 'Un texte assez long pour être valide.'))).status, 404);
  assert.equal((await err(svc.saveEditedSummary((await vrow(2)).id, 'Un texte assez long pour être valide.'))).status, 409);
  assert.equal((await stored(1)).content, e.markdown); // les refus n'abîment rien
});

test('régénération manuelle : remplace le résumé tout de suite, erreurs claires', { skip: !enabled }, async () => {
  const vid = await addVideo(1);
  await addVideo(2, { texts: null });
  const first = await svc.regenerateNow(vid, { complete: counting('## En bref\nPremière version du résumé, assez longue pour passer.\n## [00:00] A\n- **x**') });
  const second = await svc.regenerateNow(vid, { complete: counting() });
  assert.notEqual(first.markdown, second.markdown);
  assert.equal((await stored(1)).content, second.markdown);
  assert.equal((await err(svc.regenerateNow(999999999, { complete: counting() }))).status, 404);
  assert.equal((await err(svc.regenerateNow((await vrow(2)).id, { complete: counting() }))).status, 409);
  const e = await err(svc.regenerateNow(vid, { complete: failing() }));
  assert.ok(e instanceof LlmError);
  assert.equal((await stored(1)).content, second.markdown); // l'ancien résumé n'est pas perdu
});

test('génération : deux demandes simultanées sur la même vidéo ne font qu\'un appel au modèle', { skip: !enabled }, async () => {
  const vid = await addVideo(1);
  const complete = counting(REPLY, 80);
  const video = { id: vid, youtube_id: id(1), text_hash: (await vrow(1)).text_hash };
  const results = await Promise.all([1, 2, 3].map(() => svc.generateSummary(video, { complete })));
  assert.equal(complete.calls, 1);
  assert.equal(new Set(results.map((r) => r.markdown)).size, 1);
});

test('YouTube : fetchVideoMeta lit titre, chaîne, date et durée', async () => {
  const { fetchVideoMeta } = await import('../src/youtube.js');
  const realFetch = globalThis.fetch;
  const savedKey = process.env.YOUTUBE_API_KEY;
  process.env.YOUTUBE_API_KEY = 'test-key';
  let seenUrl;
  globalThis.fetch = async (url) => {
    seenUrl = String(url);
    return { ok: true, status: 200, json: async () => ({ items: [{ id: 'abcdefghijk', snippet: { title: 'Un titre', channelTitle: 'Une chaîne', channelId: 'UC1', publishedAt: '2026-10-09T12:34:56Z', liveBroadcastContent: 'none', thumbnails: { high: { url: 'https://img/x.jpg' } } }, contentDetails: { duration: 'PT1H2M3S' } }] }) };
  };
  try {
    const m = await fetchVideoMeta('abcdefghijk');
    assert.match(seenUrl, /youtube\/v3\/videos\?.*id=abcdefghijk/);
    assert.deepEqual(
      [m.title, m.channel, m.published_at, m.duration_s, m.thumbnail_url, m.channel_id],
      ['Un titre', 'Une chaîne', '2026-10-09', 3723, 'https://img/x.jpg', 'UC1'],
    );
    delete process.env.YOUTUBE_API_KEY;
    assert.equal(await fetchVideoMeta('abcdefghijk'), null); // sans clé : pas d'appel
  } finally {
    globalThis.fetch = realFetch;
    if (savedKey) process.env.YOUTUBE_API_KEY = savedKey;
    else delete process.env.YOUTUBE_API_KEY;
  }
});

