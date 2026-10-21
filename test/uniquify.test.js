// Uniquifier : micro-transforms déterministes (fonctions pures, aucun ffmpeg requis)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEVELS, SIZES, audioFilters, buildUniqArgs, mulberry32, parseFilterNames, seedFrom, uniqParams, videoFilters } from '../src/studio/uniquify.js';

test('mulberry32 : déterministe, borné à [0, 1)', () => {
  const a = mulberry32(0xdeadbeef);
  const b = mulberry32(0xdeadbeef);
  const seq = Array.from({ length: 8 }, () => a());
  for (const v of seq) {
    assert.ok(v >= 0 && v < 1);
    assert.equal(v, b());
  }
  assert.notDeepEqual(seq, Array.from({ length: 8 }, () => mulberry32(0xdeadbeef + 1)()));
});

test('seedFrom : stable, 32 bits, différencié', () => {
  assert.equal(seedFrom('clip|who'), seedFrom('clip|who'));
  assert.ok(seedFrom('clip|who') >= 0 && seedFrom('clip|who') <= 0xffffffff);
  assert.notEqual(seedFrom('clip|who'), seedFrom('clip|who2'));
  assert.notEqual(seedFrom('clip|who'), seedFrom('clip2|who'));
});

test('uniqParams : déterministe par seed et level', () => {
  const seed = seedFrom('a|b');
  assert.deepEqual(uniqParams(seed, 'gentle'), uniqParams(seed, 'gentle'));
  assert.deepEqual(uniqParams(seed, 'medium'), uniqParams(seed, 'medium'));
  assert.notDeepEqual(uniqParams(seed, 'gentle'), uniqParams(seedFrom('c|d'), 'gentle'));
  assert.notDeepEqual(uniqParams(seed, 'gentle'), uniqParams(seed, 'medium'));
});

test('uniqParams : tous les tirages restent dans les bandes (500 seeds × 2 niveaux)', () => {
  for (const [level, conf] of Object.entries(LEVELS)) {
    for (let i = 0; i < 500; i++) {
      const p = uniqParams(seedFrom(`${level}:${i}`), level);
      const EPS = 1e-9; // arrondis flottants : 1 − 0.005 n’est pas exactement 0.995
      assert.equal(p.level, level);
      assert.ok(Math.abs(p.brightness) > 0 && Math.abs(p.brightness) <= conf.brightness + EPS, `brightness ${p.brightness}`);
      assert.ok(Math.abs(p.contrast - 1) > 0 && Math.abs(p.contrast - 1) <= conf.contrast + EPS, `contrast ${p.contrast}`);
      assert.ok(Math.abs(p.gamma - 1) > 0 && Math.abs(p.gamma - 1) <= conf.gamma + EPS, `gamma ${p.gamma}`);
      assert.ok(Math.abs(p.saturation - 1) > 0 && Math.abs(p.saturation - 1) <= conf.saturation + EPS, `saturation ${p.saturation}`);
      assert.ok(Math.abs(p.hue) > 0 && Math.abs(p.hue) <= conf.hue + EPS, `hue ${p.hue}`);
      assert.ok(p.crop > 0 && p.crop <= conf.crop + EPS, `crop ${p.crop}`);
      assert.ok(p.sharpen >= conf.sharpen[0] - EPS && p.sharpen <= conf.sharpen[1] + EPS, `sharpen ${p.sharpen}`);
      assert.ok(p.noise >= conf.noise[0] - EPS && p.noise <= conf.noise[1] + EPS, `noise ${p.noise}`);
      assert.ok(Math.abs(p.pitch - 1) > 0 && Math.abs(p.pitch - 1) <= conf.pitch + EPS, `pitch ${p.pitch}`);
      assert.ok(p.eqFreq >= 2500 && p.eqFreq <= 5000 && p.eqFreq % 50 === 0, `eqFreq ${p.eqFreq}`);
      assert.ok(Math.abs(p.eqGain) > 0 && Math.abs(p.eqGain) <= conf.eqGain + EPS, `eqGain ${p.eqGain}`);
      assert.ok(Math.abs(p.shelfGain) > 0 && Math.abs(p.shelfGain) <= conf.shelf + EPS, `shelfGain ${p.shelfGain}`);
      assert.ok(Math.abs(p.volume - 1) > 0 && Math.abs(p.volume - 1) <= conf.volume + EPS, `volume ${p.volume}`);
      assert.ok(p.trimStart >= conf.trimStart[0] - EPS && p.trimStart <= conf.trimStart[1] + EPS, `trimStart ${p.trimStart}`);
    }
  }
});

test('videoFilters : recadrage centré de dimensions paires, retour à la taille, rien qui retourne ou décale le temps', () => {
  for (const [quality, { w, h }] of Object.entries(SIZES)) {
    const p = uniqParams(seedFrom(`v|${quality}`), 'gentle');
    const f = videoFilters(p, { w, h });
    assert.ok(f.startsWith('crop='), f);
    const [cw, ch, x, y] = f.split(',')[0].slice('crop='.length).split(':');
    assert.equal(Number(cw) % 2, 0);
    assert.equal(Number(ch) % 2, 0);
    assert.ok(Number(cw) < w && Number(ch) < h, 'le recadrage retire bien du cadre');
    assert.equal(x, '(iw-ow)/2');
    assert.equal(y, '(ih-oh)/2');
    assert.ok(f.split(',').includes(`scale=${w}:${h}`), 'retour à la taille exacte');
    for (const f0 of f.split(',')) assert.ok(!/NaN|undefined/.test(f0), f0);
    for (const interdit of ['hflip', 'vflip', 'rotate', 'mirror', 'setpts', 'transpose']) assert.ok(!f.includes(interdit), interdit);
    assert.ok(f.includes('eq=brightness='), 'couleur');
    assert.ok(f.includes('noise=alls='), 'grain');
  }
});

test('audioFilters : durée préservée, rubberband facultatif, valeurs bornées', () => {
  const p = uniqParams(seedFrom('a|b'), 'gentle');
  const avec = audioFilters(p, { rubberband: true });
  const sans = audioFilters(p, { rubberband: false });
  assert.ok(avec.startsWith(`rubberband=pitch=${p.pitch}:tempo=1.0`), 'pitch avec durée conservée');
  assert.ok(!sans.includes('rubberband'));
  for (const f of [avec, sans]) {
    for (const interdit of ['atempo', 'asetrate', 'aresample', 'adelay']) assert.ok(!f.includes(interdit), interdit);
    assert.ok(f.includes('equalizer=f='), 'EQ subtil');
    assert.ok(f.includes('highshelf=f=8500'), 'aiguës');
    assert.ok(f.includes('volume='), 'gain');
  }
});

test('buildUniqArgs : arguments complets, déterministes par seed, repli qualité inconnue', () => {
  const base = { file: '/x/in.mp4', out: '/x/out.mp4', seed: seedFrom('1|2'), level: 'gentle' };
  const a = buildUniqArgs({ ...base, quality: 'hd' });
  const b = buildUniqArgs({ ...base, quality: 'hd' });
  const c = buildUniqArgs({ ...base, seed: seedFrom('1|3'), quality: 'hd' });
  const d = buildUniqArgs({ ...base, quality: 'autre' });
  assert.deepEqual(a.args, b.args);
  assert.notDeepEqual(a.args, c.args);
  assert.ok(a.args.join(' ').includes('scale=1080:1920'));
  assert.ok(d.args.join(' ').includes('scale=1080:1920'), 'qualité inconnue : hd par défaut');
  const i = a.args;
  assert.equal(i[i.indexOf('-i') + 1], '/x/in.mp4');
  // -ss en option de sortie (après -i) : l'amputation des premières frames décale l'alignement temporel
  assert.ok(i.indexOf('-ss') > i.indexOf('-i'), '-ss après l’entrée');
  assert.ok(i.indexOf('-ss') < i.length - 1 && i[i.indexOf('-ss') + 1] === String(a.params.trimStart), 'valeur du trim issue du seed');
  assert.equal(i[i.indexOf('-vf') + 1], videoFilters(a.params, SIZES.hd));
  assert.equal(i[i.indexOf('-af') + 1], audioFilters(a.params));
  assert.equal(i[i.indexOf('-c:v') + 1], 'libx264');
  assert.equal(i[i.indexOf('-c:a') + 1], 'aac');
  assert.ok(i.includes('+faststart'));
  assert.equal(i[i.length - 1], '/x/out.mp4');
});

test('parseFilterNames : lit la sortie de « ffmpeg -filters »', () => {
  // lignes réelles : trois drapeaux jusqu'à ffmpeg 7 (dont « C », commandes), deux depuis ffmpeg 8 (« T. »)
  const out = [
    ' T. volume            A->A       Change input volume.',
    'Filters:',
    '  T.. = Timeline support',
    '  .S. = Slice threading',
    '  ..C = Command support',
    '  A = Audio input/output',
    ' TSC eq                V->V       Adjust brightness, contrast, gamma, and saturation.',
    ' ..C crop              V->V       Crop the input video.',
    ' T.C hue               V->V       Adjust the hue and saturation of the input video.',
    ' ..C rubberband        A->A       Apply time-stretching and pitch-shifting.',
    ' ... anullsrc          |->A       Null audio source, return empty audio frames.',
  ].join('\n');
  const names = parseFilterNames(out);
  for (const f of ['volume', 'eq', 'crop', 'hue', 'rubberband', 'anullsrc']) assert.ok(names.has(f), f);
  assert.ok(!names.has('support') && !names.has('threading'));
});
