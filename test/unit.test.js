import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildIndex, normalize, normalizeWithMap } from '../src/normalize.js';
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

test('admin : les valeurs d\'exemple (change-me…) comptent comme non configurées', async () => {
  const { authConfigured } = await import('../src/auth.js');
  const saved = { pw: process.env.ADMIN_PASSWORD, secret: process.env.SESSION_SECRET };
  try {
    Object.assign(process.env, { ADMIN_PASSWORD: 'change-me', SESSION_SECRET: 'x'.repeat(32) });
    assert.equal(authConfigured(), false);
    Object.assign(process.env, { ADMIN_PASSWORD: 'pw-test', SESSION_SECRET: 'change-me-too-with-32-random-chars-or-more' });
    assert.equal(authConfigured(), false);
    Object.assign(process.env, { ADMIN_PASSWORD: 'pw-test', SESSION_SECRET: 'x'.repeat(32) });
    assert.equal(authConfigured(), true);
  } finally {
    for (const [k, v] of [['ADMIN_PASSWORD', saved.pw], ['SESSION_SECRET', saved.secret]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
