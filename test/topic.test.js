// Recherche par sujet de bout en bout (nécessite Postgres via DATABASE_URL, sinon ignorée).
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';

const enabled = Boolean(process.env.DATABASE_URL);
const P = 'TOPICtest_';
const id = (n) => `${P}${n}`;
let db;
let runSearch;
let mergeRanges;
let expandTerms;

const addVideo = async (n, texts, { translated = false } = {}) => {
  const { rows } = await db.pool.query(
    `INSERT INTO videos (youtube_id, title, source, lang, translated, published_at) VALUES ($1, $2, 'manual', 'fr', $3, '2026-01-0${n}') RETURNING id`,
    [id(n), `Vidéo ${n}`, translated],
  );
  await db.withTransaction((c) => db.replaceSegments(c, rows[0].id, texts.map((text, i) => ({ start_ms: i * 5000, text })), { translated }));
};

const fake = (keywords, source = 'llm', intent = 'topic') => {
  const f = async () => ((f.calls += 1), { intent, keywords, source });
  f.calls = 0;
  return f;
};
const marked = (res) => res.results.flatMap((r) => r.matches.flatMap((m) => m.segments.flatMap((s) => s.marks.map(([a, b]) => s.text.slice(a, b).toLowerCase()))));

before(async () => {
  if (!enabled) return;
  db = await import('../src/db.js');
  ({ runSearch, mergeRanges, expandTerms } = await import('../src/routes/public.js'));
  await db.initDb();
});

beforeEach(async () => {
  if (!enabled) return;
  await db.pool.query(`DELETE FROM videos WHERE youtube_id LIKE '${P}%'`);
  await addVideo(1, ['Il faut oser parler de remigration', 'sans tabou et sans caricature.']);
  await addVideo(2, ['Je ne parle pas de la réémigration', 'ce sujet est mal posé.']);
  await addVideo(3, ['Nous parlons de la dette publique.']);
});

after(async () => {
  if (!enabled) return;
  await db.pool.query(`DELETE FROM videos WHERE youtube_id LIKE '${P}%'`);
  await db.pool.end();
});

test('mergeRanges / expandTerms', () => {
  assert.deepEqual(mergeRanges([{ start: 5, end: 9 }, { start: 0, end: 3 }, { start: 8, end: 12 }]), [{ start: 0, end: 3 }, { start: 5, end: 12 }]);
  assert.deepEqual(expandTerms(['Réémigration', 'dette publique', 'ab', 'idées']), ['reemigration', 'reemigrations', 'dette publique', 'idees', 'idee']);
});

test('question : on cherche le mot-clé et ses variantes, pas toute la phrase', { skip: !enabled }, async () => {
  const interpret = fake(['réémigration', 'remigration', 'ré-émigration']);
  const res = await runSearch('est ce que lisnard a deja parlé de réemigration', { interpret });
  assert.equal(res.verdict, 'topic');
  assert.deepEqual(res.interpreted, { intent: 'topic', keywords: ['réémigration', 'remigration', 'ré-émigration'], source: 'llm' });
  const ours = res.results.filter((r) => r.video.youtube_id.startsWith(P));
  assert.deepEqual(ours.map((r) => r.video.youtube_id).sort(), [id(1), id(2)]); // la vidéo sur la dette n'apparaît pas
  assert.deepEqual(marked(res).sort(), ['remigration', 'réémigration']); // la variante d'orthographe est surlignée, pas la question
  assert.equal(res.topic.total_matches >= 2, true);
  assert.equal(interpret.calls, 1);
});

test('question sans modèle : repli sur le mot-clé extrait par règles', { skip: !enabled }, async () => {
  const res = await runSearch('est ce que lisnard a deja parlé de réemigration', { interpret: async () => ({ intent: 'topic', keywords: ['réemigration'], source: 'rules' }) });
  assert.equal(res.verdict, 'topic');
  assert.deepEqual(res.results.map((r) => r.video.youtube_id), [id(2)]); // sans variantes, "remigration" n'est pas vu
});

test('sujet absent : « aucune trace », avec les mots recherchés', { skip: !enabled }, async () => {
  const res = await runSearch('a-t-il déjà parlé de licornes ?', { interpret: fake(['licornes']) });
  assert.equal(res.verdict, 'none');
  assert.deepEqual(res.interpreted.keywords, ['licornes']);
  assert.deepEqual(res.results, []);
});

test('citation mot pour mot : aucun appel au modèle', { skip: !enabled }, async () => {
  const interpret = fake(['x']);
  const res = await runSearch('parler de remigration sans tabou', { interpret });
  assert.equal(res.verdict, 'exact');
  assert.equal(interpret.calls, 0);
});

test('saisie sans forme de question : le modèle peut y voir un sujet, le repli sans modèle non', { skip: !enabled }, async () => {
  const withLlm = await runSearch('la dette selon lisnard', { interpret: fake(['dette publique', 'dette']) });
  assert.equal(withLlm.verdict, 'topic');
  const rulesOnly = await runSearch('la dette selon lisnard', { interpret: async () => ({ intent: 'topic', keywords: ['dette'], source: 'rules' }) });
  assert.equal(rulesOnly.verdict, 'none');
  const quote = await runSearch('on va tout casser et reconstruire', { interpret: fake([], 'llm', 'quote') });
  assert.equal(quote.verdict, 'none');
});

test('citation à forme de question : si le modèle y voit une citation, on retombe sur la recherche de proximité', { skip: !enabled }, async () => {
  const res = await runSearch('il a dit que sans tabou et sans caricature', { interpret: fake([], 'llm', 'quote') });
  assert.equal(res.verdict, 'approx');
});

test('sujet trouvé uniquement dans une traduction → verdict « translated »', { skip: !enabled }, async () => {
  await db.pool.query(`DELETE FROM videos WHERE youtube_id LIKE '${P}%'`);
  await addVideo(4, ['Nous devons parler de remigration.'], { translated: true });
  const res = await runSearch('a-t-il parlé de remigration ?', { interpret: fake(['remigration']) });
  assert.equal(res.verdict, 'translated');
  assert.equal(res.results.every((r) => r.video.translated), true);
});
