// Cadrage automatique sur le visage (mode plein écran) : du « où sont les visages » au « où placer le cadre ».
// Module pur, partagé par le serveur (rendu ffmpeg), le navigateur (aperçu en direct) et les tests.
//
// Entrée : les visages détectés dans l'interview, `frames[i]` = liste de [x, y, w, h, score] (fractions 0–1 de l'image) à l'instant
// i / fps. Sortie : pour chaque extrait, des points-clés { t, x } où t est en secondes depuis le début de l'extrait et x est la
// position du cadre (cropX : 0 = bord gauche de la source, 1 = bord droit, même convention que le réglage manuel).
//
// Le cadre se comporte comme un cadreur : il reste immobile tant que le visage reste près du centre (zone morte), puis se
// déplace en douceur (départ et arrivée progressifs, vitesse limitée). Jamais de tremblement, même si la détection hésite ;
// seule une coupe de montage fait « sauter » le cadre, comme la coupe elle-même.

export const FRAMING = {
  linkGapS: 3, // un visage perdu moins longtemps que ça garde son identité
  maxGapS: 3, // au-delà, la position est maintenue plutôt qu'interpolée
  deadWin: 0.12, // zone morte : part de la largeur du cadre où le visage peut bouger sans que le cadre suive
  vmaxWin: 0.45, // vitesse maximale du cadre, en largeurs de cadre par seconde
  amaxWin: 0.8, // accélération maximale, en largeurs de cadre par seconde²
  stepS: 0.05, // pas d'observation du visage
  minMoveS: 0.8, // durée minimale d'un déplacement du cadre
  minShare: 0.2, // un visage compte s'il apparaît au moins 20 % du temps du visage le plus présent
  samePerson: 0.363, // similarité d'empreintes à partir de laquelle un visage est celui de la personne de référence (seuil SFace d'OpenCV)
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

/** Largeur de la fenêtre 9:16 en fraction de la largeur de la source (aspect = largeur / hauteur de la source). */
export const windowWidth = (aspect) => 9 / 16 / aspect;

/**
 * Regroupe les détections en visages suivis dans le temps. Renvoie [{ pts: [{ t, cx, cy, h, s }], weight, share, meanX }] ;
 * `weight` (taille × netteté × présence dans [fromS, toS]) sert à désigner « le visage le plus gros ».
 */
export function faceTracks(frames, fps, aspect, fromS, toS, ident = null) {
  const i0 = Math.max(0, Math.ceil(fromS * fps - 1e-9));
  const i1 = Math.min(frames.length - 1, Math.ceil(toS * fps - 1e-9) - 1); // [fromS, toS[ : l'image tombant pile sur la fin appartient au plan suivant
  const tracks = [];
  for (let i = i0; i <= i1; i++) {
    const t = i / fps;
    const dets = (frames[i] ?? []).map((d, di) => [...d.slice(0, 5), di]).sort((a, b) => b[2] * b[3] - a[2] * a[3]);
    const taken = new Set();
    for (const [x, y, w, h, s, di] of dets) {
      const cx = x + w / 2;
      const cy = y + h / 2;
      let best = null;
      let bestD = Infinity;
      for (const tr of tracks) {
        if (taken.has(tr)) continue;
        const last = tr.pts[tr.pts.length - 1];
        if (t - last.t > FRAMING.linkGapS + 1e-9) continue;
        const d = Math.hypot((cx - last.cx) * aspect, cy - last.cy); // en hauteurs d'image
        if (d < Math.max(0.12, 1.5 * Math.max(h, last.h)) && d < bestD) {
          best = tr;
          bestD = d;
        }
      }
      if (!best) {
        best = { pts: [] };
        tracks.push(best);
      }
      taken.add(best);
      best.pts.push({ t, cx, cy, h, s, w, fi: i, di });
    }
  }
  const inRange = () => true;
  const out = tracks
    .map((tr) => {
      const mine = tr.pts.filter(inRange);
      // identité : meilleure similarité avec la personne de référence parmi les points où le visage a été comparé
      const sims = ident ? tr.pts.map((p) => ident.get(`${p.fi}:${p.di}`)).filter((v) => v !== undefined) : [];
      return {
        ident: sims.length ? Math.max(...sims) : null,
        pts: tr.pts,
        count: mine.length,
        weight: mine.reduce((a, p) => a + p.w * aspect * p.h * p.s, 0),
        meanX: mine.length ? mine.reduce((a, p) => a + p.cx, 0) / mine.length : 0.5,
      };
    })
    .filter((tr) => tr.count > 0);
  const most = Math.max(0, ...out.map((tr) => tr.count));
  for (const tr of out) tr.share = most ? tr.count / most : 0;
  return out;
}

/**
 * Visage à suivre : « lisnard » = celui qui ressemble à la personne de référence (sinon le plus gros) ; « auto » = le plus gros ;
 * « left » / « right » = le plus à gauche / à droite parmi les visages présents.
 */
export function pickTrack(tracks, subject = 'auto') {
  const real = tracks.filter((tr) => tr.share >= FRAMING.minShare && tr.count >= 2);
  const pool = real.length ? real : tracks.filter((tr) => tr.share === 1);
  if (!pool.length) return null;
  if (subject === 'lisnard') {
    const hits = pool.filter((tr) => tr.ident !== null && tr.ident >= FRAMING.samePerson).sort((a, b) => b.ident - a.ident);
    if (hits.length) return hits[0];
  }
  if (subject === 'left') return pool.reduce((a, b) => (b.meanX < a.meanX ? b : a));
  if (subject === 'right') return pool.reduce((a, b) => (b.meanX > a.meanX ? b : a));
  return pool.reduce((a, b) => (b.weight > a.weight ? b : a));
}

/** Nombre de visages distincts présents de façon significative dans l'extrait. */
export const faceCount = (tracks) => tracks.filter((tr) => tr.share >= FRAMING.minShare && tr.count >= 2).length;

const median3 = (a) => a.map((_, i) => [a[Math.max(0, i - 1)], a[i], a[Math.min(a.length - 1, i + 1)]].sort((p, q) => p - q)[1]);

/** Courbe douce (départ et arrivée à vitesse nulle) entre deux points-clés. */
const ease = (u) => u * u * (3 - 2 * u);

/**
 * Trajectoire du cadre pour un visage suivi, entre fromS et toS (secondes de la vidéo).
 * Renvoie des points-clés [{ t, x }] (t depuis le début de l'extrait). Entre deux points consécutifs, le cadre glisse avec la
 * courbe douce `ease` (deux points de même x = cadre immobile) : le cadre reste immobile, puis se déplace d'un point à l'autre
 * en démarrant et en s'arrêtant doucement, à une vitesse et une accélération bornées.
 */
export function framingPath(track, fromS, toS, aspect, startX = null) {
  const dur = toS - fromS;
  const cw = windowWidth(aspect);
  if (cw >= 0.999) return [{ t: 0, x: 0.5 }, { t: round(dur, 3), x: 0.5 }]; // source plus étroite que l'écran : rien à cadrer
  const k = cw / (1 - cw); // largeur de cadre exprimée en unités de cropX
  const pts = track.pts;
  const target = median3(pts.map((p) => clamp((p.cx - cw / 2) / (1 - cw), 0, 1)));
  const at = (t) => {
    if (t <= pts[0].t) return target[0];
    if (t >= pts[pts.length - 1].t) return target[target.length - 1];
    let j = 0;
    while (j < pts.length - 2 && pts[j + 1].t < t) j++;
    const [p, q] = [pts[j], pts[j + 1]];
    if (q.t - p.t > FRAMING.maxGapS) return t - p.t < q.t - t ? target[j] : target[j + 1]; // visage perdu : on tient la dernière position
    return target[j] + ((target[j + 1] - target[j]) * (t - p.t)) / (q.t - p.t);
  };

  const dead = FRAMING.deadWin * k;
  const vmax = FRAMING.vmaxWin * k;
  const amax = FRAMING.amaxWin * k;
  // au début d'un extrait on est déjà sur le visage ; après une fausse coupe (même plan), on garde la position pour ne pas sauter
  let pos = startX !== null && Math.abs(at(fromS) - startX) <= dead ? startX : at(fromS);
  const keys = [{ t: 0, x: pos }];
  let busyUntil = 0;
  for (let n = 1; n * FRAMING.stepS <= dur + 1e-9; n++) {
    const t = n * FRAMING.stepS;
    if (t < busyUntil) continue; // un déplacement est en cours : on le laisse finir
    const err = at(fromS + t) - pos;
    if (Math.abs(err) <= dead) continue;
    // durée du déplacement selon la distance : vitesse de pointe de la courbe douce = 1,5 × d / durée, accélération = 6 × d / durée²
    const lengthFor = (d) => Math.max(FRAMING.minMoveS, (1.5 * d) / vmax, Math.sqrt((6 * d) / amax));
    const where = (u) => at(fromS + Math.min(dur, u));
    let len = lengthFor(Math.abs(err));
    let dest = where(t + len); // on vise l'endroit où sera le visage à la fin du déplacement
    len = lengthFor(Math.abs(dest - pos));
    dest = where(t + len);
    const drift = dest - where(t);
    if (Math.abs(drift) > dead * 0.5) dest += Math.sign(drift) * dead * 0.8; // visage en marche : on prend de l'avance pour ne pas repartir aussitôt
    dest = clamp(dest, 0, 1);
    len = lengthFor(Math.abs(dest - pos));
    if (keys[keys.length - 1].t < t) keys.push({ t, x: pos });
    keys.push({ t: t + len, x: dest });
    pos = dest;
    busyUntil = t + len;
  }
  if (keys[keys.length - 1].t < dur) keys.push({ t: dur, x: pos });
  return keys.map((p) => ({ t: round(p.t, 3), x: round(p.x, 4) }));
}

/** Découpe [fromS, toS] aux changements de plan (cuts, en secondes) ; on ignore ceux qui laisseraient un plan de moins de 0,4 s. */
export function splitShots(fromS, toS, cuts = []) {
  const inside = cuts.filter((c) => c > fromS + 0.4 && c < toS - 0.4).sort((a, b) => a - b);
  const bounds = [fromS];
  for (const c of inside) if (c - bounds[bounds.length - 1] >= 0.4) bounds.push(c);
  bounds.push(toS);
  return bounds.slice(1).map((end, i) => ({ from: bounds[i], to: end }));
}

/**
 * Cadrage d'un extrait : { keys, faces, coverage } (coverage : part de l'extrait où le visage suivi a été détecté),
 * ou null si aucun visage n'a été trouvé. Chaque plan de l'interview (entre deux coupes de montage) est cadré séparément ;
 * à la coupe le cadre saute directement sur le visage du nouveau plan, comme le fait la coupe elle-même.
 */
export function framingForExtract({ frames, fps, aspect, startMs, endMs, subject = 'auto', cuts = [], ident = null }) {
  const [fromS, toS] = [startMs / 1000, endMs / 1000];
  const shots = splitShots(fromS, toS, cuts).map((sh) => {
    const tracks = faceTracks(frames, fps, aspect, sh.from, sh.to, ident);
    const track = pickTrack(tracks, subject);
    return { ...sh, tracks, track };
  });
  if (!shots.some((sh) => sh.track)) return null;
  let detected = 0;
  let faces = 0;
  let prevEnd = null;
  // plans à plusieurs visages : combien ont été tranchés grâce à la reconnaissance de la personne de référence
  let crowded = 0;
  let recognized = 0;
  const parts = shots.map((sh) => {
    if (!sh.track) return { ...sh, keys: null };
    detected += sh.track.count;
    faces = Math.max(faces, faceCount(sh.tracks));
    if (faceCount(sh.tracks) > 1) {
      crowded++;
      if (sh.track.ident !== null && sh.track.ident >= FRAMING.samePerson) recognized++;
    }
    const keys = framingPath(sh.track, sh.from, sh.to, aspect, prevEnd);
    prevEnd = keys.at(-1).x;
    return { ...sh, keys };
  });
  // plan sans visage : on garde la position du plan précédent (ou, au début, celle du premier plan avec un visage)
  let hold = parts.find((p) => p.keys).keys[0].x;
  for (const p of parts) {
    if (p.keys) hold = p.keys.at(-1).x;
    else p.keys = [{ t: 0, x: hold }, { t: round(p.to - p.from, 3), x: hold }];
  }
  const keys = [];
  for (const p of parts) {
    const off = p.from - fromS;
    for (const k of p.keys) {
      const point = { t: round(off + k.t, 3), x: k.x };
      const prev = keys[keys.length - 1];
      if (prev && point.t === prev.t && point.x === prev.x) continue;
      keys.push(point);
    }
  }
  const expected = Math.max(1, Math.round((toS - fromS) * fps));
  return { keys, faces, coverage: round(Math.min(1, detected / expected), 2), crowded, recognized };
}

/**
 * Cadrage de tout le clip : un segment par extrait, sur la ligne de temps du clip (t0, t1 en secondes ; les points-clés restent
 * relatifs à t0). `keys` vaut null quand aucun visage n'a été trouvé : le cadre manuel s'applique alors à ce segment.
 */
export function framingForClip({ frames, fps, aspect, extracts, subject = 'auto', cuts = [], ident = null }) {
  let t0 = 0;
  let faces = 0;
  let covered = 0;
  let crowded = 0;
  let recognized = 0;
  const segments = extracts.map((e) => {
    const dur = (e.end_ms - e.start_ms) / 1000;
    const r = framingForExtract({ frames, fps, aspect, startMs: e.start_ms, endMs: e.end_ms, subject, cuts, ident });
    const seg = { t0: round(t0, 3), t1: round(t0 + dur, 3), keys: r ? r.keys : null };
    t0 += dur;
    if (r) {
      faces = Math.max(faces, r.faces);
      covered += r.coverage * dur;
      crowded += r.crowded;
      recognized += r.recognized;
    }
    return seg;
  });
  return { segments, faces, coverage: t0 ? round(covered / t0, 2) : 0, crowded, recognized };
}

/** Position du cadre à l'instant t (secondes depuis le début du segment). */
export function cropXAt(keys, t) {
  if (t <= keys[0].t) return keys[0].x;
  for (let i = 1; i < keys.length; i++) {
    if (t < keys[i].t) return keys[i - 1].x + (keys[i].x - keys[i - 1].x) * ease((t - keys[i - 1].t) / (keys[i].t - keys[i - 1].t)); // deux points au même instant : saut (coupe)
  }
  return keys[keys.length - 1].x;
}

/** Position du cadre à l'instant t du clip (secondes), fond de repli `fallback` si le segment n'a pas de visage. */
export function cropXAtClip(segments, t, fallback = 0.5) {
  const seg = segments.find((s) => t >= s.t0 && t < s.t1) ?? segments[segments.length - 1];
  return seg?.keys ? cropXAt(seg.keys, t - seg.t0) : fallback;
}

/** Même courbe sous forme d'expression ffmpeg (variable `t` = secondes depuis le début de l'extrait). */
export function cropXExpr(keys) {
  const n = (v) => String(round(v, 4));
  if (keys.length < 2 || keys.every((p) => p.x === keys[0].x)) return n(keys[0].x);
  let expr = n(keys[keys.length - 1].x);
  for (let i = keys.length - 1; i >= 1; i--) {
    const [a, b] = [keys[i - 1], keys[i]];
    if (b.t - a.t < 1e-6) continue; // saut : la condition du segment suivant s'en charge
    const u = `((t-${n(a.t)})/${n(b.t - a.t)})`;
    const seg = a.x === b.x ? n(a.x) : `${n(a.x)}+(${n(b.x - a.x)})*${u}*${u}*(3-2*${u})`;
    expr = `if(lt(t,${n(b.t)}),${seg},${expr})`;
  }
  return expr;
}
