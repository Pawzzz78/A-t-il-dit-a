// Choix des extraits par le LLM : horaires issus de la transcription, durées contrôlées, aucune invention
// (la partie base de données nécessite Postgres via DATABASE_URL, sinon ignorée).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { CLIP_LIMITS, buildClip, mergeClips, parseClipJson, prepareSegments, windowsFor } from '../src/clip-suggestions.js';
import { LlmError } from '../src/openrouter.js';

/** n segments de `step` secondes, texte « phrase i ». */
const rows = (n, step = 5, extra = '') => Array.from({ length: n }, (_, i) => ({ start_ms: i * step * 1000, duration_ms: step * 1000, text: `phrase ${i} ${extra}`.trim() }));

test('segments : fins estimées sans chevauchement, longues pauses écartées', () => {
  const segs = prepareSegments([
    { start_ms: 0, duration_ms: 6000, text: 'a' }, // empiéterait sur la suivante (à 4 s)
    { start_ms: 4000, duration_ms: 1000, text: ' b ' },
    { start_ms: 40000, text: 'c' }, // sans durée, suivie d'une longue pause : elle s'arrête 8 s après son début
    { start_ms: 41000, text: '   ' }, // vide : ignorée
    { start_ms: 50000, text: 'd' }, // dernière : durée par défaut
  ]);
  assert.deepEqual(segs.map((s) => [s.start_ms, s.end_ms, s.text]), [[0, 4000, 'a'], [4000, 5000, 'b'], [40000, 48000, 'c'], [50000, 54000, 'd']]);
});

test('tranches : une seule pour une transcription courte, chevauchement pour une longue', () => {
  const segs = prepareSegments(rows(50));
  assert.deepEqual(windowsFor(segs), [[0, 49]]);
  const w = windowsFor(prepareSegments(rows(400, 5, 'x'.repeat(180))), 20_000);
  assert.ok(w.length >= 4);
  assert.equal(w[0][0], 0);
  assert.equal(w.at(-1)[1], 399);
  for (let i = 1; i < w.length; i++) assert.ok(w[i][0] <= w[i - 1][1] && w[i][0] > w[i - 1][0], 'les tranches se chevauchent et avancent');
});

test('réponse du modèle : JSON tolérant, erreur claire sinon', () => {
  assert.equal(parseClipJson('```json\n{"clips":[{"start":1,"end":5}]}\n```').length, 1);
  assert.equal(parseClipJson('Voici : {"clips":[]} merci').length, 0);
  assert.equal(parseClipJson('{"autre":1}').length, 0);
  for (const bad of ['', 'pas de json', '{"clips": [oups}']) assert.throws(() => parseClipJson(bad), LlmError);
});

test('extrait : horaires de la transcription, durée contrôlée, titre nettoyé', () => {
  const segs = prepareSegments(rows(60)); // 60 lignes de 5 s
  const win = [0, 59];
  const ok = buildClip({ start: 4, end: 11, title: '  <b>Il parle de la dette</b> !!  ', why: 'Une idée complète', score: 14 }, segs, win);
  assert.deepEqual([ok.start_ms, ok.end_ms, ok.duration_s, ok.title, ok.score], [20000, 60000, 40, 'Il parle de la dette', 10]);
  assert.equal(ok.text.split(' phrase ').length > 1, true);
  assert.equal(buildClip({ start: 11, end: 4, title: 'x' }, segs, win).start_ms, 20000); // bornes inversées : remises dans l'ordre
  assert.equal(buildClip({ start: 4, end: 11, title: '!!!' }, segs, win), null); // pas de titre
  assert.equal(buildClip({ start: 'a', end: 3, title: 'x' }, segs, win), null);
  assert.equal(buildClip({ start: 0, end: 70, title: 'x' }, segs, win), null); // hors transcription
  assert.equal(buildClip({ start: 2, end: 9, title: 'x' }, segs, [5, 20]), null); // hors de la tranche envoyée
  // trop long : écarté plutôt que coupé n'importe où
  assert.equal(buildClip({ start: 0, end: 30, title: 'trop long' }, segs, win), null);
  // légèrement trop court : prolongé jusqu'à la durée minimale
  const short = buildClip({ start: 10, end: 12, title: 'court' }, segs, win);
  assert.ok(short.duration_s >= CLIP_LIMITS.minS && short.duration_s <= CLIP_LIMITS.maxS);
  assert.equal(short.start_ms, 50000);
  // beaucoup trop court et rien à prolonger : écarté
  assert.equal(buildClip({ start: 58, end: 59, title: 'fin' }, segs, win), null);
});

test('fusion : meilleure note d\'abord, pas de chevauchement, nombre borné', () => {
  const c = (start_ms, end_ms, score) => ({ start_ms, end_ms, score });
  const merged = mergeClips([c(0, 30000, 6), c(20000, 50000, 9), c(60000, 90000, 5), c(100000, 130000, 7)]);
  assert.deepEqual(merged.map((m) => m.score), [9, 7, 5]);
  assert.equal(mergeClips(Array.from({ length: 20 }, (_, i) => c(i * 100000, i * 100000 + 30000, 5))).length, CLIP_LIMITS.maxSuggestions);
});

// --- avec la base de données ----------------------------------------------------------

const enabled = Boolean(process.env.DATABASE_URL);
const YT = 'CSGtest_001';
let db;
let svc;
let videoId;

before(async () => {
  if (!enabled) return;
  db = await import('../src/db.js');
  svc = await import('../src/clip-suggestions.js');
  await db.initDb();
  await db.pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  const r = await db.pool.query(`INSERT INTO videos (youtube_id, title, source, lang) VALUES ($1, 'Vidéo test', 'manual', 'fr') RETURNING id`, [YT]);
  videoId = r.rows[0].id;
});
after(async () => {
  if (!enabled) return;
  await db.pool.query('DELETE FROM videos WHERE youtube_id = $1', [YT]);
  await db.pool.end();
});
const setSegments = (data) => db.withTransaction((c) => db.replaceSegments(c, videoId, data));

test('génération : extraits stockés avec les horaires de la transcription, consignes éditoriales envoyées', { skip: !enabled }, async () => {
  await setSegments(rows(60));
  let seen;
  const complete = async (req) => {
    seen = req;
    return '{"clips":[{"start":4,"end":11,"title":"Sa position sur la dette","why":"Argument complet","score":8},{"start":20,"end":27,"title":"Les communes","why":"Exemple concret","score":9},{"start":22,"end":29,"title":"Chevauche le précédent","why":"x","score":3}]}';
  };
  const out = await svc.generateClipSuggestions(videoId, { complete, model: 'faux-modèle' });
  assert.deepEqual(out.clips.map((c) => [c.title, c.start_ms, c.end_ms]), [['Les communes', 100000, 140000], ['Sa position sur la dette', 20000, 60000]]);
  assert.match(seen.system, /David Lisnard/);
  assert.match(seen.system, /pas pour le caractère polémique/);
  assert.match(seen.system, /ne modifie aucun mot/);
  assert.match(seen.user, /^\[0\] 00:00 phrase 0/); // lignes numérotées avec repère de temps
  const stored = await svc.getClipSuggestions(videoId);
  assert.deepEqual([stored.clips.length, stored.model, stored.outdated], [2, 'faux-modèle', false]);

  // la transcription change : les extraits sont signalés comme périmés
  await setSegments(rows(60, 5, 'corrigé'));
  assert.equal((await svc.getClipSuggestions(videoId)).outdated, true);
});

test('génération : tranches multiples pour une longue transcription, erreurs claires', { skip: !enabled }, async () => {
  await setSegments(rows(500, 5, 'mot '.repeat(60))); // environ 120 000 caractères : plusieurs tranches
  const calls = [];
  const complete = async (req) => {
    const first = Number(req.user.match(/^\[(\d+)\]/)[1]);
    calls.push(first);
    return JSON.stringify({ clips: [{ start: first + 2, end: first + 9, title: `Extrait ${first}`, why: 'ok', score: 5 }] });
  };
  const out = await svc.generateClipSuggestions(videoId, { complete });
  assert.ok(calls.length >= 3, `${calls.length} appels`);
  assert.ok(out.clips.length >= 3);
  assert.ok(out.clips.every((c, i, a) => a.every((d, j) => i === j || c.end_ms <= d.start_ms || d.end_ms <= c.start_ms)));

  await assert.rejects(svc.generateClipSuggestions(videoId, { complete: async () => 'rien de lisible' }), LlmError);
  await assert.rejects(svc.generateClipSuggestions(videoId, { complete: async () => '{"clips":[{"start":499,"end":499,"title":"trop court"}]}' }), /aucun extrait utilisable/);
  await assert.rejects(svc.generateClipSuggestions(999999999, { complete }), (e) => e.status === 404);
  await setSegments([]);
  await assert.rejects(svc.generateClipSuggestions(videoId, { complete }), (e) => e.status === 409);
  await setSegments(rows(2));
  await assert.rejects(svc.suggestClipsFor(rows(2), { complete }), (e) => e.status === 409); // transcription trop courte
});

test('modèle des extraits : propre aux extraits, jamais celui des résumés / traductions', async () => {
  const { clipModel, DEFAULT_CLIP_MODEL } = await import('../src/clip-suggestions.js');
  const keep = { clip: process.env.CLIP_MODEL, translate: process.env.TRANSLATE_MODEL, summary: process.env.SUMMARY_MODEL };
  try {
    process.env.TRANSLATE_MODEL = 'deepseek/deepseek-v4.1-flash';
    process.env.SUMMARY_MODEL = 'deepseek/deepseek-v4.1-flash';
    delete process.env.CLIP_MODEL;
    assert.equal(clipModel(), DEFAULT_CLIP_MODEL);
    assert.doesNotMatch(clipModel(), /deepseek/);
    process.env.CLIP_MODEL = 'google/gemini-2.5-flash-lite';
    assert.equal(clipModel(), 'google/gemini-2.5-flash-lite');
    process.env.CLIP_MODEL = '';
    assert.equal(clipModel(), DEFAULT_CLIP_MODEL); // variable vide : modèle par défaut
  } finally {
    for (const [k, v] of Object.entries({ CLIP_MODEL: keep.clip, TRANSLATE_MODEL: keep.translate, SUMMARY_MODEL: keep.summary })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('le modèle est invité à proposer jusqu\'à 10 extraits par tranche', async () => {
  const { suggestClipsFor } = await import('../src/clip-suggestions.js');
  assert.equal(CLIP_LIMITS.maxSuggestions, 10);
  const seen = [];
  const complete = async ({ system }) => {
    seen.push(Number(/jusqu'à (\d+) extraits/.exec(system)[1]));
    return '{"clips":[]}';
  };
  await suggestClipsFor(rows(240, 5), { complete, model: 'x' });
  assert.deepEqual(seen, [10]);
});
