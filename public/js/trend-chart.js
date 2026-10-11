// Graphique des tendances : courbes SVG dessinées à la largeur réelle (texte toujours lisible, même sur mobile).
// Un curseur suit le doigt ou la souris (flèches du clavier aussi) et affiche une seule infobulle pour toutes les courbes.
// Tous les textes viennent de l'API : ils sont posés avec textContent, jamais avec innerHTML.
import { h } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  el.append(...kids.flat().filter(Boolean));
  return el;
};

/** Couleurs des courbes, dans l'ordre fixe (définies dans theme.css, vérifiées pour le daltonisme). */
export const SERIES_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'];

const nf = (max) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: max });

export function formatValue(v, metric) {
  if (v == null) return '—';
  if (metric !== 'rate') return nf(0).format(v);
  return nf(v > 0 && v < 1 ? 2 : v < 10 ? 1 : 0).format(v);
}

/** « 2024-03 » -> « mars 2024 » (long) ou « mars 24 » (court) ; « 2024 » -> « 2024 ». */
export function periodLabel(key, long = true) {
  if (key.length === 4) return key;
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', long ? { month: 'long', year: 'numeric' } : { month: 'short', year: '2-digit' });
}

/** Graduations « rondes » de 0 jusqu'au maximum. */
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return { ticks: [0, 1], top: 1 };
  const raw = max / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((f) => f * pow).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 1000; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { ticks, top };
}

const valueOf = (p, metric) => (metric === 'rate' ? p.per10k : p.mentions);

/** Tableau des chiffres (alternative au graphique, lisible au clavier et par les lecteurs d'écran). */
export function buildTable(data, metric) {
  const unit = metric === 'rate' ? 'pour 10 000 mots (mentions)' : 'mentions';
  const head = h('tr', {}, h('th', { scope: 'col' }, 'Période'), h('th', { scope: 'col' }, 'Vidéos'), ...data.series.map((s) => h('th', { scope: 'col' }, s.term)));
  const rows = data.periods.map((p, i) =>
    h(
      'tr',
      {},
      h('th', { scope: 'row' }, periodLabel(p.key)),
      h('td', {}, String(p.videos)),
      ...data.series.map((s) => {
        const pt = s.points[i];
        const v = valueOf(pt, metric);
        return h('td', {}, metric === 'rate' ? (v == null ? '—' : `${formatValue(v, metric)} (${pt.mentions})`) : formatValue(v, metric));
      }),
    ),
  );
  return h('table', { class: 'trend-table' }, h('caption', {}, `Évolution, en ${unit}`), h('thead', {}, head), h('tbody', {}, rows));
}

/**
 * Monte le graphique dans `container`. Renvoie une fonction qui le démonte (arrête le suivi du redimensionnement).
 * data = réponse de /api/trends ; metric = 'rate' (pour 10 000 mots) ou 'count' (mentions).
 */
export function mountChart(container, data, metric) {
  const { periods, series } = data;
  const n = periods.length;
  const wrap = h('div', { class: 'chart-wrap', tabindex: '0', role: 'group', 'aria-label': `Graphique : ${series.map((s) => s.term).join(', ')}. Les flèches gauche et droite parcourent les périodes ; les chiffres sont aussi dans le tableau sous le graphique.` });
  const tip = h('div', { class: 'chart-tip', hidden: true, 'aria-hidden': 'true' });
  container.replaceChildren(wrap);

  let geom = null; // dernière géométrie dessinée
  let active = null; // période survolée

  function showAt(i) {
    if (!geom || n === 0) return;
    active = Math.max(0, Math.min(n - 1, i));
    const { x, y, m, W } = geom;
    const p = periods[active];
    const cx = x(active);
    geom.hover.replaceChildren(
      svg('line', { x1: cx, x2: cx, y1: m.t, y2: geom.baseline, class: 'chart-cursor' }),
      ...series.map((s, k) => {
        const v = valueOf(s.points[active], metric);
        return v == null ? null : svg('circle', { cx, cy: y(v), r: 5, class: 'chart-dot', style: `fill:${SERIES_COLORS[k]}` });
      }),
    );
    tip.replaceChildren(
      h('p', { class: 'tip-title' }, periodLabel(p.key)),
      h('p', { class: 'tip-sub' }, p.videos ? `${p.videos} vidéo${p.videos > 1 ? 's' : ''} · ${nf(0).format(p.words)} mots` : 'Aucune vidéo sur cette période'),
      ...series.map((s, k) => {
        const pt = s.points[active];
        const v = valueOf(pt, metric);
        return h(
          'p',
          { class: 'tip-row' },
          h('span', { class: 'tip-key', style: `background:${SERIES_COLORS[k]}` }),
          h('strong', {}, formatValue(v, metric)),
          h('span', { class: 'tip-name' }, series.length > 1 ? s.term : metric === 'rate' ? 'pour 10 000 mots' : 'mentions'),
          metric === 'rate' && v != null ? h('span', { class: 'tip-extra' }, `${pt.mentions} mention${pt.mentions > 1 ? 's' : ''}`) : null,
        );
      }),
    );
    tip.hidden = false;
    // la bulle passe à gauche du curseur quand elle risque de sortir du cadre
    const left = cx > W * 0.58 ? cx - tip.offsetWidth - 12 : cx + 12;
    tip.style.left = `${Math.max(0, Math.min(left, W - tip.offsetWidth))}px`;
    tip.style.top = `${m.t}px`;
  }

  function hide() {
    active = null;
    tip.hidden = true;
    if (geom) geom.hover.replaceChildren();
  }

  function draw() {
    const W = Math.max(280, wrap.clientWidth);
    const H = W < 520 ? 250 : 330;
    const m = { t: 18, r: 18, b: 36, l: W < 520 ? 40 : 48 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const all = series.flatMap((s) => s.points.map((p) => valueOf(p, metric))).filter((v) => v != null);
    const { ticks, top } = niceTicks(Math.max(0, ...all));
    const x = (i) => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (v) => m.t + ih - (v / top) * ih;
    const baseline = m.t + ih;

    const grid = ticks.map((t) =>
      svg(
        'g',
        {},
        svg('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'chart-axis' : 'chart-grid' }),
        svg('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'chart-tick' }, formatValue(t, metric)),
      ),
    );

    const long = data.granularity === 'year';
    const perLabel = long ? 46 : 62;
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / perLabel))));
    const xlabels = periods.flatMap((p, i) =>
      i % step === 0 ? [svg('text', { x: x(i), y: H - 12, 'text-anchor': n > 1 && i === 0 ? 'start' : 'middle', class: 'chart-tick' }, periodLabel(p.key, false))] : [],
    );

    const lines = series.map((s, k) => {
      const color = SERIES_COLORS[k];
      const segments = [];
      let cur = [];
      s.points.forEach((p, i) => {
        const v = valueOf(p, metric);
        if (v == null) {
          if (cur.length) segments.push(cur);
          cur = [];
        } else cur.push([x(i), y(v)]);
      });
      if (cur.length) segments.push(cur);
      const d = (seg) => seg.map(([px, py], j) => `${j ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join('');
      const last = segments.at(-1)?.at(-1);
      return svg(
        'g',
        {},
        // un seul tracé : un léger aplat sous la courbe
        series.length === 1 ? segments.filter((sg) => sg.length > 1).map((sg) => svg('path', { d: `${d(sg)}L${sg.at(-1)[0].toFixed(1)} ${baseline}L${sg[0][0].toFixed(1)} ${baseline}Z`, class: 'chart-area', style: `fill:${color}` })) : null,
        segments.map((sg) => (sg.length > 1 ? svg('path', { d: d(sg), class: 'chart-line', style: `stroke:${color}` }) : svg('circle', { cx: sg[0][0], cy: sg[0][1], r: 4, class: 'chart-dot', style: `fill:${color}` }))),
        last ? svg('circle', { cx: last[0], cy: last[1], r: 4.5, class: 'chart-dot', style: `fill:${color}` }) : null,
      );
    });

    const hover = svg('g', { class: 'chart-hover' });
    const overlay = svg('rect', { x: m.l, y: m.t, width: iw, height: ih + 6, class: 'chart-overlay' });
    const pick = (ev) => {
      const box = overlay.getBoundingClientRect();
      const ratio = box.width ? (ev.clientX - box.left) / box.width : 0;
      showAt(n <= 1 ? 0 : Math.round(ratio * (n - 1)));
    };
    overlay.addEventListener('pointermove', pick);
    overlay.addEventListener('pointerdown', pick);
    overlay.addEventListener('pointerleave', (ev) => {
      if (ev.pointerType === 'mouse') hide();
    });

    const el = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', 'aria-hidden': 'true' }, grid, xlabels, lines, hover, overlay);
    geom = { x, y, m, W, baseline, hover };
    wrap.replaceChildren(el, tip);
    if (active != null) showAt(active);
  }

  wrap.addEventListener('keydown', (ev) => {
    const move = { ArrowLeft: -1, ArrowRight: 1 }[ev.key];
    if (move) {
      ev.preventDefault();
      showAt((active ?? (move > 0 ? -1 : n)) + move);
    } else if (ev.key === 'Home') showAt(0);
    else if (ev.key === 'End') showAt(n - 1);
    else if (ev.key === 'Escape') hide();
  });
  wrap.addEventListener('blur', hide);

  draw();
  let width = wrap.clientWidth;
  const ro = new ResizeObserver(() => {
    if (wrap.clientWidth !== width) {
      width = wrap.clientWidth;
      draw();
    }
  });
  ro.observe(wrap);
  return () => ro.disconnect();
}
