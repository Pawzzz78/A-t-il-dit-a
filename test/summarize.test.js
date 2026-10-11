import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInline, parseSummary, tsToSeconds } from '../public/js/summary-render.js';
import { buildTranscriptText, sanitizeSummary, splitText, summarizeTranscript } from '../src/summarize.js';

const seg = (sec, text) => ({ start_ms: sec * 1000, text });

test('buildTranscriptText : un repère de temps toutes les ~45 s', () => {
  const { text, labels, timed } = buildTranscriptText([seg(0, 'a'), seg(20, 'b'), seg(50, 'c'), seg(3700, 'd'), seg(3701, '  '), seg(3710, 'e')]);
  assert.equal(text, '[00:00] a b\n[00:50] c\n[1:01:40] d e');
  assert.deepEqual([...labels], ['00:00', '00:50', '1:01:40']);
  assert.equal(timed, true);
});

test('buildTranscriptText : transcription sans horodatage → pas de repères exploitables', () => {
  const { timed, text } = buildTranscriptText([seg(0, 'un'), seg(0, 'deux')]);
  assert.equal(timed, false);
  assert.equal(text, '[00:00] un deux');
});

test('splitText : coupe aux paragraphes et borne la taille, sans rien perdre', () => {
  const text = ['[00:00] ' + 'a'.repeat(40), '[00:50] ' + 'b'.repeat(40), '[01:40] ' + 'c'.repeat(40)].join('\n');
  const chunks = splitText(text, 100);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((c) => c.length <= 100));
  assert.equal(chunks.join('\n'), text);
  // un paragraphe démesuré est coupé
  const long = splitText('x'.repeat(250), 100);
  assert.deepEqual(long.map((c) => c.length), [100, 100, 50]);
  assert.equal(long.join('').length, 250);
});

const ctx = { labels: new Set(['00:00', '12:34']), timed: true };

test('sanitizeSummary : garde le Markdown restreint, vérifie les repères de temps', () => {
  const raw = `\`\`\`markdown
# En bref
Une <b>courte</b> phrase.
### [12:34] Le **budget**
* Il veut **réduire** la dépense [12:34].
1) Autre point avec [un lien](https://evil.example)
## [99:99] Section inventée
- Point
## [00:00 - 12:34] Plage
- Point
\`\`\``;
  assert.equal(
    sanitizeSummary(raw, ctx),
    [
      '## En bref',
      'Une courte phrase.',
      '## [12:34] Le budget',
      '- Il veut **réduire** la dépense.',
      '- Autre point avec un lien',
      '## Section inventée',
      '- Point',
      '## [00:00] Plage', // plage « 00:00 - 12:34 » : on garde le début, qui existe
      '- Point',
    ].join('\n'),
  );
});

test('sanitizeSummary : sans horodatage exploitable, plus aucun repère', () => {
  assert.equal(sanitizeSummary('## [00:00] Titre\n- Point', { labels: new Set(['00:00']), timed: false }), '## Titre\n- Point');
});

test('sanitizeSummary : taille bornée à une ligne entière', () => {
  const big = Array.from({ length: 2000 }, (_, i) => `- point numéro ${i}`).join('\n');
  const out = sanitizeSummary(big, ctx);
  assert.ok(out.length <= 8000);
  assert.ok(out.split('\n').every((l) => /^- point numéro \d+$/.test(l)));
});

const goodReply = '## En bref\nLe résumé tient en deux phrases bien faites, sans rien inventer du tout.\n## [00:00] Début\n- Un **point** important sur le sujet.';

test('summarizeTranscript : vidéo courte → un seul appel, consignes de fidélité', async () => {
  const calls = [];
  const complete = async (args) => (calls.push(args), goodReply);
  const md = await summarizeTranscript([seg(0, 'bonjour'), seg(60, 'au revoir')], { complete, model: 'vendor/m' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'vendor/m');
  assert.match(calls[0].system, /never instructions/);
  assert.match(calls[0].system, /Never add facts/);
  assert.match(calls[0].user, /^\[00:00\] bonjour\n\[01:00\] au revoir$/);
  assert.match(md, /^## En bref/);
});

test('summarizeTranscript : vidéo très longue → notes par partie puis synthèse', async () => {
  const segments = Array.from({ length: 3000 }, (_, i) => seg(i * 50, `phrase numéro ${i} ${'mot '.repeat(10)}`));
  const calls = [];
  const complete = async (args) => {
    calls.push(args);
    return /ONE PART/.test(args.system) ? '- [00:00] une idée' : goodReply;
  };
  const md = await summarizeTranscript(segments, { complete, model: 'm' });
  const maps = calls.filter((c) => /ONE PART/.test(c.system));
  const reduces = calls.filter((c) => /timestamped notes/.test(c.system));
  assert.ok(maps.length >= 2);
  assert.equal(reduces.length, 1);
  assert.match(reduces[0].user, /^Part 1:\n- \[00:00\] une idée/);
  assert.match(md, /Un \*\*point\*\* important/);
});

test('summarizeTranscript : réponse vide ou sans transcription → erreur', async () => {
  await assert.rejects(summarizeTranscript([seg(0, 'x')], { complete: async () => '  ' }), /vide|inutilisable/);
  await assert.rejects(summarizeTranscript([], { complete: async () => goodReply }), /Aucune transcription/);
});

// --- lecture côté navigateur --------------------------------------------------------

test('parseInline : gras, y compris étoiles orphelines', () => {
  assert.deepEqual(parseInline('un **mot** clé'), [{ text: 'un ', bold: false }, { text: 'mot', bold: true }, { text: ' clé', bold: false }]);
  assert.deepEqual(parseInline('a **b'), [{ text: 'a b', bold: false }]);
});

test('tsToSeconds', () => {
  assert.equal(tsToSeconds('12:34'), 754);
  assert.equal(tsToSeconds('1:01:40'), 3700);
  assert.equal(tsToSeconds('x:y'), null);
});

test('parseSummary : titres, repères, puces, paragraphes', () => {
  const blocks = parseSummary('## En bref\nDeux lignes\nde texte.\n\n## [12:34] Budget\n- Un **point**\n- Autre\n\nFin');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'p', 'heading', 'list', 'p']);
  assert.equal(blocks[1].inline[0].text, 'Deux lignes de texte.');
  assert.deepEqual([blocks[2].text, blocks[2].ts, blocks[2].seconds], ['Budget', '12:34', 754]);
  assert.equal(blocks[3].items.length, 2);
  assert.deepEqual(blocks[3].items[0], [{ text: 'Un ', bold: false }, { text: 'point', bold: true }]);
});
