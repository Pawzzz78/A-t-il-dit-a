// Moteur de réseaux de neurones (WebAssembly SIMD) : mêmes résultats que le calcul JavaScript de référence, détection et empreintes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { alignFace, cosine, loadSface } from '../src/studio/sface.js';
import { loadYunet } from '../src/studio/yunet.js';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const FACE = new URL('./fixtures/face.jpg', import.meta.url).pathname;

/** Le portrait de test (agrandi) sur un fond gris : RVB entrelacé 320 × 288 (multiples de 32). */
function scene(vf = '') {
  const rgb = execFileSync('ffmpeg', ['-v', 'error', '-i', FACE, '-vf', `scale=170*1.2:-2,pad=320:288:70:40:gray${vf},format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
  return new Uint8Array(rgb);
}

const withNn = (mode, fn) => {
  const before = process.env.NN_WASM;
  process.env.NN_WASM = mode;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.NN_WASM;
    else process.env.NN_WASM = before;
  }
};

test('détecteur : noyaux WebAssembly et calcul JavaScript donnent la même détection', { skip: !hasFfmpeg }, () => {
  const rgb = scene();
  const fast = withNn('on', () => loadYunet().detect(rgb, 320, 288));
  const ref = withNn('off', () => loadYunet().detect(rgb, 320, 288));
  assert.equal(fast.length, 1);
  assert.equal(ref.length, 1);
  for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(fast[0][k] - ref[0][k]) < 0.05, `${k} : ${fast[0][k]} / ${ref[0][k]}`);
  assert.ok(Math.abs(fast[0].score - ref[0].score) < 1e-3);
  fast[0].kps.forEach((p, i) => assert.ok(Math.hypot(p[0] - ref[0].kps[i][0], p[1] - ref[0].kps[i][1]) < 0.05));
  // les repères sont cohérents : yeux au-dessus du nez, nez au-dessus de la bouche, œil gauche de l'image à gauche
  const [eyeL, eyeR, nose, mouthL, mouthR] = fast[0].kps;
  assert.ok(eyeL[0] < eyeR[0] && eyeL[1] < nose[1] && nose[1] < mouthL[1] && mouthL[0] < mouthR[0]);
  assert.ok(nose[0] > fast[0].x && nose[0] < fast[0].x + fast[0].w);
});

test('empreintes : mêmes valeurs avec WebAssembly et en JavaScript, norme 1, stables d\'une prise de vue à l\'autre', { skip: !hasFfmpeg }, () => {
  const sets = [['original', ''], ['miroir', ',hflip'], ['sombre', ',eq=brightness=-0.15:contrast=0.9'], ['floue', ',gblur=sigma=1.5']];
  const embed = (mode, vf) => withNn(mode, () => {
    const rgb = scene(vf);
    const [face] = loadYunet().detect(rgb, 320, 288);
    assert.ok(face, `visage trouvé (${vf || 'original'})`);
    return loadSface().embed(alignFace(rgb, 320, 288, face.kps));
  });
  const fast = sets.map(([, vf]) => embed('on', vf));
  const ref = embed('off', '');
  assert.ok(Math.abs(cosine(fast[0], fast[0]) - 1) < 1e-4);
  assert.ok(cosine(fast[0], ref) > 0.9999, `WebAssembly / JavaScript : ${cosine(fast[0], ref)}`);
  for (let i = 1; i < sets.length; i++) assert.ok(cosine(fast[0], fast[i]) > 0.85, `${sets[i][0]} : ${cosine(fast[0], fast[i])}`);
});

test('alignement : un visage penché ou plus petit donne la même vignette à peu près', { skip: !hasFfmpeg }, () => {
  const embed = (vf) => {
    const rgb = scene(vf);
    const [face] = loadYunet().detect(rgb, 320, 288);
    return loadSface().embed(alignFace(rgb, 320, 288, face.kps));
  };
  const base = embed('');
  assert.ok(cosine(base, embed(',rotate=0.25:fillcolor=gray')) > 0.85, 'penché de 14°');
});
