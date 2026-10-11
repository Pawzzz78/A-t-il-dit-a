import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex, normalize, normalizeWithMap } from '../src/normalize.js';
import { buildExcerpt, findApprox, findExact, queryTokens } from '../src/search.js';
import { formatTimestamp, parseTimestamp, parseTranscriptText } from '../src/transcripts.js';
import { parseYoutubeId } from '../src/youtube.js';

test('normalize: accents, apostrophes, ponctuation, ligatures', () => {
  assert.equal(normalize("L'économie, c'est QUOI ?"), 'l economie c est quoi');
  assert.equal(normalize('  Cœur —  d’œuvre\n'), 'coeur d oeuvre');
  assert.equal(normalize(''), '');
});

test('normalizeWithMap: la carte pointe vers le texte d\'origine', () => {
  const src = "Été d'or";
  const { text, map } = normalizeWithMap(src);
  assert.equal(text, 'ete d or');
  assert.equal(src[map[text.indexOf('or')]], 'o');
  assert.equal(map.length, text.length);
});

test('buildIndex: offsets cohérents avec le texte joint', () => {
  const segs = [{ text: 'Bonjour à tous' }, { text: '...' }, { text: "c'est Lisnard" }];
  const { normText, offsets } = buildIndex(segs);
  assert.equal(normText, 'bonjour a tous c est lisnard');
  assert.deepEqual(offsets, [0, -1, 15]);
  assert.equal(normText.slice(15), 'c est lisnard');
});

test('findExact respecte les limites de mots', () => {
  const t = 'le mot etat et un etatisme etat';
  assert.deepEqual(findExact(t, 'etat'), [
    { start: 7, end: 11 },
    { start: 27, end: 31 },
  ]);
});

test('findApprox: fenêtre contenant tous les mots, tolérance au pluriel', () => {
  const t = normalize('on doit baisser les impots des francais et simplifier le reste');
  const tokens = queryTokens(normalize('baisser impôt français'));
  const hits = findApprox(t, tokens, 12);
  assert.equal(hits.length, 1);
  assert.equal(t.slice(hits[0].start, hits[0].end), 'baisser les impots des francais');
  assert.deepEqual(findApprox(t, queryTokens(normalize('baisser dette')), 12), []);
});

test('buildExcerpt: surligne une phrase à cheval sur deux segments', () => {
  const raw = [
    { text: 'Je pense que', start_ms: 1000 },
    { text: "l'État doit maigrir.", start_ms: 4000 },
    { text: 'Voilà.', start_ms: 7000 },
  ];
  const { normText, offsets } = buildIndex(raw);
  const segs = raw.map((s, i) => ({ ...s, norm_start: offsets[i] }));
  const [hit] = findExact(normText, normalize('que l’État doit'));
  const ex = buildExcerpt(segs, hit);
  assert.equal(ex.start_ms, 1000);
  assert.equal(ex.segments.length, 3);
  const [a, b] = ex.segments;
  assert.equal(a.text.slice(...a.marks[0]), 'que');
  assert.equal(b.text.slice(...b.marks[0]), "l'État doit");
  assert.deepEqual(ex.segments[2].marks, []);
});

test('parseYoutubeId', () => {
  const id = 'dQw4w9WgXcQ';
  for (const s of [
    id,
    `https://www.youtube.com/watch?v=${id}&t=10s`,
    `youtu.be/${id}?si=abc`,
    `https://m.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
  ]) assert.equal(parseYoutubeId(s), id, s);
  assert.equal(parseYoutubeId('https://example.com/watch?v=' + id), null);
  assert.equal(parseYoutubeId('nope'), null);
});

test('timestamps', () => {
  assert.equal(parseTimestamp('01:02:03,500'), 3723500);
  assert.equal(parseTimestamp('1:02'), 62000);
  assert.equal(parseTimestamp('62.5'), 62500);
  assert.equal(parseTimestamp('abc'), null);
  assert.equal(formatTimestamp(3723500), '1:02:03');
  assert.equal(formatTimestamp(62000), '01:02');
});

test('parseTranscriptText: SRT', () => {
  const srt = `1\n00:00:01,000 --> 00:00:03,500\nBonjour <i>à</i> tous\n\n2\n00:00:03,500 --> 00:00:06,000\nbienvenue\nchez nous\n`;
  assert.deepEqual(parseTranscriptText(srt), [
    { start_ms: 1000, duration_ms: 2500, text: 'Bonjour à tous' },
    { start_ms: 3500, duration_ms: 2500, text: 'bienvenue chez nous' },
  ]);
});

test('parseTranscriptText: VTT avec doublons consécutifs', () => {
  const vtt = `WEBVTT\n\n00:01.000 --> 00:02.000\nsalut\n\n00:02.000 --> 00:03.000\nsalut\n\n00:03.000 --> 00:04.000\nça va\n`;
  assert.deepEqual(
    parseTranscriptText(vtt).map((s) => [s.start_ms, s.text]),
    [[1000, 'salut'], [3000, 'ça va']],
  );
});

test('parseTranscriptText: lignes horodatées et texte brut', () => {
  const stamped = '[00:05] premier\nsuite de la phrase\n1:02:03 deuxième';
  assert.deepEqual(
    parseTranscriptText(stamped).map((s) => [s.start_ms, s.text]),
    [[5000, 'premier suite de la phrase'], [3723000, 'deuxième']],
  );
  assert.deepEqual(
    parseTranscriptText('ligne un\nligne deux').map((s) => [s.start_ms, s.text]),
    [[0, 'ligne un'], [0, 'ligne deux']],
  );
  assert.deepEqual(parseTranscriptText('   '), []);
});
