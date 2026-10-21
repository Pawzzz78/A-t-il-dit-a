/**
 * Uniquification des clips : deuxième passe ffmpeg avec des micro-transforms imperceptibles, pour que chaque
 * fichier distribué soit différent des autres tout en restant identique au regard du spectateur.
 *
 *  - Aucun retournement, aucune rotation, aucun changement de vitesse : les sous-titres incrustés restent
 *    lisibles et synchrones (l'image et l'audio conservent exactement la même durée).
 *  - Déterministe : un seed (clip, personne) reproduit toujours la même chaîne ; une autre personne obtient
 *    une autre chaîne. Les valeurs sont tirées d'un PRNG (mulberry32) dans des bandes calibrées.
 *  - Bandes d'après le profil « soft » de yt_uniquifier (brightness 0.006, contrast 1.01, saturation 1.015,
 *    noise 2, pitch 1.0004), étalées en intervalles pour varier d'une personne à l'autre.
 *
 * Module pur : aucune dépendance au reste de l'application, testable sans ffmpeg.
 */
import crypto from 'node:crypto';

/** Définitions de sortie du studio (voir render.js) : la deuxième passe garde exactement la même taille. */
export const SIZES = { hd: { w: 1080, h: 1920 }, fast: { w: 720, h: 1280 } };

/**
 * Bandes par niveau. `gentle` : invisible même en regardant à deux reprises ; `medium` : plus marqué,
 * toujours imperceptible sur un partage (les plateformes recompressent de toute façon).
 * Les champs « signed » sont des amplitudes : le signe est tiré au hasard (jamais de zéro).
 */
export const LEVELS = {
  gentle: {
    brightness: 0.010, contrast: 0.010, gamma: 0.005, saturation: 0.015, hue: 0.5,
    crop: 0.0025, sharpen: [0.10, 0.25], noise: [0.8, 1.6],
    pitch: 0.003, eqGain: 0.8, shelf: 0.5, volume: 0.005,
  },
  medium: {
    brightness: 0.020, contrast: 0.020, gamma: 0.010, saturation: 0.030, hue: 1.0,
    crop: 0.0040, sharpen: [0.15, 0.40], noise: [1.0, 2.5],
    pitch: 0.006, eqGain: 1.5, shelf: 0.8, volume: 0.010,
  },
};

/** PRNG déterministe (32 bits) : mêmes seed, même séquence, sur toutes les plateformes. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed 32 bits stable à partir d'une valeur quelconque (ex. « clip|personne »). */
export function seedFrom(value) {
  return crypto.createHash('sha256').update(String(value)).digest().readUInt32LE(0);
}

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const r4 = (x) => Math.round(x * 10000) / 10000;

/**
 * Paramètres d'une passe d'unicité, tirés de `seed` dans les bandes de `level`.
 * Tous les tirages sont arrondis à une précision stable : la chaîne de filtres est lisible et reproductible.
 */
export function uniqParams(seed, level = 'gentle') {
  const conf = LEVELS[level] ?? LEVELS.gentle;
  const rnd = mulberry32(seed);
  const pick = (min, max) => min + rnd() * (max - min);
  const signed = (range) => (rnd() < 0.5 ? -1 : 1) * pick(range * 0.4, range);
  return {
    level,
    brightness: r3(signed(conf.brightness)),
    contrast: r3(1 + signed(conf.contrast)),
    gamma: r3(1 + signed(conf.gamma)),
    saturation: r3(1 + signed(conf.saturation)),
    hue: r1(signed(conf.hue)),
    crop: r4(pick(conf.crop * 0.35, conf.crop)), // fraction retirée par côté (1080 px : ≈ 1 à 3 px en gentle)
    sharpen: r2(pick(conf.sharpen[0], conf.sharpen[1])),
    noise: r1(pick(conf.noise[0], conf.noise[1])),
    pitch: r4(1 + signed(conf.pitch)),
    eqFreq: Math.round(pick(2500, 5000) / 50) * 50,
    eqGain: r1(signed(conf.eqGain)),
    shelfGain: r1(signed(conf.shelf)),
    volume: r3(1 + signed(conf.volume)),
  };
}

/** Chaîne vidéo : micro-recadrage centré, couleur, léger netteté, grain. Durée préservée, pas de retournement. */
export function videoFilters(p, { w, h }) {
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const cropW = even(w * (1 - 2 * p.crop));
  const cropH = even(h * (1 - 2 * p.crop));
  return [
    `crop=${cropW}:${cropH}:(iw-ow)/2:(ih-oh)/2`,
    `scale=${w}:${h}`,
    `eq=brightness=${p.brightness}:contrast=${p.contrast}:gamma=${p.gamma}:saturation=${p.saturation}`,
    `hue=h=${p.hue}`,
    `unsharp=5:5:${p.sharpen}`,
    `noise=alls=${p.noise}:allf=t+u`,
  ].join(',');
}

/** Chaîne audio : micro-décalage de hauteur (durée préservée par rubberband), EQ subtil, gain. Inaudible. */
export function audioFilters(p, { rubberband = true } = {}) {
  const f = [];
  if (rubberband) f.push(`rubberband=pitch=${p.pitch}:tempo=1.0`);
  f.push(`equalizer=f=${p.eqFreq}:t=h:w=900:g=${p.eqGain}`);
  f.push(`highshelf=f=8500:g=${p.shelfGain}`);
  f.push(`volume=${p.volume}`);
  return f.join(',');
}

/**
 * Arguments ffmpeg d'une passe d'unicité (deuxième passe sur un clip déjà rendu).
 * Renvoie { params, args } : `params` est conservé pour le sidecar et les tests.
 */
export function buildUniqArgs({ file, out, quality = 'hd', seed, level = 'gentle', rubberband = true }) {
  const size = SIZES[quality] ?? SIZES.hd;
  const params = uniqParams(seed, level);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-y',
    '-i', file,
    '-vf', videoFilters(params, size),
    '-af', audioFilters(params, { rubberband }),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-r', '30',
    '-profile:v', 'high', '-level', '4.1',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000',
    '-movflags', '+faststart',
    out,
  ];
  return { params, args };
}

// --- capacités du ffmpeg du serveur ---------------------------------------------------------------

let caps;
const NAME = /^\s*[TS.]+\s+([a-z][a-z0-9_]*)\s+[AVXN(]/;
export function parseFilterNames(output) {
  const names = new Set();
  for (const line of String(output).split('\n')) {
    const m = line.match(NAME);
    if (m) names.add(m[1]);
  }
  return names;
}

/**
 * Ce que le ffmpeg du serveur sait faire (sondage unique). `rubberband` est facultatif : sans lui la chaîne
 * audio se passe du décalage de hauteur et la vidéo porte seule l'unicité. `ok` : la chaîne minimale est là.
 */
export async function uniqCapabilities() {
  if (caps) return caps;
  const { spawn } = await import('node:child_process');
  const filters = await new Promise((resolve) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(out));
  });
  const names = parseFilterNames(filters);
  const need = ['eq', 'hue', 'crop', 'scale', 'unsharp', 'noise', 'equalizer', 'highshelf', 'volume'];
  caps = {
    filters: [...names].sort(),
    rubberband: names.has('rubberband'),
    ok: need.every((n) => names.has(n)),
  };
  return caps;
}

/** Remet le sondage à zéro (tests). */
export function resetUniqCapabilities() {
  caps = undefined;
}
