// Cycle de vie des variantes de la bibliothèque, sans base (nécessite ffmpeg, sinon ignorés)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}
const enabled = hasFfmpeg;

let dir;
let clip;
let uniq;
const WHO_A = 'aaaaaaaaaaaaaaaa'.repeat(2); // 32 hex, comme une clé de propriétaire
const WHO_B = 'bbbbbbbbbbbbbbbb'.repeat(2);

const poll = async (fn, { timeoutMs = 120_000, stepMs = 200 } = {}) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error('Délai dépassé');
    await new Promise((x) => setTimeout(x, stepMs));
  };
};

before(async () => {
  if (!enabled) return;
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uniq-test-'));
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  delete process.env.LIBRARY_UNIQ;
  delete process.env.LIBRARY_UNIQ_LEVEL;
  // Clip de test 720×1280, 2 s, avec audio (la définition « fast » du studio)
  clip = path.join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=720x1280:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-shortest', clip]);
  uniq = await import('../src/library/uniq.js');
});

after(async () => {
  if (!enabled) return;
  await fs.rm(dir, { recursive: true, force: true });
});

const ID = 'c'.repeat(24);
const ensure = (who) => uniq.ensureVariant({ id: ID, who, file: clip, quality: 'fast', durationS: 2 });
const ready = (id, who) =>
  poll(async () => {
    const st = await uniq.variantState(id, who);
    if (['error', 'skipped', 'disabled'].includes(st.state)) throw new Error(`variante en ${st.state}`);
    return st.state === 'ready';
  });

test('deux personnes → deux variantes différentes ; même personne → fichier en cache', { skip: !enabled }, async () => {
  uniq.resetUniqState();
  const a1 = await ensure(WHO_A);
  assert.ok(['ready', 'queued', 'running'].includes(a1.state), JSON.stringify(a1));
  await ensure(WHO_B);
  await ready(ID, WHO_A);
  await ready(ID, WHO_B);
  const fa = await uniq.variantFile(ID, WHO_A);
  const fb = await uniq.variantFile(ID, WHO_B);
  assert.ok(fa && fb);
  const ba = await fs.readFile(fa);
  const bb = await fs.readFile(fb);
  assert.ok(ba.length > 0 && bb.length > 0);
  assert.ok(!ba.equals(bb), 'deux personnes : deux fichiers différents');
  const bc = await fs.readFile(clip);
  assert.ok(!ba.equals(bc), 'une variante diffère du clip d’origine');
  const meta = JSON.parse(await fs.readFile(`${fa}.json`, 'utf8'));
  assert.equal(meta.clip, ID);
  assert.equal(meta.who, WHO_A.slice(0, 16));
  // en cache : plus d'encodage, fichiers identiques
  const again = await ensure(WHO_A);
  assert.deepEqual(again, { state: 'ready', progress: 1 });
  assert.ok((await fs.readFile(fa)).equals(ba), 'la variante est stable');
  assert.ok((await uniq.variantsBytes()) >= ba.length + bb.length);
});

test('plafond par clip : les variantes les plus anciennes sont éjectées', { skip: !enabled }, async () => {
  uniq.resetUniqState();
  process.env.LIBRARY_UNIQ_MAX_PER_CLIP = '2';
  const id = 'd'.repeat(24);
  const who = (c) => c.repeat(32);
  const ensureId = (w) => uniq.ensureVariant({ id, who: w, file: clip, quality: 'fast', durationS: 2 });
  await ensureId(who('1'));
  await ready(id, who('1'));
  await ensureId(who('2'));
  await ready(id, who('2'));
  await ensureId(who('3')); // déborde le plafond de 2
  await ready(id, who('3'));
  const names = (await fs.readdir(uniq.variantsDir())).filter((n) => n.startsWith(`${id}_`) && n.endsWith('.mp4'));
  assert.equal(names.length, 2, JSON.stringify(names));
  assert.ok(!names.some((n) => n.includes('1111111111111111')), 'la plus ancienne part');
  delete process.env.LIBRARY_UNIQ_MAX_PER_CLIP;
});

test('removeVariants : fichiers, sidecars et jobs en cours disparaissent', { skip: !enabled }, async () => {
  uniq.resetUniqState();
  const id = 'e'.repeat(24);
  const w = '2'.repeat(32);
  await uniq.ensureVariant({ id, who: w, file: clip, quality: 'fast', durationS: 2 });
  await ready(id, w);
  assert.ok(await uniq.variantFile(id, w));
  await uniq.removeVariants(id);
  assert.equal(await uniq.variantFile(id, w), null);
  const names = (await fs.readdir(uniq.variantsDir())).filter((n) => n.startsWith(`${id}_`));
  assert.equal(names.length, 0, JSON.stringify(names));
});

test('sweepVariants : seules les variantes de clips disparus sont retirées', { skip: !enabled }, async () => {
  uniq.resetUniqState();
  const keep = 'f'.repeat(24);
  const gone = 'g'.repeat(24);
  const w = '3'.repeat(32);
  await uniq.ensureVariant({ id: keep, who: w, file: clip, quality: 'fast', durationS: 2 });
  await ready(keep, w);
  // variante « orpheline » posée à la main (clip inexistant)
  const orphan = path.join(uniq.variantsDir(), `${gone}_${w.slice(0, 16)}_gentle.mp4`);
  await fs.writeFile(orphan, 'x');
  await fs.writeFile(`${orphan}.json`, '{}');
  // les ids des tests précédents de ce fichier sont aussi des clips « existants »
  const removed = await uniq.sweepVariants(new Set([ID, 'd'.repeat(24), keep]));
  assert.equal(removed, 1, 'seule l’orpheline part');
  assert.ok(!(await fs.readdir(uniq.variantsDir())).includes(path.basename(orphan)));
  assert.ok(await uniq.variantFile(keep, w), 'celle du clip existant est gardée');
});

test('LIBRARY_UNIQ=off → rien ne démarre, état « disabled »', { skip: !enabled }, async () => {
  uniq.resetUniqState();
  process.env.LIBRARY_UNIQ = 'off';
  const id = 'h'.repeat(24);
  const w = '4'.repeat(32);
  assert.deepEqual(await uniq.ensureVariant({ id, who: w, file: clip, quality: 'fast', durationS: 2 }), { state: 'disabled', progress: 0 });
  assert.deepEqual(await uniq.variantState(id, w), { state: 'disabled', progress: 0 });
  delete process.env.LIBRARY_UNIQ;
});
