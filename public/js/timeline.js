// Timeline du studio : toute l'interview sur une règle graduée avec vignettes, une zone à déplacer ou à étirer (durée maximale bloquée),
// zoom (boutons, pincement, Ctrl + molette), repères des extraits proposés par l'IA et vue d'ensemble. Pointer Events : doigt et souris.
import { TL, clampView, durLabel, fitZone, moveZone, resizeZone, rulerTicks, snapMove, snapTime, viewAround, viewFitting, viewShows, visibleTiles, zoomView, zoneAround } from './timeline-core.js';
import { el } from './studio-preview.js';

const SNAP_KEY = 'studio.timeline.snap';
const SNAP_PX = 10;
const DRAG_PX = 6;

/**
 * options : { durationMs, lines: [{ start_ms, end_ms }], suggestions: [{ start_ms, end_ms, title, score }], minMs, maxMs, fmt(ms),
 *             textAt(ms) -> string, onChange(zone, how), onLimit(kind), onPick(suggestion) }
 * `onChange` est appelé à la fin d'un geste (ou à chaque appui de touche) ; `how` : 'move' | 'start' | 'end' | 'place'.
 */
export function createTimeline(opts) {
  const { durationMs, minMs, fmt } = opts;
  const limits = { durationMs, minMs, maxMs: opts.maxMs }; // maxMs baisse si d'autres passages (anciens brouillons) prennent déjà de la durée
  const starts = opts.lines.map((l) => l.start_ms);
  const ends = opts.lines.map((l) => l.end_ms);
  const st = { zone: null, others: [], view: { from_ms: 0, span_ms: durationMs }, width: 0, plan: null, sprite: null, pickedFrom: null, snap: true };
  try {
    st.snap = localStorage.getItem(SNAP_KEY) !== '0';
  } catch {
    // stockage indisponible : aimantation active
  }

  const ruler = el('div', { class: 'tl-ruler', 'aria-hidden': 'true' });
  const tiles = el('div', { class: 'tl-tiles', 'aria-hidden': 'true' });
  const band = el('div', { class: 'tl-band' });
  const others = el('div', { class: 'tl-others', 'aria-hidden': 'true' });
  const handle = (edge, label) => el('button', { type: 'button', class: `tl-handle tl-h-${edge}`, 'data-h': edge, 'aria-label': label }, el('span', { class: 'tl-grip', 'aria-hidden': 'true' }));
  const hStart = handle('start', 'Début de la zone (flèches pour ajuster)');
  const hEnd = handle('end', 'Fin de la zone (flèches pour ajuster)');
  const zoneBody = el('div', { class: 'tl-zone-body', 'data-h': 'move', tabindex: '0', role: 'group', 'aria-label': 'Zone choisie : flèches pour la déplacer' });
  const zoneEl = el('div', { class: 'tl-zone', hidden: true }, zoneBody, hStart, hEnd);
  const track = el('div', { class: 'tl-track' }, tiles, others, band, zoneEl);
  const miniZone = el('span', { class: 'tl-mini-zone' });
  const miniWin = el('span', { class: 'tl-mini-win' });
  const miniMarks = el('span', { class: 'tl-mini-marks', 'aria-hidden': 'true' });
  const mini = el('div', { class: 'tl-mini', role: 'presentation' }, miniMarks, miniZone, miniWin);
  const readout = el('output', { class: 'tl-readout', 'aria-live': 'polite' });
  const detail = el('p', { class: 'tl-detail' });
  const status = el('p', { class: 'tl-status', role: 'status' });
  const btn = (label, title, fn, extra = {}) => el('button', { type: 'button', class: 'st-mini wide', title, 'aria-label': title, onclick: fn, ...extra }, label);
  const snapBox = el('input', { type: 'checkbox', checked: st.snap });
  snapBox.addEventListener('change', () => {
    st.snap = snapBox.checked;
    try {
      localStorage.setItem(SNAP_KEY, st.snap ? '1' : '0');
    } catch {
      // idem
    }
  });
  const tools = el('div', { class: 'tl-tools' },
    btn('−', 'Voir plus large (zoom arrière)', () => zoomBy(1 / 2)),
    btn('+', 'Voir plus précis (zoom avant)', () => zoomBy(2)),
    btn('Tout', 'Voir toute l’interview', () => setView({ from_ms: 0, span_ms: durationMs })),
    btn('Ma zone', 'Zoomer sur ma zone', () => st.zone && setView(viewFitting(st.zone, durationMs))),
    el('label', { class: 'tl-snap', title: 'Les bornes se calent sur le début et la fin des phrases' }, snapBox, 'Caler sur les phrases'),
  );
  const root = el('div', { class: 'tl' }, readout, detail, ruler, track, mini, tools, status);

  const msToPx = (ms) => ((ms - st.view.from_ms) / st.view.span_ms) * st.width;
  const pxToMs = (px) => st.view.from_ms + (px / st.width) * st.view.span_ms;
  const threshold = () => (SNAP_PX / Math.max(1, st.width)) * st.view.span_ms;
  const trackX = (e) => e.clientX - track.getBoundingClientRect().left;

  // --- affichage -----------------------------------------------------------------------------------------

  function renderTiles() {
    const h = track.clientHeight || 64;
    const kids = [];
    if (st.plan && st.sprite) {
      for (const t of visibleTiles(st.view, st.plan, st.width)) {
        // la vignette « couvre » sa case (comme object-fit: cover) : l'image de la grille est mise à l'échelle et centrée
        const aspect = st.plan.thumb_w / st.plan.thumb_h;
        const cw = Math.max(t.width, h * aspect);
        const ch = cw / aspect;
        const inner = el('span', { class: 'tl-tile-img' });
        Object.assign(inner.style, { width: `${cw}px`, height: `${ch}px`, left: `${(t.width - cw) / 2}px`, top: `${(h - ch) / 2}px`, backgroundImage: `url("${st.sprite}")`, backgroundSize: `${st.plan.cols * cw}px ${st.plan.rows * ch}px`, backgroundPosition: `${-t.col * cw}px ${-t.row * ch}px` });
        const tile = el('span', { class: 'tl-tile' }, inner);
        Object.assign(tile.style, { left: `${t.left}px`, width: `${t.width}px` });
        kids.push(tile);
      }
    }
    tiles.replaceChildren(...kids);
    track.classList.toggle('tl-has-tiles', kids.length > 0);
  }

  function renderRuler() {
    const { ticks } = rulerTicks(st.view);
    ruler.replaceChildren(...ticks.map((t) => {
      const tick = el('span', { class: 'tl-tick' }, el('span', {}, fmtTick(t, st.view.span_ms)));
      tick.style.left = `${msToPx(t)}px`;
      return tick;
    }));
  }
  const fmtTick = (ms, span) => {
    const s = Math.round(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const ss = String(s % 60).padStart(2, '0');
    if (h || durationMs >= 3_600_000) return `${h}:${String(m % 60).padStart(2, '0')}:${ss}`;
    return span < 120_000 || s % 60 ? `${m}:${ss}` : `${m}:00`;
  };

  function renderMarkers() {
    const marks = [];
    const mm = [];
    for (const sg of opts.suggestions) {
      const x0 = msToPx(sg.start_ms);
      const x1 = msToPx(sg.end_ms);
      const picked = st.pickedFrom === sg.start_ms;
      if (x1 >= -4 && x0 <= st.width + 4) {
        const b = el('button', { type: 'button', class: picked ? 'tl-mk on' : 'tl-mk', title: `${sg.title} (${sg.score}/10)`, 'aria-label': `Extrait proposé par l’IA : ${sg.title}, ${sg.score} sur 10, de ${fmt(sg.start_ms)} à ${fmt(sg.end_ms)}`, 'aria-pressed': String(picked), onclick: () => opts.onPick(sg) });
        Object.assign(b.style, { left: `${x0}px`, width: `${Math.max(10, x1 - x0)}px` });
        marks.push(b);
      }
      const m = el('span', { class: picked ? 'on' : '' });
      Object.assign(m.style, { left: `${(sg.start_ms / durationMs) * 100}%`, width: `${Math.max(0.5, ((sg.end_ms - sg.start_ms) / durationMs) * 100)}%` });
      mm.push(m);
    }
    band.replaceChildren(...marks);
    miniMarks.replaceChildren(...mm);
    others.replaceChildren(...st.others.map((o) => {
      const d = el('span', { class: 'tl-other' });
      Object.assign(d.style, { left: `${msToPx(o.start_ms)}px`, width: `${Math.max(3, msToPx(o.end_ms) - msToPx(o.start_ms))}px` });
      return d;
    }));
  }

  function renderZone() {
    const z = st.zone;
    zoneEl.hidden = !z;
    const pct = (ms) => `${(ms / durationMs) * 100}%`;
    if (!z) {
      readout.textContent = 'Touche la timeline pour placer ta zone.';
      detail.textContent = '';
      miniZone.style.display = 'none';
    } else {
      const x0 = msToPx(z.start_ms);
      const x1 = msToPx(z.end_ms);
      Object.assign(zoneEl.style, { left: `${x0}px`, width: `${Math.max(22, x1 - x0)}px` });
      zoneEl.classList.toggle('tl-narrow', x1 - x0 < 72); // zone étroite : les poignées passent à l'extérieur pour laisser saisir le centre
      const full = z.end_ms - z.start_ms >= limits.maxMs - 50;
      zoneEl.classList.toggle('tl-full', full);
      const len = z.end_ms - z.start_ms;
      readout.textContent = `${fmt(z.start_ms)} → ${fmt(z.end_ms)} · ${durLabel(len)} sur ${durLabel(limits.maxMs)} maximum${full ? ' (durée maximale atteinte)' : ''}`;
      detail.textContent = `Début : « ${opts.textAt(z.start_ms)} »  ·  Fin : « ${opts.textAt(z.end_ms)} »`;
      zoneBody.setAttribute('aria-label', `Zone choisie, de ${fmt(z.start_ms)} à ${fmt(z.end_ms)} : flèches pour la déplacer`);
      miniZone.style.display = '';
      Object.assign(miniZone.style, { left: pct(z.start_ms), width: `max(3px, ${(len / durationMs) * 100}%)` });
    }
  }

  function renderMiniWindow() {
    Object.assign(miniWin.style, { left: `${(st.view.from_ms / durationMs) * 100}%`, width: `${(st.view.span_ms / durationMs) * 100}%` });
  }

  function renderView() {
    st.width = track.clientWidth;
    if (!st.width) return;
    renderRuler();
    renderTiles();
    renderMarkers();
    renderMiniWindow();
    renderZone();
  }

  let frame = 0;
  const later = (fn) => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      fn();
    });
  };
  const setView = (view) => {
    st.view = clampView(view, durationMs);
    later(renderView);
  };
  const zoomBy = (factor) => {
    const anchor = st.zone && viewShows(st.view, (st.zone.start_ms + st.zone.end_ms) / 2) ? (st.zone.start_ms + st.zone.end_ms) / 2 : st.view.from_ms + st.view.span_ms / 2;
    setView(zoomView(st.view, factor, anchor, durationMs));
  };

  let flashTimer = 0;
  const say = (msg, kind = '') => {
    status.textContent = msg;
    status.className = kind ? `tl-status ${kind}` : 'tl-status';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (status.textContent = ''), 3500);
  };
  const limitMessage = (kind) => (kind === 'max' ? `${durLabel(limits.maxMs)} maximum : la zone ne peut pas s’étendre davantage. Déplace l’autre bord pour la raccourcir.` : kind === 'min' ? `Une zone doit durer au moins ${durLabel(minMs)}.` : null);
  function hitLimit(kind) {
    if (!limitMessage(kind)) return;
    say(limitMessage(kind), 'err');
    zoneEl.classList.remove('tl-limit');
    void zoneEl.offsetWidth; // relance l'animation
    zoneEl.classList.add('tl-limit');
    opts.onLimit?.(kind);
  }

  // --- gestes --------------------------------------------------------------------------------------------

  const round = (z) => ({ start_ms: Math.round(z.start_ms / 10) * 10, end_ms: Math.round(z.end_ms / 10) * 10 });
  let drag = null;
  let dragged = false;
  let edgeRaf = 0;
  let lastX = 0;
  const pointers = new Map(); // doigts posés sur le fond de la règle (défilement, pincement)
  let pan = null;
  let pinch = null;

  function applyDrag(x) {
    if (!drag || !st.zone) return;
    const ms = pxToMs(x);
    if (drag.kind === 'move') {
      let z = moveZone({ start_ms: ms - drag.grab, end_ms: ms - drag.grab + drag.len }, ms - drag.grab, durationMs);
      if (st.snap) {
        const s = snapMove(z, starts, ends, threshold());
        z = moveZone(s, s.start_ms, durationMs);
      }
      st.zone = z;
    } else {
      const target = st.snap ? snapTime(ms, drag.kind === 'start' ? starts : ends, threshold()) : ms;
      const r = resizeZone(st.zone, drag.kind, target, limits);
      st.zone = r.zone;
      if (r.limited && r.limited !== drag.limited) hitLimit(r.limited);
      drag.limited = r.limited;
    }
    renderZone();
  }

  /** Près d'un bord de la règle pendant un glissement : la vue défile d'elle-même. */
  function edgeScroll() {
    edgeRaf = 0;
    if (!drag) return;
    const margin = 28;
    const speed = lastX < margin ? -(margin - lastX) / margin : lastX > st.width - margin ? (lastX - (st.width - margin)) / margin : 0;
    if (speed) {
      st.view = clampView({ ...st.view, from_ms: st.view.from_ms + Math.sign(speed) * Math.min(1, Math.abs(speed)) * st.view.span_ms * 0.012 }, durationMs);
      renderView();
      applyDrag(lastX);
      edgeRaf = requestAnimationFrame(edgeScroll);
    }
  }

  function startDrag(e, kind) {
    if (!st.zone) return;
    const ms = pxToMs(trackX(e));
    drag = { kind, id: e.pointerId, grab: ms - st.zone.start_ms, len: st.zone.end_ms - st.zone.start_ms, limited: null, before: st.zone };
    dragged = true;
    track.setPointerCapture(e.pointerId);
    zoneEl.classList.add('tl-drag');
    e.preventDefault();
  }

  track.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const h = e.target.closest?.('[data-h]');
    dragged = false;
    if (h) return startDrag(e, h.dataset.h);
    pointers.set(e.pointerId, { x: e.clientX, x0: e.clientX, moved: false });
    if (pointers.size === 1) pan = { view: st.view };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.max(10, Math.abs(a.x - b.x)), view: st.view, anchor: pxToMs((a.x + b.x) / 2 - track.getBoundingClientRect().left) };
    }
  });

  track.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) {
      lastX = trackX(e);
      applyDrag(lastX);
      if (!edgeRaf && (lastX < 28 || lastX > st.width - 28)) edgeRaf = requestAnimationFrame(edgeScroll);
      return;
    }
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX;
    if (Math.abs(p.x - p.x0) > DRAG_PX) p.moved = true;
    if (!p.moved) return;
    if (!track.hasPointerCapture(e.pointerId)) track.setPointerCapture(e.pointerId);
    dragged = true;
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const factor = Math.max(10, Math.abs(a.x - b.x)) / pinch.dist;
      st.view = zoomView(pinch.view, factor, pinch.anchor, durationMs);
    } else if (pan) {
      const dx = e.clientX - p.x0;
      st.view = clampView({ from_ms: pan.view.from_ms - (dx / st.width) * pan.view.span_ms, span_ms: pan.view.span_ms }, durationMs);
    }
    later(renderView);
  });

  function endPointer(e) {
    if (drag && e.pointerId === drag.id) {
      const how = drag.kind;
      cancelAnimationFrame(edgeRaf);
      edgeRaf = 0;
      zoneEl.classList.remove('tl-drag');
      drag = null;
      st.zone = round(st.zone);
      renderZone();
      opts.onChange({ ...st.zone }, how);
      return;
    }
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 1) {
      const [p] = [...pointers.values()];
      p.x0 = p.x;
      pan = { view: st.view };
    } else if (!pointers.size) pan = null;
  }
  track.addEventListener('pointerup', endPointer);
  track.addEventListener('pointercancel', endPointer);
  track.addEventListener('lostpointercapture', (e) => {
    if (drag && e.pointerId === drag.id) endPointer(e);
  });

  // un appui sur le fond (sans glisser) place la zone à cet endroit
  track.addEventListener('click', (e) => {
    if (dragged) {
      dragged = false;
      return;
    }
    if (e.target.closest('.tl-mk,.tl-zone')) return;
    place(pxToMs(trackX(e)));
  });

  function place(centerMs) {
    const len = st.zone ? st.zone.end_ms - st.zone.start_ms : TL.defaultZoneMs;
    let z = zoneAround(centerMs, len, limits);
    if (st.snap) {
      const s = snapMove(z, starts, ends, threshold() * 3);
      z = moveZone(s, s.start_ms, durationMs);
    }
    st.zone = round(z);
    if (msToPx(st.zone.end_ms) - msToPx(st.zone.start_ms) < 24) st.view = viewAround(st.zone, durationMs); // vue trop large pour manipuler la zone : on s'en approche
    renderView();
    opts.onChange({ ...st.zone }, 'place');
  }

  track.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setView(zoomView(st.view, Math.exp(-e.deltaY * 0.0025), pxToMs(trackX(e)), durationMs));
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      setView({ ...st.view, from_ms: st.view.from_ms + (e.deltaX / st.width) * st.view.span_ms });
    }
  }, { passive: false });

  // vue d'ensemble : appui ou glissement pour centrer la vue
  const miniGo = (e) => {
    const r = mini.getBoundingClientRect();
    const ms = ((e.clientX - r.left) / r.width) * durationMs;
    setView({ ...st.view, from_ms: ms - st.view.span_ms / 2 });
  };
  mini.addEventListener('pointerdown', (e) => {
    mini.setPointerCapture(e.pointerId);
    mini.dataset.drag = '1';
    miniGo(e);
  });
  mini.addEventListener('pointermove', (e) => {
    if (mini.dataset.drag) miniGo(e);
  });
  const miniEnd = () => delete mini.dataset.drag;
  mini.addEventListener('pointerup', miniEnd);
  mini.addEventListener('pointercancel', miniEnd);

  // clavier : flèches sur la zone (déplace) et sur les poignées (ajuste une borne)
  function onKey(e) {
    if (!st.zone || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const dir = e.key === 'ArrowLeft' ? -1 : 1;
    const h = e.target.dataset?.h;
    const big = e.shiftKey ? 10_000 : 1000;
    e.preventDefault();
    if (h === 'start' || h === 'end') {
      const delta = dir * (e.shiftKey ? 5000 : 500);
      const r = resizeZone(st.zone, h, st.zone[h === 'start' ? 'start_ms' : 'end_ms'] + delta, limits);
      if (r.limited) hitLimit(r.limited);
      st.zone = r.zone;
    } else {
      st.zone = moveZone(st.zone, st.zone.start_ms + dir * big, durationMs);
    }
    keepZoneVisible();
    renderZone();
    opts.onChange({ ...st.zone }, h || 'move');
  }
  zoneEl.addEventListener('keydown', onKey);

  function keepZoneVisible() {
    if (!st.zone) return;
    const { from_ms, span_ms } = st.view;
    if (st.zone.start_ms < from_ms) setView({ from_ms: st.zone.start_ms - span_ms * 0.1, span_ms });
    else if (st.zone.end_ms > from_ms + span_ms) setView({ from_ms: st.zone.end_ms - span_ms * 0.9, span_ms });
  }

  const resizeObs = typeof ResizeObserver === 'function' ? new ResizeObserver(() => later(renderView)) : null;
  resizeObs?.observe(track);

  return {
    root,
    /** Nouvelle zone venue de l'extérieur (extrait proposé, ligne choisie, champs de temps…) ; `reveal` : met la vue dessus. */
    setZone(zone, { reveal = false, pickedFrom } = {}) {
      st.zone = zone ? fitZone(zone, limits) : null;
      if (pickedFrom !== undefined) st.pickedFrom = pickedFrom;
      if (reveal && st.zone) st.view = viewAround(st.zone, durationMs);
      else if (st.zone && !viewShows(st.view, st.zone.start_ms) && !viewShows(st.view, st.zone.end_ms)) st.view = viewAround(st.zone, durationMs);
      later(renderView);
    },
    /** Durée maximale de la zone (millisecondes). */
    setMax(ms) {
      limits.maxMs = Math.max(minMs, ms);
      if (st.zone) st.zone = fitZone(st.zone, limits);
      later(renderView);
    },
    setOthers(list) {
      st.others = list;
      later(renderView);
    },
    setPicked(from) {
      st.pickedFrom = from;
      later(renderView);
    },
    /** Grille de vignettes prête : { url, step_s, frames, cols, rows, thumb_w, thumb_h }. */
    setStrip(info) {
      if (!info?.url) return;
      const img = new Image();
      img.onload = () => {
        st.plan = info;
        st.sprite = info.url;
        later(renderView);
      };
      img.src = info.url;
    },
    refresh: () => later(renderView),
    destroy() {
      resizeObs?.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(edgeRaf);
      clearTimeout(flashTimer);
    },
  };
}
