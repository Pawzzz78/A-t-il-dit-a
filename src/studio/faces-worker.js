// Thread d'analyse des visages d'une interview (lancé par faces.js) : ffmpeg décode la vidéo en petite définition, une image par
// seconde pour la détection (YuNet) et une détection de changements de plan sur le même flux. Le thread garde le serveur libre.
import { spawn } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';
import { loadYunet } from './yunet.js';

const { file, aspect, duration, fps, maxSide, threshold } = workerData;

// définition de travail : le grand côté vaut maxSide ; le réseau demande des dimensions multiples de 32 (on complète avec du noir)
const w = aspect >= 1 ? maxSide : Math.max(2, Math.round((maxSide * aspect) / 2) * 2);
const h = aspect >= 1 ? Math.max(2, Math.round(maxSide / aspect / 2) * 2) : maxSide;
const pw = Math.ceil(w / 32) * 32;
const ph = Math.ceil(h / 32) * 32;
const frameBytes = pw * ph * 3;

const net = loadYunet();
const ff = spawn(
  'ffmpeg',
  [
    '-hide_banner', '-loglevel', 'info', '-nostats', '-i', file, '-an', '-sn',
    '-filter_complex',
    `[0:v]split=2[a][b];[a]fps=${fps},scale=${w}:${h}:flags=area,setsar=1,pad=${pw}:${ph}:0:0:black[o];[b]scale=160:-2:flags=fast_bilinear,select='gt(scene,0.3)',showinfo[n]`,
    '-map', '[o]', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    '-map', '[n]', '-f', 'null', '-',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

const cuts = [];
let errText = '';
ff.stderr.on('data', (d) => {
  const text = d.toString();
  errText = (errText + text).slice(-2000);
  for (const m of text.matchAll(/pts_time:([0-9.]+)/g)) cuts.push(Math.round(Number(m[1]) * 100) / 100);
});

const r3 = (v) => Math.round(v * 1000) / 1000;
const frames = [];
let pending = Buffer.alloc(0);
const total = Math.max(1, Math.ceil(duration * fps));
let lastReport = 0;

try {
  for await (const chunk of ff.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      const rgb = new Uint8Array(pending.buffer, pending.byteOffset, frameBytes);
      const found = net.detect(rgb, pw, ph, { threshold });
      frames.push(
        found
          .map((f) => [r3(Math.max(0, f.x) / w), r3(Math.max(0, f.y) / h), r3(Math.min(f.w, w - Math.max(0, f.x)) / w), r3(Math.min(f.h, h - Math.max(0, f.y)) / h), r3(f.score)])
          .filter((f) => f[2] > 0.01 && f[3] > 0.01),
      );
      pending = pending.subarray(frameBytes);
      if (frames.length - lastReport >= 10) {
        lastReport = frames.length;
        parentPort.postMessage({ progress: Math.min(0.99, frames.length / total) });
      }
    }
  }
  const code = await new Promise((resolve) => (ff.exitCode !== null ? resolve(ff.exitCode) : ff.on('close', resolve)));
  if (code !== 0 && !frames.length) throw new Error(`ffmpeg a échoué : ${errText.split('\n').filter(Boolean).pop() ?? code}`);
  parentPort.postMessage({ done: true, frames, cuts: [...new Set(cuts)].sort((a, b) => a - b) });
} catch (e) {
  ff.kill('SIGKILL');
  parentPort.postMessage({ error: e.message });
}
