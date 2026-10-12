// Cœur du studio (partagé entre l'aperçu du navigateur et le rendu serveur) : horaires des mots, groupes, styles, ASS.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_STYLE,
  PRESETS,
  activeAt,
  assColor,
  assEscape,
  assTime,
  bannerText,
  buildAss,
  fitScale,
  usableWidth,
  groupWords,
  lineSimilarity,
  SIMILARITY_WARNING,
  sanitizeStyle,
  wordsForExtracts,
} from '../public/js/studio-core.js';

const FONTS = ['anton', 'montserrat', 'inter'];
const lines = [
  { start_ms: 0, end_ms: 4000, text: 'Un deux trois quatre cinq six sept huit neuf dix.' },
  { start_ms: 4000, end_ms: 6000, text: 'Et puis, voilà' },
  { start_ms: 10000, end_ms: 13000, text: 'Une autre phrase plus loin' },
];
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('style : valeurs bornées, couleurs et police validées, retour aux valeurs du style choisi', () => {
  const s = sanitizeStyle({ preset: 'karaoke', size: 9999, outline: -5, color: 'rouge', highlight: '#abcdef', font: 'inconnue', x: 7, y: -1, boxOpacity: 3, mode: 'bizarre', wordsPerGroup: 50 }, FONTS);
  assert.deepEqual([s.preset, s.mode, s.size, s.outline, s.color, s.highlight, s.font], ['karaoke', 'karaoke', 220, 0, PRESETS.karaoke.style.color, '#ABCDEF', 'anton']); // police inconnue, et celle du style absente de la liste : première police
  assert.deepEqual([s.x, s.y, s.boxOpacity, s.wordsPerGroup], [0.9, 0.1, 1, 10]);
  assert.equal(sanitizeStyle(undefined, FONTS).preset, DEFAULT_STYLE.preset);
  assert.equal(sanitizeStyle({ preset: 'un-mot', wordsPerGroup: 4 }, FONTS).wordsPerGroup, 1); // « un mot » = un seul mot
  assert.equal(sanitizeStyle({ preset: 'inexistant' }, FONTS).preset, 'hormozi');
  assert.equal(sanitizeStyle({ font: 'x' }, []).font, 'anton'); // aucune police connue : valeur du style
  assert.equal(sanitizeStyle({ preset: 'boite' }, FONTS).box, true);
});

test('mots : durée d\'une ligne répartie selon la longueur des mots, pause après la ponctuation', () => {
  const { words, duration } = wordsForExtracts(lines, [{ start_ms: 0, end_ms: 6000 }]);
  assert.equal(duration, 6);
  assert.equal(words.length, 10 + 3);
  // monotone, sans chevauchement, borné à la ligne
  words.forEach((w, i) => {
    assert.ok(w.end > w.start);
    if (i) assert.ok(w.start >= words[i - 1].end - 1e-9);
  });
  close(words[0].start, 0);
  close(words[9].end, 4);
  close(words[10].start, 4);
  close(words.at(-1).end, 6);
  assert.ok(words[9].end - words[9].start > words[0].end - words[0].start, 'le mot suivi d\'un point dure plus longtemps (pause)');
  // « puis, » avec sa virgule a un poids supérieur à « Et »
  assert.ok(words[11].end - words[11].start > words[10].end - words[10].start);
});

test('mots : plusieurs extraits bout à bout, lignes coupées aux bornes', () => {
  const { words, duration, segments } = wordsForExtracts(lines, [{ start_ms: 4000, end_ms: 6000 }, { start_ms: 10000, end_ms: 12000 }]);
  assert.equal(duration, 4);
  assert.deepEqual(segments, [{ offset: 0, length: 2 }, { offset: 2, length: 2 }]);
  close(words[0].start, 0);
  close(words[2].end, 2);
  close(words[3].start, 2); // le 2e extrait commence là où finit le 1er
  close(words.at(-1).end, 4); // la ligne de 3 s est coupée à 2 s
  assert.deepEqual(words.map((w) => w.line), [0, 0, 0, 1, 1, 1, 1, 1].slice(0, words.length));
});

test('groupes : par mots, un mot, ou phrase découpée de façon équilibrée', () => {
  const { words } = wordsForExtracts(lines, [{ start_ms: 0, end_ms: 6000 }]);
  const three = groupWords(words, { mode: 'words', wordsPerGroup: 3 });
  assert.deepEqual(three.map((g) => g.words.length), [3, 3, 3, 1, 3]); // la phrase finit au point ; la 2e ligne repart à zéro
  assert.equal(groupWords(words, { mode: 'one', wordsPerGroup: 9 }).length, words.length);
  const phrase = groupWords(words, { mode: 'phrase', wordsPerGroup: 7 });
  assert.deepEqual(phrase.map((g) => g.words.length), [5, 5, 3]); // 10 mots, 7 max -> 5 + 5, équilibrés
  const kara = groupWords(words, { mode: 'karaoke', wordsPerGroup: 10 });
  assert.deepEqual(kara.map((g) => g.words.length), [10, 3]);
  // un groupe reste affiché jusqu'au suivant (pas de clignotement), pas plus de 0,35 s après sa fin naturelle
  for (let i = 0; i < phrase.length - 1; i++) assert.ok(phrase[i].end <= phrase[i + 1].start + 1e-9 && phrase[i].end >= phrase[i].words.at(-1).end);
  const gap = groupWords(wordsForExtracts(lines, [{ start_ms: 4000, end_ms: 6000 }, { start_ms: 10000, end_ms: 13000 }]).words, { mode: 'phrase', wordsPerGroup: 7 });
  close(gap[0].end, gap[0].words.at(-1).end); // le groupe suivant démarre exactement à la fin : aucune pause à combler
});

test('instant donné : groupe et mot actif', () => {
  const { words } = wordsForExtracts(lines, [{ start_ms: 0, end_ms: 6000 }]);
  const groups = groupWords(words, { mode: 'words', wordsPerGroup: 3 });
  const at = activeAt(groups, words[4].start + 0.001);
  assert.equal(at.group.words.length, 3);
  assert.equal(at.group.words[at.active].text, 'cinq');
  assert.equal(activeAt(groups, -1), null);
  assert.equal(activeAt(groups, 99), null);
});

test('couleurs et temps ASS', () => {
  assert.equal(assColor('#FFE600'), '&H0000E6FF');
  assert.equal(assColor('#102030', 128), '&H80302010');
  assert.equal(assColor('pas une couleur'), '&H00FFFFFF');
  assert.equal(assTime(0), '0:00:00.00');
  assert.equal(assTime(3725.678), '1:02:05.68');
  assert.equal(assEscape('a {b} \\c\nd'), 'a b /c d');
});

test('bandeau de source : titre tronqué et date en français', () => {
  assert.equal(bannerText('Mon interview', '2025-03-01'), 'Source : Mon interview · 1 mars 2025');
  assert.match(bannerText('x'.repeat(100), '2025-12-25'), /^Source : x{55}… · 25 décembre 2025$/);
  assert.equal(bannerText('', null), 'Source : interview');
});

const font = { ass_name: 'Anton Regular', banner_name: 'Inter ExtraBold' };
const build = (style, extracts = [{ start_ms: 0, end_ms: 6000 }]) => {
  const st = sanitizeStyle(style, FONTS);
  const { words, duration } = wordsForExtracts(lines, extracts);
  return { st, ass: buildAss({ groups: groupWords(words, st), style: st, font, banner: 'Source : test', duration }), words, duration };
};
const events = (ass) => ass.split('\n').filter((l) => l.startsWith('Dialogue: 0,'));

test('ASS « mots en surbrillance » : un événement par mot, mot actif coloré, pop au début du groupe seulement', () => {
  const { ass, words } = build({ preset: 'hormozi', color: '#FFFFFF', highlight: '#FFE600', size: 90, outline: 11, outlineColor: '#112233' });
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
  assert.match(ass, /Style: Main,Anton Regular,90,&H00FFFFFF,&H00FFFFFF,&H00332211,/);
  const ev = events(ass);
  assert.equal(ev.length, words.length);
  assert.match(ev[0], /\{\\an5\\pos\(540,1190\)\\fscx72/); // y = 0,62 × 1920 ; pop sur le 1er mot du groupe
  assert.match(ev[0], /\{\\1c&H00E6FF&\}UN\{\\1c&HFFFFFF&\} DEUX TROIS$/); // texte en majuscules, mot actif en jaune
  assert.doesNotMatch(ev[1], /fscx72/); // pas de pop sur les mots suivants du même groupe
  assert.match(ev[1], /UN \{\\1c&H00E6FF&\}DEUX\{/);
  assert.match(ass, /Dialogue: 1,0:00:00.00,0:00:06.00,Banner,,0,0,0,,\{\\an8\\pos\(540,150\)\}Source : test/);
});

test('ASS karaoké : un événement par phrase, durées \\k en centisecondes qui couvrent tout le groupe', () => {
  const { ass } = build({ preset: 'karaoke', wordsPerGroup: 10, uppercase: false, color: '#FFFFFF', highlight: '#25F4EE' });
  assert.match(ass, /Style: Main,[^,]+,66,&H00EEF425,&H00FFFFFF,/); // rempli = accent, avant = couleur du texte
  const ev = events(ass);
  assert.equal(ev.length, 2);
  const ks = [...ev[0].matchAll(/\\k(\d+)\}/g)].map((m) => Number(m[1]));
  assert.equal(ks.length, 10);
  const total = ks.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 400 - 35) <= 40 && total >= 395, `somme des \\k : ${total}`); // 4 s de parole + maintien éventuel
  assert.match(ev[0], /\{\\k\d+\}Un \{\\k\d+\}deux/);
});

test('ASS fond sombre et position : bandeau opaque, largeur adaptée au bord', () => {
  const { ass } = build({ preset: 'boite', boxColor: '#000000', boxOpacity: 0.5, size: 60, x: 0.2, y: 0.9 });
  assert.match(ass, /,&H80000000,&H5A000000,0,0,0,0,100,100,0,0,3,17,0,5,324,324,0,1/); // BorderStyle 3, marge de 324 = (1080 − 0,4 × 1080) / 2
  assert.match(events(ass)[0], /\\pos\(216,1728\)/);
  const centered = build({ preset: 'classique' }).ass;
  assert.match(centered, /,0,0,0,0,100,100,0,0,1,8,2,5,76,76,0,1/); // contour simple, largeur 86 % : marges de 76 px
});

test('ASS : texte sans accolades ni antislash, majuscules facultatives', () => {
  const evil = [{ start_ms: 0, end_ms: 3000, text: 'Un {\\fs500} mot\\Nsuite' }];
  const st = sanitizeStyle({ preset: 'classique', uppercase: false }, FONTS);
  const { words, duration } = wordsForExtracts(evil, [{ start_ms: 0, end_ms: 3000 }]);
  const ass = buildAss({ groups: groupWords(words, st), style: st, font, banner: 'Source : {x}', duration });
  const ev = events(ass)[0];
  assert.equal((ev.match(/\{/g) ?? []).length, 1, 'une seule balise de style : celle du programme'); // aucune balise injectée par le texte
  assert.doesNotMatch(ass, /\{\\fs500/);
  assert.doesNotMatch(ass, /Source : \{x\}/);
  assert.match(ev, /Un \/fs500 mot\/Nsuite/);
});

test('taille : la taille de l\'éditeur est une taille d\'em, convertie en taille ASS selon la police', () => {
  const st = sanitizeStyle({ preset: 'classique', size: 60 }, FONTS);
  const { words, duration } = wordsForExtracts(lines, [{ start_ms: 0, end_ms: 6000 }]);
  const ass = (f) => buildAss({ groups: groupWords(words, st), style: st, font: f, banner: 'x', duration });
  assert.match(ass({ ass_name: 'F', em_ratio: 0.5 }), /Style: Main,F,120,/); // em de 60 px avec un rapport de 0,5 : taille ASS 120
  assert.match(ass({ ass_name: 'F', em_ratio: 1 }), /Style: Main,F,60,/);
  assert.match(ass({ ass_name: 'F' }), /Style: Main,F,60,/); // police sans rapport connu : pas de conversion
});

test('mot trop long : réduit pour ne jamais déborder de l\'écran, aperçu et rendu identiques', () => {
  const font = { cap_em: 0.8 };
  const st = sanitizeStyle({ preset: 'un-mot', size: 128 }, FONTS); // majuscules, 86 % de 1080 = 929 px utilisables
  assert.equal(usableWidth(st), 0.86 * 1080);
  assert.equal(fitScale(['MOT'], st, font), 1);
  const k = fitScale(['DÉCENTRALISATION'], st, font);
  assert.ok(k < 0.7 && k >= 0.45, `k = ${k}`);
  const estimate = 16 * 128 * 0.8 * 0.98 * k + st.outline * 2;
  assert.ok(estimate <= usableWidth(st) + 1, 'le mot réduit tient dans la largeur');
  assert.equal(fitScale(['x'.repeat(200)], st, font), 0.45); // plancher
  // près d'un bord, la largeur utilisable diminue
  assert.ok(usableWidth(sanitizeStyle({ preset: 'un-mot', x: 0.15 }, FONTS)) < usableWidth(st));
  // dans le fichier ASS : \fscx/\fscy réduits, et le « pop » part de 72 % de la taille réduite
  const g = [{ start: 0, end: 1, words: [{ text: 'décentralisation', start: 0, end: 1, line: 0 }] }];
  const ass = buildAss({ groups: g, style: st, font: { ass_name: 'F', cap_em: 0.8 }, banner: 'x', duration: 1 });
  const m = events(ass)[0].match(/\\fscx(\d+)\\fscy\d+\\t\(0,90,\\fscx(\d+)\\fscy\d+\)\\t\(90,170,\\fscx(\d+)/);
  assert.ok(m, events(ass)[0]);
  assert.deepEqual([Number(m[1]), Number(m[3])], [Math.round(72 * k), Math.round(100 * k)]);
  const short = buildAss({ groups: [{ start: 0, end: 1, words: [{ text: 'oui', start: 0, end: 1, line: 0 }] }], style: sanitizeStyle({ preset: 'classique' }, FONTS), font: { ass_name: 'F', cap_em: 0.8 }, banner: 'x', duration: 1 });
  assert.doesNotMatch(events(short)[0], /fscx/); // mot court : aucune réduction
});

test('fidélité : la similarité d\'une ligne corrigée ignore casse, accents et ponctuation', () => {
  const o = 'Il faut baisser la dépense publique, maintenant.';
  assert.equal(lineSimilarity(o, 'IL FAUT BAISSER LA DEPENSE PUBLIQUE MAINTENANT'), 1);
  assert.ok(lineSimilarity(o, 'Il faut baisser la dépense publique maintenant mais') > SIMILARITY_WARNING); // un mot ajouté : pas d\'alerte
  assert.ok(lineSimilarity(o, 'Il faut baisser les dépenses publiques maintenant') > SIMILARITY_WARNING); // quelques mots corrigés : pas d\'alerte
  assert.ok(lineSimilarity(o, 'Je suis contre toute réforme') < SIMILARITY_WARNING); // un autre propos : alerte
  assert.equal(lineSimilarity('', ''), 1);
  assert.equal(lineSimilarity(o, ''), 0);
  assert.equal(lineSimilarity('', o), 0);
});

test('texte corrigé : les mots gardent l\'horodatage de la ligne, quel que soit leur nombre', () => {
  for (const text of ['Oui', 'Un deux trois quatre cinq six sept huit neuf dix onze douze treize']) {
    const edited = lines.map((l, i) => (i === 0 ? { ...l, text } : l));
    const { words } = wordsForExtracts(edited, [{ start_ms: 0, end_ms: 4000 }]);
    assert.equal(words.length, text.split(' ').length);
    close(words[0].start, 0);
    close(words.at(-1).end, 4);
    for (let i = 1; i < words.length; i++) close(words[i].start, words[i - 1].end); // sans trou ni chevauchement
  }
});
