// Cadrage automatique : trajectoire du cadre à partir des visages détectés (module pur).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FRAMING, cropXAt, cropXAtClip, cropXExpr, faceTracks, framingForClip, framingForExtract, framingPath, pickTrack, splitShots, windowWidth } from '../public/js/framing.js';

const ASPECT = 16 / 9;
const CW = windowWidth(ASPECT);
const toX = (cx) => (cx - CW / 2) / (1 - CW); // position du cadre qui centre un visage en cx
/** Image par seconde, un visage de largeur 0.06 (en fraction de l'image) centré en cx(t). */
const video = (seconds, cxs, { fps = 1, size = 0.06, y = 0.3 } = {}) =>
  Array.from({ length: Math.ceil(seconds * fps) + 1 }, (_, i) => {
    const out = [];
    for (const [cx, s] of [].concat(cxs(i / fps))) if (cx != null) out.push([cx - (s ?? size) / 2, y, s ?? size, (s ?? size) * ASPECT * 1.2, 0.9]);
    return out;
  });
const range = (frames, startMs, endMs, subject = 'auto', cuts = []) => framingForExtract({ frames, fps: 1, aspect: ASPECT, startMs, endMs, subject, cuts });
const evalExpr = (expr, t) => new Function('t', 'lt', 'iff', `return ${expr.replace(/\bif\(/g, 'iff(')}`)(t, (a, b) => a < b, (c, a, b) => (c ? a : b));

test('fenêtre 9:16 : un tiers de la largeur pour une source 16:9', () => {
  assert.ok(Math.abs(CW - 0.3164) < 1e-3);
  assert.equal(windowWidth(9 / 16), 1);
});

test('visage immobile : cadre fixe, centré sur le visage', () => {
  const r = range(video(30, () => [[0.3]]), 0, 30000);
  assert.equal(r.keys.length, 2);
  assert.ok(Math.abs(r.keys[0].x - toX(0.3)) < 1e-3, JSON.stringify(r.keys));
  assert.equal(r.keys[0].x, r.keys[1].x);
  assert.deepEqual([r.faces, r.coverage], [1, 1]);
});

test('petits mouvements dans la zone morte : le cadre ne bouge pas', () => {
  const r = range(video(30, (t) => [[0.5 + 0.015 * Math.sin(t)]]), 0, 30000);
  assert.equal(r.keys.length, 2);
  assert.equal(r.keys[0].x, r.keys[1].x);
});

test('détection bruitée : pas de tremblement', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const frames = video(40, () => [[0.4 + 0.02 * rnd()]], { fps: 2 });
  const r = framingForExtract({ frames, fps: 2, aspect: ASPECT, startMs: 0, endMs: 40000 });
  const xs = Array.from({ length: 1200 }, (_, i) => cropXAt(r.keys, i / 30));
  const variation = xs.slice(1).reduce((a, x, i) => a + Math.abs(x - xs[i]), 0);
  assert.ok(variation < 0.05, `variation totale ${variation}`);
});

test('le visage se déplace : le cadre le rejoint en douceur, sans saut ni dépassement', () => {
  const frames = video(30, (t) => [[0.3 + 0.4 * Math.min(1, Math.max(0, (t - 10) / 8))]]); // glisse de 0,3 à 0,7 entre 10 s et 18 s
  const r = range(frames, 0, 30000);
  assert.ok(r.keys.length >= 3 && r.keys.length <= 12, String(r.keys.length));
  const xs = Array.from({ length: 900 }, (_, i) => cropXAt(r.keys, i / 30));
  const k = CW / (1 - CW);
  const maxStep = Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i])));
  assert.ok(maxStep <= (FRAMING.vmaxWin * k) / 30 * 1.05, `pas max ${maxStep}`);
  // monotone : jamais de retour en arrière ni de dépassement de la cible
  assert.ok(xs.every((x, i) => i === 0 || x >= xs[i - 1] - 1e-4));
  assert.ok(Math.max(...xs) <= toX(0.7) + FRAMING.deadWin * k + 1e-3); // au plus l'avance prise sur un visage en marche, qui reste dans la zone morte
  assert.ok(Math.abs(xs[0] - toX(0.3)) < 1e-3, 'le cadre démarre déjà sur le visage');
  assert.ok(Math.abs(xs.at(-1) - toX(0.7)) <= FRAMING.deadWin * k + 1e-3, 'et finit près du visage');
  // accélération bornée (pas de démarrage brusque) et vitesse continue
  const v = xs.slice(1).map((x, i) => (x - xs[i]) * 30);
  const maxAcc = Math.max(...v.slice(1).map((s, i) => Math.abs(s - v[i]) * 30));
  assert.ok(maxAcc <= FRAMING.amaxWin * k * 1.3, `accélération ${maxAcc}`);
});

test('changement de plan : le cadre saute sur le visage du nouveau plan, sans glisser', () => {
  const frames = video(40, (t) => [[t < 20 ? 0.3 : 0.7]]);
  const r = range(frames, 5000, 35000, 'auto', [19.6]); // la coupe est à 19,6 s ; l'image de 20 s est déjà dans le plan suivant
  assert.ok(Math.abs(cropXAt(r.keys, 19.5 - 5) - toX(0.3)) < 1e-3);
  assert.ok(Math.abs(cropXAt(r.keys, 19.7 - 5) - toX(0.7)) < 1e-3, `juste après la coupe : ${cropXAt(r.keys, 14.7)}`);
  assert.ok(r.keys.some((p, i) => i && p.t === r.keys[i - 1].t && p.x !== r.keys[i - 1].x), 'saut = deux points au même instant');
  for (let t = 0; t <= 30; t += 0.21) assert.ok(Math.abs(evalExpr(cropXExpr(r.keys), t) - cropXAt(r.keys, t)) < 1e-6, `t=${t}`);
  // sans l'information de coupe, le suivi par identité garderait le visage le plus présent pendant tout l'extrait
  assert.deepEqual(splitShots(5, 35, [19.6, 5.2, 34.9, 19.7]), [{ from: 5, to: 19.6 }, { from: 19.6, to: 35 }]);
});

test('fausse coupe (même plan, visage presque au même endroit) : le cadre ne saute pas', () => {
  const frames = video(40, (t) => [[t < 20 ? 0.4 : 0.42]]); // 0,02 de déplacement : dans la zone morte
  const r = range(frames, 0, 40000, 'auto', [19.6]);
  const xs = Array.from({ length: 1200 }, (_, i) => cropXAt(r.keys, i / 30));
  const biggest = Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i])));
  assert.ok(biggest < 0.002, `saut de ${biggest}`);
});

test('plan sans visage au milieu : la position du plan précédent est tenue', () => {
  const frames = video(40, (t) => (t >= 10 && t < 20 ? [] : [[t < 10 ? 0.3 : 0.6]]));
  const r = range(frames, 0, 40000, 'auto', [10, 20]);
  assert.ok(Math.abs(cropXAt(r.keys, 15) - toX(0.3)) < 1e-3);
  assert.ok(Math.abs(cropXAt(r.keys, 25) - toX(0.6)) < 1e-3);
});

test('plusieurs visages : le plus gros par défaut, ou celui de gauche / de droite au choix', () => {
  const frames = video(20, () => [[0.25, 0.04], [0.75, 0.09]]);
  const at = (subject) => range(frames, 0, 20000, subject);
  assert.ok(Math.abs(at('auto').keys[0].x - toX(0.75)) < 1e-3);
  assert.ok(Math.abs(at('right').keys[0].x - toX(0.75)) < 1e-3);
  assert.ok(Math.abs(at('left').keys[0].x - toX(0.25)) < 1e-3);
  assert.equal(at('auto').faces, 2);
  // un seul visage : tous les choix donnent le même cadre
  const solo = video(20, () => [[0.6]]);
  assert.equal(range(solo, 0, 20000, 'left').keys[0].x, range(solo, 0, 20000, 'right').keys[0].x);
});

test('un faux visage de passage (quelques secondes) n\'est pas suivi', () => {
  const frames = video(30, (t) => [[0.3, 0.07], ...(t > 12 && t < 15 ? [[0.8, 0.09]] : [])]);
  const r = range(frames, 0, 30000, 'auto');
  assert.ok(Math.abs(r.keys[0].x - toX(0.3)) < 1e-3 || r.keys.every((p) => p.x < toX(0.8)), JSON.stringify(r.keys));
  assert.equal(range(frames, 0, 30000, 'right').faces, 1); // le passant ne compte pas comme un visage de l'interview
});

test('visage perdu un moment : la dernière position est tenue, sans balayage', () => {
  const frames = video(40, (t) => (t > 10 && t < 25 ? [] : [[0.5]]));
  const r = range(frames, 0, 40000);
  assert.equal(r.keys.length, 2);
  assert.ok(r.coverage < 0.6);
});

test('aucun visage : pas de cadrage automatique, repli sur le cadre manuel', () => {
  assert.equal(range(video(20, () => []), 0, 20000), null);
  const clip = framingForClip({ frames: video(20, () => []), fps: 1, aspect: ASPECT, extracts: [{ start_ms: 0, end_ms: 10000 }, { start_ms: 10000, end_ms: 20000 }] });
  assert.deepEqual(clip.segments.map((s) => s.keys), [null, null]);
  assert.equal(cropXAtClip(clip.segments, 5, 0.37), 0.37);
});

test('clip de plusieurs extraits : un segment par extrait, calculé séparément', () => {
  const frames = video(60, (t) => [[t < 30 ? 0.3 : 0.7]]);
  const clip = framingForClip({ frames, fps: 1, aspect: ASPECT, extracts: [{ start_ms: 5000, end_ms: 15000 }, { start_ms: 40000, end_ms: 52000 }] });
  assert.deepEqual(clip.segments.map((s) => [s.t0, s.t1]), [[0, 10], [10, 22]]);
  assert.ok(Math.abs(cropXAtClip(clip.segments, 2) - toX(0.3)) < 1e-3);
  assert.ok(Math.abs(cropXAtClip(clip.segments, 15) - toX(0.7)) < 1e-3); // coupure sèche entre extraits : pas de glissement
  assert.equal(clip.faces, 1);
});

test('source plus étroite que l\'écran : cadre centré', () => {
  const frames = video(10, () => [[0.2]]);
  const r = framingForExtract({ frames, fps: 1, aspect: 9 / 16, startMs: 0, endMs: 10000 });
  assert.deepEqual(r.keys.map((p) => p.x), [0.5, 0.5]);
});

test('expression ffmpeg : même courbe que le calcul', () => {
  const r = range(video(40, (t) => [[t < 12 ? 0.25 : t < 24 ? 0.55 : 0.8]]), 0, 40000);
  for (let t = 0; t <= 40; t += 0.37) assert.ok(Math.abs(evalExpr(cropXExpr(r.keys), t) - cropXAt(r.keys, t)) < 1e-6, `t=${t}`);
  assert.equal(cropXExpr([{ t: 0, x: 0.3 }, { t: 5, x: 0.3 }]), '0.3');
  assert.ok(cropXExpr(r.keys).length < 4000);
});

test('reconnaissance : « lisnard » suit la personne de référence, même plus petite ; sans elle, le plus gros', () => {
  // deux visages : A (gros, à gauche) en position 0 de chaque image, B (petit, à droite) en position 1
  const frames = video(20, () => [[0.25, 0.09], [0.75, 0.05]]);
  const identMap = (a, b) => new Map(frames.flatMap((_, fi) => [[`${fi}:0`, a], [`${fi}:1`, b]]));
  const at = (subject, ident) => framingForExtract({ frames, fps: 1, aspect: ASPECT, startMs: 0, endMs: 20000, subject, ident });
  const sameB = at('lisnard', identMap(0.1, 0.9));
  assert.ok(Math.abs(sameB.keys[0].x - toX(0.75)) < 1e-3, 'B reconnu : le cadre est sur lui');
  assert.deepEqual([sameB.crowded, sameB.recognized], [1, 1]);
  assert.ok(Math.abs(at('auto', identMap(0.1, 0.9)).keys[0].x - toX(0.25)) < 1e-3, 'auto ignore la reconnaissance');
  const sameA = at('lisnard', identMap(0.8, 0.2));
  assert.ok(Math.abs(sameA.keys[0].x - toX(0.25)) < 1e-3);
  // personne reconnue (tout sous le seuil), ou pas de reconnaissance : repli sur le plus gros visage
  for (const ident of [identMap(0.1, 0.2), null]) {
    const r = at('lisnard', ident);
    assert.ok(Math.abs(r.keys[0].x - toX(0.25)) < 1e-3);
    assert.equal(r.recognized, 0);
  }
  // les deux ressemblent : la meilleure ressemblance l'emporte
  assert.ok(Math.abs(at('lisnard', identMap(0.5, 0.7)).keys[0].x - toX(0.75)) < 1e-3);
});

test('vidéo longue (une image toutes les 2 s) : même résultat', () => {
  const frames = Array.from({ length: 31 }, (_, i) => [[0.5 - 0.03, 0.3, 0.06, 0.1, 0.9]]); // 62 s à 0,5 image par seconde
  const r = framingForExtract({ frames, fps: 0.5, aspect: ASPECT, startMs: 10000, endMs: 40000 });
  assert.ok(Math.abs(r.keys[0].x - 0.5) < 1e-3 && r.keys.length === 2);
  assert.ok(r.coverage > 0.9, String(r.coverage));
});

test('suivi des visages : un visage qui passe derrière un autre garde son identité', () => {
  const frames = video(20, (t) => [[0.3 + t * 0.01], [0.8]]);
  const tracks = faceTracks(frames, 1, ASPECT, 0, 20);
  assert.equal(tracks.length, 2);
  assert.ok(pickTrack(tracks, 'left').meanX < 0.5 && pickTrack(tracks, 'right').meanX > 0.5);
  assert.equal(framingPath(pickTrack(tracks, 'left'), 0, 20, ASPECT).at(-1).t, 20);
});
