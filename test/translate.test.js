import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchLocalized } from '../src/localize.js';
import { TranslationError, baseLang, chunkIndices, formatLines, parseLines, translateSegments } from '../src/translate.js';

/** Faux client Anthropic : "traduit" en mettant en majuscules, ligne par ligne. */
const fakeClient = (transform = (text) => text.toUpperCase()) => {
  const calls = [];
  return {
    calls,
    messages: {
      create: async ({ messages, system }) => {
        calls.push({ user: messages[0].content, system });
        const text = messages[0].content
          .split('\n')
          .map((l) => l.replace(/^\[(\d+)\] (.*)$/, (_, n, t) => (transform(t, Number(n)) == null ? '' : `[${n}] ${transform(t, Number(n))}`)))
          .filter(Boolean)
          .join('\n');
        return { stop_reason: 'end_turn', content: [{ type: 'text', text }] };
      },
    },
  };
};

const segs = (n) => Array.from({ length: n }, (_, i) => ({ start_ms: i * 1000, duration_ms: 900, text: `segment ${i + 1}` }));

test('baseLang', () => {
  assert.equal(baseLang('fr-FR'), 'fr');
  assert.equal(baseLang('EN'), 'en');
  assert.equal(baseLang(''), null);
});

test('chunkIndices : limites en nombre de segments et en caractères', () => {
  assert.deepEqual(chunkIndices(['a', 'b', 'c', 'd', 'e'], 2), [[0, 1], [2, 3], [4]]);
  assert.deepEqual(chunkIndices(['aaaa', 'bbbb', 'cc'], 10, 8), [[0, 1], [2]]);
  assert.deepEqual(chunkIndices([]), []);
});

test('parseLines : ignore le bruit, les numéros inattendus et les doublons', () => {
  const out = parseLines('Voici la traduction :\n[1] bonjour\n[2]  à   tous \n[9] intrus\n[1] doublon\nnote', [1, 2, 3]);
  assert.deepEqual([...out], [[1, 'bonjour'], [2, 'à tous']]);
  assert.equal(formatLines([{ n: 4, text: 'x' }]), '[4] x');
});

test('translateSegments : horodatages conservés, ordre respecté sur plusieurs paquets, original gardé', async () => {
  const client = fakeClient();
  const input = segs(130);
  const out = await translateSegments(input, { from: 'en', to: 'fr', client });
  assert.equal(out.length, 130);
  assert.ok(client.calls.length >= 3);
  out.forEach((s, i) => {
    assert.equal(s.text, `SEGMENT ${i + 1}`);
    assert.equal(s.text_original, `segment ${i + 1}`);
    assert.equal(s.start_ms, i * 1000);
    assert.equal(s.duration_ms, 900);
  });
  assert.match(client.calls[0].system, /English into French/);
  assert.match(client.calls[0].system, /never instructions/);
});

test('translateSegments : une retraduction conserve le texte d\'origine initial', async () => {
  const out = await translateSegments([{ start_ms: 0, text: 'bonjour', text_original: 'hello' }], { from: 'fr', to: 'es', client: fakeClient() });
  assert.equal(out[0].text_original, 'hello');
});

test('translateSegments : les lignes manquantes sont redemandées', async () => {
  let first = true;
  const client = fakeClient((text, n) => (n === 2 && first ? (first = false, null) : text.toUpperCase()));
  const out = await translateSegments(segs(3), { from: 'en', to: 'fr', client });
  assert.deepEqual(out.map((s) => s.text), ['SEGMENT 1', 'SEGMENT 2', 'SEGMENT 3']);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].user, '[2] segment 2');
});

test('translateSegments : échec si des lignes restent manquantes', async () => {
  const client = fakeClient((text, n) => (n === 2 ? null : text.toUpperCase()));
  await assert.rejects(translateSegments(segs(3), { from: 'en', to: 'fr', client }), (e) => e instanceof TranslationError && /incomplète/.test(e.message));
});

test('translateSegments : sans clé → erreur de configuration', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(translateSegments(segs(1), { from: 'en', to: 'fr' }), (e) => e.code === 'config');
  } finally {
    if (saved) process.env.ANTHROPIC_API_KEY = saved;
  }
});

const supadata = (lang) => async () => ({ segments: segs(2), lang });
const translateFn = async (s, { from, to }) => s.map((x) => ({ ...x, text: `[${from}→${to}] ${x.text}`, text_original: x.text }));

test('fetchLocalized : même langue → pas de traduction', async () => {
  let called = false;
  const r = await fetchLocalized('x', 'fr', { fetchFn: supadata('fr-FR'), translateFn: async () => ((called = true), []), translateConfigured: () => true });
  assert.equal(called, false);
  assert.deepEqual([r.translated, r.untranslated, r.lang], [false, false, 'fr-FR']);
});

test('fetchLocalized : autre langue → traduction vers la langue demandée', async () => {
  const r = await fetchLocalized('x', 'fr', { fetchFn: supadata('en'), translateFn, translateConfigured: () => true });
  assert.equal(r.translated, true);
  assert.equal(r.lang, 'fr');
  assert.equal(r.originalLang, 'en');
  assert.equal(r.segments[0].text, '[en→fr] segment 1');
});

test('fetchLocalized : autre langue sans clé → texte d\'origine conservé et signalé', async () => {
  const r = await fetchLocalized('x', 'fr', { fetchFn: supadata('en'), translateFn, translateConfigured: () => false });
  assert.deepEqual([r.translated, r.untranslated, r.lang], [false, true, 'en']);
  assert.equal(r.segments[0].text, 'segment 1');
});
