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
  boxPath,
  sourceText,
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
  // la ligne de 3 s (5 mots) est coupée à 2 s : seuls les mots dits avant la coupure restent, à leur horaire d'origine (pas comprimés)
  const second = words.slice(3);
  assert.ok(second.length >= 3 && second.length < 5, `${second.length} mots gardés`);
  assert.ok(second.at(-1).end <= 4 + 1e-9);
  assert.deepEqual(words.map((w) => w.line), [0, 0, 0, ...second.map(() => 1)]);
});

test('extrait coupé au milieu des lignes : bornes à la milliseconde, mots gardés selon leur horaire, ni trou ni décalage', () => {
  const full = wordsForExtracts(lines, [{ start_ms: 0, end_ms: 6000 }]).words; // références : horaires dans l'extrait complet
  // 1 500 → 4 700 : coupe la 1re ligne (0–4 s) au début et la 2e (4–6 s) à la fin
  const cut = wordsForExtracts(lines, [{ start_ms: 1500, end_ms: 4700 }]);
  close(cut.duration, 3.2);
  assert.ok(cut.words.length > 0 && cut.words.length < full.length);
  for (const w of cut.words) {
    assert.ok(w.start >= 0 && w.end <= 3.2 + 1e-9 && w.end > w.start, JSON.stringify(w));
    const ref = full.find((f) => f.text === w.text && Math.abs(f.start - 1.5 - w.start) < 1e-6 + (w.start === 0 ? 1.5 : 0)); // même mot, même instant (décalé de l'entrée)
    assert.ok(ref, `${w.text} garde son horaire d'origine`);
  }
  // le 1er mot gardé de la 1re ligne n'est pas « UN » (dit avant 1,5 s)
  assert.notEqual(cut.words[0].text, 'Un');
  // décaler le début de 0,5 s ne change ni l'horaire ni le texte des mots gardés des deux côtés
  const a = wordsForExtracts(lines, [{ start_ms: 1500, end_ms: 4700 }]).words;
  const b = wordsForExtracts(lines, [{ start_ms: 2000, end_ms: 4700 }]).words;
  for (const w of b) {
    const same = a.find((x) => x.text === w.text && Math.abs(x.start - 0.5 - w.start) < 1e-6);
    assert.ok(same || w.start === 0, `${w.text} décalé de 0,5 s`);
  }
  // une ligne qui ne fait que « toucher » l'extrait n'en fait pas partie
  assert.equal(wordsForExtracts(lines, [{ start_ms: 6000, end_ms: 9000 }]).words.length, 0);
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

test('source à citer : titre tronqué et date en français', () => {
  assert.equal(sourceText('Mon interview', '2025-03-01'), 'Source : Mon interview · 1 mars 2025');
  assert.match(sourceText('x'.repeat(100), '2025-12-25'), /^Source : x{55}… · 25 décembre 2025$/);
  assert.equal(sourceText('', null), 'Source : interview');
});

const font = { ass_name: 'Anton Regular' };
const build = (style, extracts = [{ start_ms: 0, end_ms: 6000 }]) => {
  const st = sanitizeStyle(style, FONTS);
  const { words, duration } = wordsForExtracts(lines, extracts);
  return { st, ass: buildAss({ groups: groupWords(words, st), style: st, font }), words, duration };
};
const events = (ass) => ass.split('\n').filter((l) => l.startsWith('Dialogue: 1,')); // texte (couche 1) ; le fond est sur la couche 0

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
  assert.doesNotMatch(ass, /Banner|Source :/); // plus de bandeau de source dans la vidéo
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

test('ASS fond sombre et position : fond rectangulaire sans mesure, largeur adaptée au bord', () => {
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
  const ass = buildAss({ groups: groupWords(words, st), style: st, font });
  const ev = events(ass)[0];
  assert.equal((ev.match(/\{/g) ?? []).length, 1, 'une seule balise de style : celle du programme'); // aucune balise injectée par le texte
  assert.doesNotMatch(ass, /\{\\fs500/);
  assert.match(ev, /Un \/fs500 mot\/Nsuite/);
});

test('taille : la taille de l\'éditeur est une taille d\'em, convertie en taille ASS selon la police', () => {
  const st = sanitizeStyle({ preset: 'classique', size: 60 }, FONTS);
  const { words, duration } = wordsForExtracts(lines, [{ start_ms: 0, end_ms: 6000 }]);
  const ass = (f) => buildAss({ groups: groupWords(words, st), style: st, font: f });
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
  const ass = buildAss({ groups: g, style: st, font: { ass_name: 'F', cap_em: 0.8 } });
  const m = events(ass)[0].match(/\\fscx(\d+)\\fscy\d+\\t\(0,90,\\fscx(\d+)\\fscy\d+\)\\t\(90,170,\\fscx(\d+)/);
  assert.ok(m, events(ass)[0]);
  assert.deepEqual([Number(m[1]), Number(m[3])], [Math.round(72 * k), Math.round(100 * k)]);
  const short = buildAss({ groups: [{ start: 0, end: 1, words: [{ text: 'oui', start: 0, end: 1, line: 0 }] }], style: sanitizeStyle({ preset: 'classique' }, FONTS), font: { ass_name: 'F', cap_em: 0.8 } });
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

test('arrondi du fond : borné de 0 à 1, valeur du style par défaut sinon', () => {
  assert.equal(sanitizeStyle({ preset: 'boite', boxRadius: 5 }, FONTS).boxRadius, 1);
  assert.equal(sanitizeStyle({ preset: 'boite', boxRadius: -1 }, FONTS).boxRadius, 0);
  assert.equal(sanitizeStyle({ preset: 'boite', boxRadius: 0.456 }, FONTS).boxRadius, 0.46);
  assert.equal(sanitizeStyle({ preset: 'boite', boxRadius: 'x' }, FONTS).boxRadius, DEFAULT_STYLE.boxRadius);
  assert.equal(sanitizeStyle({ preset: 'boite' }, FONTS).boxRadius, DEFAULT_STYLE.boxRadius);
});

test('tracé du fond : coins arrondis selon le curseur, une seule forme pour toutes les lignes', () => {
  const rects = [{ x0: -100, y0: -40, x1: 100, y1: 40 }, { x0: -60, y0: 40, x1: 60, y1: 120 }];
  const sharp = boxPath(rects, 0);
  assert.doesNotMatch(sharp, /NaN/);
  assert.match(sharp, /^m -100 -40 l 100 -40 b 100 -40 100 -40 100 -40 l 100 40/); // rayon nul : les courbes se réduisent à un point
  assert.equal((boxPath(rects, 0.5).match(/m /g) ?? []).length, 2); // un sous-tracé par ligne, dans un seul tracé
  // curseur au maximum : rayon = moitié de la hauteur de la ligne (80 / 2 = 40)
  assert.match(boxPath(rects, 1), /^m -60 -40 l 60 -40 b 82\.1 -40 100 -22\.1 100 0/);
  assert.match(boxPath(rects, 0.5), /^m -80 -40 l 80 -40 b /); // moitié : rayon de 20
  // jamais plus rond qu'un demi-cercle, même pour un rectangle étroit
  assert.doesNotMatch(boxPath([{ x0: 0, y0: 0, x1: 10, y1: 100 }], 1), /NaN|-\d/);
  // même forme pour l'aperçu (SVG)
  const svg = boxPath(rects, 0.5, 'svg');
  assert.match(svg, /^M -80 -40 L 80 -40 C /);
  assert.equal((svg.match(/ Z/g) ?? []).length, 2);
});

test('ASS fond arrondi : forme dessinée sous le texte, même pop, plus de rectangle libass', () => {
  const st = sanitizeStyle({ preset: 'boite', boxColor: '#102030', boxOpacity: 0.5, boxRadius: 0.4, size: 60, animation: 'pop' }, FONTS);
  const { words } = wordsForExtracts(lines, [{ start_ms: 0, end_ms: 6000 }]);
  const groups = groupWords(words, st);
  const boxes = groups.map(() => [{ x0: -200, y0: -50, x1: 200, y1: 50 }]);
  const ass = buildAss({ groups, style: st, font, boxes });
  assert.match(ass, /,0,0,0,0,100,100,0,0,1,0,0,5,/); // BorderStyle 1, sans contour ni ombre : le fond est dessiné
  const all = ass.split('\n').filter((l) => l.startsWith('Dialogue'));
  assert.equal(all.length, groups.length * 2);
  assert.ok(all[0].startsWith('Dialogue: 0,'));
  assert.ok(all[0].includes('{\\an7\\pos(540,1344)\\bord0\\shad0\\1c&H302010&\\1a&H80&\\fscx72\\fscy72\\t(0,90,\\fscx106\\fscy106)\\t(90,170,\\fscx100\\fscy100)\\p1}m '), all[0]);
  assert.match(all[1], /^Dialogue: 1,/); // le texte est au-dessus du fond
  // fond d'un groupe : même durée que le groupe
  assert.equal(all[0].split(',').slice(1, 3).join(), all[1].split(',').slice(1, 3).join());
  // sans mesure : repli sur le rectangle de libass
  assert.match(buildAss({ groups, style: st, font }), /,0,0,0,0,100,100,0,0,3,17,0,5,/);
  // pas de fond : aucun événement de fond
  const plain = build({ preset: 'classique' }).ass;
  assert.equal(plain.split('\n').filter((l) => l.startsWith('Dialogue: 0,')).length, 0);
});
