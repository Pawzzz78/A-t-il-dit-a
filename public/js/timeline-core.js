// Calculs de la timeline du studio (sans DOM, testés avec node:test) : zone choisie, zoom, repères de temps, vignettes à afficher.
// Tous les instants sont en millisecondes. Une zone est { start_ms, end_ms } ; une vue est { from_ms, span_ms }.

export const TL = { minSpanMs: 15_000, defaultZoneMs: 30_000, tickTarget: 6, minTilePx: 64 };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Déplace une borne de la zone sans jamais dépasser la durée maximale ni descendre sous la durée minimale : l'extension est bloquée.
 * `limited` dit pourquoi la borne demandée n'a pas été atteinte : 'max' (durée maximale), 'min', 'edge' (début ou fin de la vidéo) ou null.
 */
export function resizeZone(zone, edge, ms, { durationMs, minMs, maxMs }) {
  if (edge === 'start') {
    const lo = Math.max(0, zone.end_ms - maxMs);
    const hi = zone.end_ms - minMs;
    const start_ms = clamp(ms, lo, hi);
    const limited = ms < lo ? (lo > 0 ? 'max' : 'edge') : ms > hi ? 'min' : null;
    return { zone: { start_ms, end_ms: zone.end_ms }, limited };
  }
  const lo = zone.start_ms + minMs;
  const hi = Math.min(durationMs, zone.start_ms + maxMs);
  const end_ms = clamp(ms, lo, hi);
  const limited = ms > hi ? (hi < durationMs ? 'max' : 'edge') : ms < lo ? 'min' : null;
  return { zone: { start_ms: zone.start_ms, end_ms }, limited };
}

/** Déplace la zone entière (même durée) pour que son début tombe sur `startMs`, sans sortir de la vidéo. */
export function moveZone(zone, startMs, durationMs) {
  const len = zone.end_ms - zone.start_ms;
  const start_ms = clamp(startMs, 0, Math.max(0, durationMs - len));
  return { start_ms, end_ms: start_ms + len };
}

/** Nouvelle zone de `lenMs` centrée sur `centerMs` (ramenée dans la vidéo, jamais plus longue que `maxMs`). */
export function zoneAround(centerMs, lenMs, { durationMs, minMs, maxMs }) {
  const len = clamp(lenMs, Math.min(minMs, durationMs), Math.min(maxMs, durationMs));
  return moveZone({ start_ms: 0, end_ms: len }, centerMs - len / 2, durationMs);
}

/** Ramène une zone dans les limites (durée min/max, bornes de la vidéo) ; la fin cède d'abord. */
export function fitZone(zone, { durationMs, minMs, maxMs }) {
  const start_ms = clamp(zone.start_ms, 0, Math.max(0, durationMs - minMs));
  const end_ms = clamp(zone.end_ms, start_ms + minMs, Math.min(durationMs, start_ms + maxMs));
  return { start_ms, end_ms };
}

/** Repère le plus proche de `ms` (tableau trié) s'il est à moins de `thresholdMs`, sinon `ms`. */
export function snapTime(ms, marks, thresholdMs) {
  if (!marks.length || thresholdMs <= 0) return ms;
  let lo = 0;
  let hi = marks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid] < ms) lo = mid + 1;
    else hi = mid;
  }
  let best = marks[lo];
  if (lo > 0 && Math.abs(marks[lo - 1] - ms) <= Math.abs(best - ms)) best = marks[lo - 1];
  return Math.abs(best - ms) <= thresholdMs ? best : ms;
}

/** Aimante une zone déplacée : son début sur un début de ligne, ou sa fin sur une fin de ligne (le plus proche des deux). */
export function snapMove(zone, starts, ends, thresholdMs) {
  const len = zone.end_ms - zone.start_ms;
  const s = snapTime(zone.start_ms, starts, thresholdMs);
  const e = snapTime(zone.end_ms, ends, thresholdMs);
  const ds = Math.abs(s - zone.start_ms);
  const de = Math.abs(e - zone.end_ms);
  if (ds === 0 && de === 0) return zone;
  if (ds > 0 && (de === 0 || ds <= de)) return { start_ms: s, end_ms: s + len };
  return { start_ms: e - len, end_ms: e };
}

// --- vue (zoom et défilement) -----------------------------------------------------------------------------

export function clampView(view, durationMs) {
  const span_ms = clamp(view.span_ms, Math.min(TL.minSpanMs, durationMs), durationMs);
  return { from_ms: clamp(view.from_ms, 0, durationMs - span_ms), span_ms };
}

/** Zoom de `factor` (> 1 : on s'approche) en gardant `anchorMs` à la même place à l'écran. */
export function zoomView(view, factor, anchorMs, durationMs) {
  const span_ms = view.span_ms / factor;
  const ratio = (anchorMs - view.from_ms) / view.span_ms;
  return clampView({ from_ms: anchorMs - ratio * clamp(span_ms, 1, durationMs), span_ms }, durationMs);
}

/** Vue centrée sur la zone, avec de la marge autour (la zone occupe environ le tiers de la largeur). */
export function viewAround(zone, durationMs) {
  const len = zone.end_ms - zone.start_ms;
  const span_ms = Math.max(len * 3, 60_000);
  return clampView({ from_ms: (zone.start_ms + zone.end_ms) / 2 - span_ms / 2, span_ms }, durationMs);
}

/** Vue qui contient la zone (avec un peu de marge) : zoom le plus serré possible. */
export function viewFitting(zone, durationMs) {
  const len = zone.end_ms - zone.start_ms;
  const span_ms = Math.max(len * 1.25, TL.minSpanMs);
  return clampView({ from_ms: (zone.start_ms + zone.end_ms) / 2 - span_ms / 2, span_ms }, durationMs);
}

export const viewShows = (view, ms) => ms >= view.from_ms && ms <= view.from_ms + view.span_ms;

const STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** Graduations de la règle : le plus petit pas rond qui donne au plus `target` repères dans la vue. */
export function rulerTicks(view, target = TL.tickTarget) {
  const step = (STEPS_S.find((s) => view.span_ms / (s * 1000) <= target) ?? STEPS_S.at(-1)) * 1000;
  const ticks = [];
  for (let t = Math.ceil(view.from_ms / step) * step; t <= view.from_ms + view.span_ms; t += step) ticks.push(t);
  return { step_ms: step, ticks };
}

// --- vignettes -------------------------------------------------------------------------------------------

/**
 * Vignettes à afficher dans la vue : { left, width, col, row } en pixels, une toutes les `stride` images de la grille pour qu'aucune
 * ne soit plus étroite que `minTilePx`. `plan` vient du serveur : { step_s, frames, cols }.
 */
export function visibleTiles(view, plan, widthPx, minTilePx = TL.minTilePx) {
  if (!plan?.frames || widthPx <= 0) return [];
  const stepMs = plan.step_s * 1000;
  const pxPerMs = widthPx / view.span_ms;
  const stride = Math.max(1, Math.ceil(minTilePx / (stepMs * pxPerMs)));
  const tiles = [];
  const first = Math.floor(view.from_ms / (stepMs * stride)) * stride;
  for (let i = first; i * stepMs < view.from_ms + view.span_ms && i < plan.frames; i += stride) {
    const cell = Math.min(plan.frames - 1, i + Math.floor(stride / 2));
    tiles.push({ left: (i * stepMs - view.from_ms) * pxPerMs, width: stride * stepMs * pxPerMs, col: cell % plan.cols, row: Math.floor(cell / plan.cols) });
  }
  return tiles;
}

// --- divers ----------------------------------------------------------------------------------------------

/** Part de la zone `a` qui recouvre la zone `b` (0 à 1). */
export function overlapRatio(a, b) {
  const len = a.end_ms - a.start_ms;
  if (len <= 0) return 0;
  return Math.max(0, Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms)) / len;
}

/** « 42 s », « 3 min 37 s », « 4 min ». */
export function durLabel(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}
