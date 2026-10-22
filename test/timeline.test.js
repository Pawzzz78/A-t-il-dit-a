// Timeline du studio : calculs de la zone choisie (durée maximale bloquée), du zoom, des repères et des vignettes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TL, clampView, durLabel, fitZone, moveZone, overlapRatio, resizeZone, rulerTicks, snapMove, snapTime, viewAround, viewFitting, visibleTiles, zoomView, zoneAround } from '../public/js/timeline-core.js';

const MIN = 3000;
const MAX = 120_000;
const DUR = 3_600_000; // une interview d'une heure
const L = { durationMs: DUR, minMs: MIN, maxMs: MAX };

test('étirer la zone : la durée maximale (durée max) bloque l\'extension, des deux côtés', () => {
  const z = { start_ms: 600_000, end_ms: 690_000 }; // 1 min 30
  // on tire la fin vers la droite : elle s'arrête à 4 min après le début
  let r = resizeZone(z, 'end', 900_000, L);
  assert.deepEqual(r.zone, { start_ms: 600_000, end_ms: 720_000 });
  assert.equal(r.limited, 'max');
  // on tire le début vers la gauche : il s'arrête à 4 min avant la fin
  r = resizeZone(z, 'start', 100_000, L);
  assert.deepEqual(r.zone, { start_ms: 570_000, end_ms: 690_000 });
  assert.equal(r.limited, 'max');
  // dans la limite : suivi exact
  r = resizeZone(z, 'end', 700_000, L);
  assert.deepEqual([r.zone.end_ms, r.limited], [700_000, null]);
});

test('étirer la zone : durée minimale, bords de la vidéo', () => {
  const z = { start_ms: 10_000, end_ms: 40_000 };
  let r = resizeZone(z, 'end', 11_000, L);
  assert.deepEqual([r.zone.end_ms, r.limited], [13_000, 'min']);
  r = resizeZone(z, 'start', 39_500, L);
  assert.deepEqual([r.zone.start_ms, r.limited], [37_000, 'min']);
  r = resizeZone(z, 'start', -5000, L);
  assert.deepEqual([r.zone.start_ms, r.limited], [0, 'edge']); // le bord de la vidéo, pas la limite des durée maximale
  r = resizeZone({ start_ms: 3_500_000, end_ms: 3_590_000 }, 'end', 3_700_000, L);
  assert.deepEqual([r.zone.end_ms, r.limited], [DUR, 'edge']);
  // une zone de durée maximale pile ne peut plus grandir
  r = resizeZone({ start_ms: 0, end_ms: MAX }, 'end', MAX + 1000, L);
  assert.equal(r.zone.end_ms, MAX);
});

test('déplacer la zone : même durée, jamais hors de la vidéo', () => {
  const z = { start_ms: 100_000, end_ms: 160_000 };
  assert.deepEqual(moveZone(z, 500_000, DUR), { start_ms: 500_000, end_ms: 560_000 });
  assert.deepEqual(moveZone(z, -9000, DUR), { start_ms: 0, end_ms: 60_000 });
  assert.deepEqual(moveZone(z, DUR, DUR), { start_ms: DUR - 60_000, end_ms: DUR });
});

test('placer une zone : centrée, durée bornée, ramenée dans la vidéo', () => {
  assert.deepEqual(zoneAround(1_000_000, 30_000, L), { start_ms: 985_000, end_ms: 1_015_000 });
  assert.deepEqual(zoneAround(2000, 30_000, L), { start_ms: 0, end_ms: 30_000 });
  assert.equal(zoneAround(1_000_000, 900_000, L).end_ms - zoneAround(1_000_000, 900_000, L).start_ms, MAX);
  // vidéo plus courte que la durée minimale : la zone est la vidéo entière
  assert.deepEqual(zoneAround(1000, 30_000, { durationMs: 2000, minMs: MIN, maxMs: MAX }), { start_ms: 0, end_ms: 2000 });
});

test('zone existante ramenée dans les limites (brouillon ancien, durée max réduite)', () => {
  assert.deepEqual(fitZone({ start_ms: 0, end_ms: 400_000 }, L), { start_ms: 0, end_ms: MAX });
  assert.deepEqual(fitZone({ start_ms: 10_000, end_ms: 10_500 }, L), { start_ms: 10_000, end_ms: 13_000 });
  assert.deepEqual(fitZone({ start_ms: DUR - 1000, end_ms: DUR + 5000 }, L), { start_ms: DUR - MIN, end_ms: DUR });
});

test('aimantation sur les débuts et fins de phrases', () => {
  const marks = [1000, 5000, 9000, 20_000];
  assert.equal(snapTime(5400, marks, 500), 5000);
  assert.equal(snapTime(5600, marks, 500), 5600); // trop loin
  assert.equal(snapTime(700, marks, 500), 1000);
  assert.equal(snapTime(30_000, marks, 500), 30_000);
  assert.equal(snapTime(8800, marks, 500), 9000);
  assert.equal(snapTime(5400, [], 500), 5400);
  // zone déplacée : la fin se cale sur une fin de phrase, la durée est conservée
  const starts = [1000, 5000];
  const ends = [4000, 9000];
  assert.deepEqual(snapMove({ start_ms: 5600, end_ms: 8900 }, starts, ends, 200), { start_ms: 5700, end_ms: 9000 });
  assert.deepEqual(snapMove({ start_ms: 5100, end_ms: 8700 }, starts, ends, 200), { start_ms: 5000, end_ms: 8600 });
  assert.deepEqual(snapMove({ start_ms: 6000, end_ms: 8000 }, starts, ends, 200), { start_ms: 6000, end_ms: 8000 });
});

test('zoom : le point visé reste à la même place, limites de la vue', () => {
  const view = { from_ms: 0, span_ms: DUR };
  const z = zoomView(view, 4, 1_800_000, DUR);
  assert.equal(z.span_ms, DUR / 4);
  assert.equal((1_800_000 - z.from_ms) / z.span_ms, 0.5);
  // zoom arrière au maximum : toute la vidéo
  assert.deepEqual(zoomView(z, 0.01, 1_800_000, DUR), { from_ms: 0, span_ms: DUR });
  // zoom avant au maximum : minSpan
  assert.equal(zoomView(view, 1e9, 1000, DUR).span_ms, TL.minSpanMs);
  // défilement borné
  assert.deepEqual(clampView({ from_ms: -50, span_ms: 60_000 }, DUR), { from_ms: 0, span_ms: 60_000 });
  assert.equal(clampView({ from_ms: DUR, span_ms: 60_000 }, DUR).from_ms, DUR - 60_000);
  // vidéo plus courte que la vue minimale : la vue est la vidéo entière
  assert.deepEqual(clampView({ from_ms: 5, span_ms: 1000 }, 10_000), { from_ms: 0, span_ms: 10_000 });
});

test('vue autour de la zone', () => {
  const z = { start_ms: 600_000, end_ms: 690_000 };
  const v = viewAround(z, DUR);
  assert.equal(v.span_ms, 270_000);
  assert.ok(v.from_ms < z.start_ms && v.from_ms + v.span_ms > z.end_ms);
  const f = viewFitting(z, DUR);
  assert.ok(f.span_ms >= 90_000 && f.span_ms < 130_000 && f.from_ms <= z.start_ms && f.from_ms + f.span_ms >= z.end_ms);
  // zone au tout début : vue ramenée à 0
  assert.equal(viewAround({ start_ms: 0, end_ms: 30_000 }, DUR).from_ms, 0);
});

test('règle graduée : pas rond, peu de repères', () => {
  const r = rulerTicks({ from_ms: 0, span_ms: DUR });
  assert.ok(r.ticks.length <= TL.tickTarget + 1 && r.ticks.length >= 2, `${r.ticks.length} repères`);
  assert.equal(r.step_ms, 600_000);
  const fine = rulerTicks({ from_ms: 61_000, span_ms: 20_000 });
  assert.equal(fine.step_ms, 5000);
  assert.deepEqual(fine.ticks, [65_000, 70_000, 75_000, 80_000]);
});

test('vignettes : une toutes les N images selon le zoom, jamais plus étroites que le minimum', () => {
  const plan = { step_s: 18, frames: 200, cols: 10 };
  const wide = visibleTiles({ from_ms: 0, span_ms: DUR }, plan, 340);
  assert.ok(wide.length > 0 && wide.length <= 340 / TL.minTilePx + 1, `${wide.length} vignettes`);
  assert.ok(wide.every((t) => t.width >= TL.minTilePx - 0.01));
  assert.deepEqual([wide[0].left, wide[0].col, wide[0].row], [0, 9, 1]); // la vignette représente le milieu de sa case
  // zoom serré : chaque image de la grille, dans l'ordre
  const near = visibleTiles({ from_ms: 3 * 18_000, span_ms: 90_000 }, plan, 340);
  assert.deepEqual(near.map((t) => t.col), [3, 4, 5, 6, 7]);
  assert.equal(near[0].left, 0);
  // seconde ligne de la grille
  const second = visibleTiles({ from_ms: 11 * 18_000, span_ms: 36_000 }, plan, 340);
  assert.deepEqual([second[0].col, second[0].row], [1, 1]);
  assert.deepEqual(visibleTiles({ from_ms: 0, span_ms: 1000 }, null, 340), []);
});

test('recouvrement et libellés de durée', () => {
  assert.equal(overlapRatio({ start_ms: 0, end_ms: 100 }, { start_ms: 50, end_ms: 400 }), 0.5);
  assert.equal(overlapRatio({ start_ms: 0, end_ms: 100 }, { start_ms: 100, end_ms: 400 }), 0);
  assert.equal(overlapRatio({ start_ms: 5, end_ms: 5 }, { start_ms: 0, end_ms: 9 }), 0);
  assert.deepEqual([42_000, 60_000, 217_000, 240_000, 59_600].map(durLabel), ['42 s', '1 min', '3 min 37 s', '4 min', '1 min']);
});
