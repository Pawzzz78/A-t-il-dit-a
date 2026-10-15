/**
 * Mesure du fond arrondi des sous-titres, par libass lui-même.
 *
 * Pour un fond aux coins arrondis, il faut connaître la position exacte de chaque ligne de texte (largeur, retours à la ligne).
 * Plutôt que d'estimer des largeurs de polices, on fait rendre chaque groupe de mots par libass sur un fond noir avec un fond
 * blanc rectangulaire (1 px de marge) : la largeur de chaque ligne se lit sur l'image, avec les mêmes polices, la même mise à la
 * ligne et le même crénage que le clip final. Les rectangles obtenus (marge du fond, relatifs au centre du bloc) servent ensuite à
 * dessiner le fond arrondi (buildAss).
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OUT, PROBE, assEscape, boxPad, buildProbeAss, displayText, fitScale, probeBand } from '../../public/js/studio-core.js';

export const escFilterPath = (p) => {
  // Windows (local dev): forward slashes, quoted parts, and apostrophes escaped for both filtergraph parsing levels
  if (process.platform === 'win32') return String(p).replace(/\\/g, '/').replace(/:/g, '\\:').split("'").map((s) => `'${s}'`).join("\\\\\\'");
  return String(p).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,');
};

/** Lit les lignes d'une image de mesure (octets de gris) : [{ x0, y0, x1, y1 }] relatifs au point d'ancrage du bloc. */
export function rectsFromFrame(frame, { band, pitch, pad, cx }) {
  const rows = [];
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < band; y++) {
    let min = -1;
    let max = -1;
    const base = y * OUT.w;
    for (let x = 0; x < OUT.w; x++) {
      if (frame[base + x] > 127) {
        if (min < 0) min = x;
        max = x;
      }
    }
    rows.push(min < 0 ? null : [min, max]);
    if (min >= 0) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  if (top < 0) return [];
  const lines = Math.max(1, Math.round((bottom - top + 1 - 2) / pitch)); // n lignes = n × hauteur de ligne + 1 px de marge de chaque côté
  const rects = [];
  const cropY = (OUT.h - band) / 2;
  for (let i = 0; i < lines; i++) {
    const cell = top + 1 + i * pitch;
    let min = Infinity;
    let max = -Infinity;
    for (let y = Math.floor(cell + pitch * 0.4); y <= Math.ceil(cell + pitch * 0.6); y++) {
      const r = rows[y];
      if (!r) continue;
      min = Math.min(min, r[0]);
      max = Math.max(max, r[1]);
    }
    if (min === Infinity) continue;
    rects.push({
      x0: min + 1 - pad - cx,
      x1: max + pad - cx,
      y0: cropY + cell - pad - PROBE.y,
      y1: cropY + cell + pitch + pad - PROBE.y,
    });
  }
  return rects;
}

/**
 * Rectangles du fond de chaque groupe de mots : un tableau de rectangles par groupe (même ordre que `groups`).
 * `font` : police du style (ass_name, em_ratio…), `fontsDir` : dossier des polices.
 */
export async function measureBoxes({ groups, style, font, fontsDir, timeoutMs = 60_000 }) {
  const pad = boxPad(style);
  const cx = Math.round(style.x * OUT.w);
  const band = probeBand(style);
  const assSize = Math.round(style.size / (font?.em_ratio ?? 1));
  // groupes identiques (même texte, même réduction) : mesurés une seule fois
  const unique = new Map();
  const index = groups.map((g) => {
    const texts = g.words.map((w) => assEscape(displayText(w.text, style)));
    const k = fitScale(texts, style, font);
    const key = `${k}|${texts.join(' ')}`;
    if (!unique.has(key)) unique.set(key, { group: g, k, i: unique.size });
    return unique.get(key);
  });
  if (!unique.size) return [];
  const probes = [...unique.values()];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-probe-'));
  try {
    const assPath = path.join(dir, 'probe.ass');
    await fs.writeFile(assPath, buildProbeAss({ groups: probes.map((p) => p.group), style, font }));
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'lavfi', '-i', `color=c=black:s=${OUT.w}x${OUT.h}:r=1:d=${probes.length}`,
      '-vf', `ass=${escFilterPath(assPath)}:fontsdir=${escFilterPath(fontsDir)},crop=${OUT.w}:${band}:0:${(OUT.h - band) / 2},format=gray`,
      '-frames:v', String(probes.length), '-f', 'rawvideo', '-',
    ];
    const rectsByProbe = await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const frameBytes = OUT.w * band;
      const results = [];
      let pending = [];
      let have = 0;
      let err = '';
      // A stuck ffmpeg must not hold the render slot forever
      const timer = setTimeout(() => {
        p.kill('SIGKILL');
        reject(new Error('mesure du fond : délai dépassé'));
      }, timeoutMs);
      p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
      p.stdout.on('data', (chunk) => {
        pending.push(chunk);
        have += chunk.length;
        while (have >= frameBytes) {
          const all = pending.length === 1 ? pending[0] : Buffer.concat(pending);
          const probe = probes[results.length];
          results.push(rectsFromFrame(all.subarray(0, frameBytes), { band, pitch: assSize * probe.k, pad, cx }));
          const rest = all.subarray(frameBytes);
          pending = rest.length ? [Buffer.from(rest)] : [];
          have = rest.length;
        }
      });
      p.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.on('close', () => clearTimeout(timer));
      p.on('close', (code) => (code === 0 && results.length === probes.length ? resolve(results) : reject(new Error(`mesure du fond : ffmpeg ${code} ${err.trim().slice(0, 300)}`))));
    });
    return index.map((u) => rectsByProbe[u.i]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
