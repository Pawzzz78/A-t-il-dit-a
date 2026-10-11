// Page « Tendances » : saisie d'un à quatre mots, courbe dans le temps, détail par mot, mots les plus prononcés.
import { SERIES_COLORS, buildTable, formatValue, mountChart, periodLabel } from './trend-chart.js';
import { fmtDate, h } from './ui.js';

const $ = (id) => document.getElementById(id);
const form = $('form');
const input = $('q');
const statusEl = $('status');
const result = $('result');
const btnRate = $('m-rate');
const btnCount = $('m-count');

const int = new Intl.NumberFormat('fr-FR');
const plural = (n, one, many) => (n > 1 ? many : one);
const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

// Par défaut : « Mentions » (courbe continue). « Fréquence » laisse un trou pour chaque mois sans vidéo.
let metric = new URLSearchParams(location.search).get('m') === 'rate' ? 'rate' : 'count';
let data = null;
let unmount = null;
let ticket = 0; // ignore les réponses devenues obsolètes

function setStatus(message, isError = false) {
  statusEl.hidden = !message;
  statusEl.textContent = message ?? '';
  statusEl.className = isError ? 'hint error' : 'hint';
}

function syncUrl(q) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (metric === 'rate') params.set('m', 'rate');
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function termCard(s, k, data) {
  const head = h('h3', {}, h('span', { class: 'term-key', style: `background:${SERIES_COLORS[k]}` }), s.term);
  if (!s.mentions) {
    return h('article', { class: 'card term-card' }, head, h('p', { class: 'term-facts' }, `Aucune mention de « ${s.term} » dans les ${int.format(data.base.videos)} vidéos comptées.`));
  }
  const peakLabel = s.peak ? periodLabel(s.peak.key) : null;
  return h(
    'article',
    { class: 'card term-card' },
    head,
    h('p', { class: 'term-stat' }, int.format(s.mentions), h('span', {}, ` mention${plural(s.mentions, '', 's')} dans ${int.format(s.videos)} vidéo${plural(s.videos, '', 's')}`)),
    h(
      'p',
      { class: 'term-facts' },
      `${formatValue(s.per10k, 'rate')} pour 10 000 mots · première fois le ${fmtDate(s.first)} · dernière le ${fmtDate(s.last)}`,
      peakLabel ? ` · pic en ${peakLabel} (${s.peak.mentions})` : '',
    ),
    h(
      'ul',
      { class: 'term-videos' },
      s.top_videos.map((v) =>
        h(
          'li',
          {},
          h('a', { href: watchUrl(v.youtube_id), target: '_blank', rel: 'noopener noreferrer' }, v.title || v.youtube_id),
          h('span', {}, `${fmtDate(v.published_at)} · ${v.mentions}×`),
        ),
      ),
    ),
    h('a', { class: 'watch', href: `/?q=${encodeURIComponent(s.term)}` }, 'Voir les extraits →'),
  );
}

function render() {
  unmount?.();
  const { series, base } = data;
  $('result-title').textContent = series.length === 1 ? `« ${series[0].term} » dans le temps` : series.map((s) => `« ${s.term} »`).join(' · ');
  btnRate.setAttribute('aria-pressed', String(metric === 'rate'));
  btnCount.setAttribute('aria-pressed', String(metric === 'count'));

  // légende : toujours présente dès qu'il y a plusieurs courbes (la couleur ne porte jamais seule l'identité)
  const legend = $('legend-line');
  legend.hidden = series.length < 2;
  legend.replaceChildren(
    ...series.map((s, k) =>
      h('span', { class: 'legend-item' }, h('span', { class: 'legend-key', style: `background:${SERIES_COLORS[k]}` }), `${s.term} (${int.format(s.mentions)})`),
    ),
  );

  unmount = mountChart($('chart'), data, metric);
  $('table').replaceChildren(h('div', { class: 'table-scroll' }, buildTable(data, metric)));
  const unit = data.granularity === 'year' ? 'année' : 'mois';
  $('metric-note').textContent =
    metric === 'rate'
      ? `Fréquence : nombre de mentions pour 10 000 mots prononcés dans les vidéos de chaque ${unit}, pour comparer les périodes même si le nombre de vidéos change. Une période sans vidéo n'a pas de point.`
      : `Mentions : nombre brut dans les vidéos publiées chaque ${unit} ; il dépend aussi du nombre de vidéos de la période.`;
  $('terms').replaceChildren(...series.map((s, k) => termCard(s, k, data)));

  const notes = [`Basé sur ${int.format(base.videos)} vidéo${plural(base.videos, '', 's')} transcrite${plural(base.videos, '', 's')} et datée${plural(base.videos, '', 's')} (${int.format(base.words)} mots).`];
  if (base.translated_excluded) notes.push(`${base.translated_excluded} vidéo${plural(base.translated_excluded, ' traduite', 's traduites')} automatiquement ${plural(base.translated_excluded, 'n’est', 'ne sont')} pas comptée${plural(base.translated_excluded, '', 's')}.`);
  if (base.undated_excluded) notes.push(`${base.undated_excluded} vidéo${plural(base.undated_excluded, '', 's')} sans date de publication ${plural(base.undated_excluded, 'n’est', 'ne sont')} pas comptée${plural(base.undated_excluded, '', 's')}.`);
  $('base-note').textContent = notes.join(' ');
  result.hidden = false;
}

async function load(q) {
  const mine = ++ticket;
  setStatus(null);
  result.classList.add('loading');
  try {
    const res = await fetch(`/api/trends?q=${encodeURIComponent(q)}`);
    const body = await res.json().catch(() => ({}));
    if (mine !== ticket) return;
    if (!res.ok) throw new Error(body.error || 'Erreur');
    if (!body.periods.length) {
      result.hidden = true;
      setStatus("Pas encore de vidéo transcrite et datée : les tendances apparaîtront dès qu'il y en aura.", true);
      return;
    }
    data = body;
    render();
    syncUrl(q);
  } catch (e) {
    if (mine !== ticket) return;
    setStatus(e.message, true);
  } finally {
    if (mine === ticket) result.classList.remove('loading');
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (q.length < 2) return;
  metric = 'count'; // chaque nouvelle recherche repart sur « Mentions »
  load(q);
});

for (const [btn, value] of [[btnCount, 'count'], [btnRate, 'rate']]) {
  btn.addEventListener('click', () => {
    if (metric === value || !data) return;
    metric = value;
    render();
    syncUrl(input.value.trim());
  });
}

$('share').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const shareData = { title: 'Lisnard Facts : tendances', url: location.href };
  try {
    if (navigator.share) await navigator.share(shareData);
    else {
      await navigator.clipboard.writeText(location.href);
      btn.textContent = 'Lien copié ✓';
      setTimeout(() => (btn.textContent = 'Partager'), 2000);
    }
  } catch {
    // partage annulé : rien à faire
  }
});

// mots les plus prononcés : podium (3 premiers), barres (suivants), pastilles (le reste)
const PODIUM = 3;
const BARS = 12;
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);

function pickWord(word) {
  $('q').value = word;
  metric = 'count';
  load(word);
  scrollTo({ top: 0, behavior: 'smooth' });
}

function wordButton(cls, word, children, w) {
  const btn = h('button', { type: 'button', class: cls, title: `Voir l'évolution de « ${word} » (${int.format(w.mentions)} mentions dans ${int.format(w.videos)} vidéos)` }, children);
  btn.addEventListener('click', () => pickWord(word));
  return btn;
}

function renderWords(words) {
  const top = words[0].mentions;
  const mentions = (w) => `${int.format(w.mentions)} mention${plural(w.mentions, '', 's')}`;
  const podium = words.slice(0, PODIUM).map((w, i) =>
    wordButton(
      'podium-tile',
      w.word,
      [
        h('span', { class: 'rank', 'aria-hidden': 'true' }, String(i + 1)),
        h('span', { class: 'podium-word' }, w.word),
        h('span', { class: 'podium-count' }, `${mentions(w)} · ${int.format(w.videos)} vidéo${plural(w.videos, '', 's')}`),
      ],
      w,
    ),
  );
  const bars = words.slice(PODIUM, PODIUM + BARS).map((w, i) =>
    h(
      'li',
      {},
      wordButton(
        'bar-row',
        w.word,
        [
          h('span', { class: 'bar-rank', 'aria-hidden': 'true' }, String(PODIUM + i + 1).padStart(2, '0')),
          h('span', { class: 'bar-word' }, cap(w.word)),
          h('span', { class: 'bar-track', 'aria-hidden': 'true' }, h('i', { style: `width:${Math.max(4, (w.mentions / top) * 100).toFixed(1)}%` })),
          h('span', { class: 'bar-count' }, int.format(w.mentions)),
        ],
        w,
      ),
    ),
  );
  const rest = words.slice(PODIUM + BARS);
  $('word-list').replaceChildren(
    h('div', { class: 'podium' }, podium),
    bars.length ? h('ol', { class: 'bar-list', start: String(PODIUM + 1) }, bars) : null,
    rest.length
      ? h(
          'div',
          { class: 'more-words' },
          h('p', { class: 'more-words-title' }, 'Et aussi'),
          h('ul', {}, rest.map((w) => h('li', {}, wordButton('chip', w.word, [w.word, h('span', {}, int.format(w.mentions))], w)))),
        )
      : null,
  );
}

fetch('/api/trends/words')
  .then((r) => r.json())
  .then(({ words }) => {
    if (!words?.length) return;
    renderWords(words);
    $('words').hidden = false;
  })
  .catch(() => {});

const initial = new URLSearchParams(location.search).get('q');
if (initial) {
  input.value = initial;
  load(initial);
}
