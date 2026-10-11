const form = document.getElementById('form');
const input = document.getElementById('q');
const out = document.getElementById('out');
const stats = document.getElementById('stats');
const button = form.querySelector('button');

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
};

const fmtDate = (d) => {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('fr-FR', { dateStyle: 'long' });
};

/** Texte avec plages surlignées (construit avec des nœuds : jamais d'innerHTML). */
function highlighted(text, marks) {
  const frag = document.createDocumentFragment();
  let pos = 0;
  for (const [a, b] of marks) {
    if (a > pos) frag.append(text.slice(pos, a));
    frag.append(h('mark', {}, text.slice(a, b)));
    pos = b;
  }
  if (pos < text.length) frag.append(text.slice(pos));
  return frag;
}

const langName = (code) => {
  try {
    return new Intl.DisplayNames(['fr'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};

function renderMatch(m, video) {
  const quote = h('blockquote');
  m.segments.forEach((seg, i) => {
    if (i) quote.append(' ');
    const span = h('span', { class: seg.marks.length ? '' : 'ctx' });
    span.append(highlighted(seg.text, seg.marks));
    quote.append(span);
  });
  return h(
    'div',
    { class: 'match' },
    quote,
    h(
      'div',
      { class: 'match-foot' },
      video.translated
        ? h('span', { class: 'tag translated' }, 'Traduction automatique')
        : h('span', { class: `tag ${m.type}` }, m.type === 'exact' ? 'Mot pour mot' : 'Formulation proche'),
      h('a', { class: 'watch', href: m.url, target: '_blank', rel: 'noopener noreferrer' }, `▶ Voir à ${fmtTime(m.start_ms)} ↗`),
    ),
  );
}

function renderResult(r) {
  const v = r.video;
  const meta = [v.channel, fmtDate(v.published_at)].filter(Boolean).join(' · ');
  const head = h(
    'div',
    { class: 'result-head' },
    v.thumbnail_url ? h('img', { src: v.thumbnail_url, alt: '', loading: 'lazy' }) : null,
    h(
      'div',
      {},
      h('h3', {}, v.title),
      h('p', { class: 'meta' }, meta),
      v.translated ? h('p', { class: 'meta warn' }, `Traduit automatiquement${v.original_lang ? ` depuis le ${langName(v.original_lang)}` : ''} : le texte ci-dessous n'est pas la formulation exacte prononcée.`) : null,
    ),
  );
  const card = h('article', { class: 'result card' }, head, r.matches.map((m) => renderMatch(m, v)));
  if (r.total_matches > r.matches.length) {
    card.append(h('p', { class: 'more' }, `+ ${r.total_matches - r.matches.length} autre(s) occurrence(s) dans cette vidéo`));
  }
  return card;
}

function render(data) {
  out.replaceChildren();
  const n = data.results.length;
  const verdicts = {
    exact: ['Oui, il l\'a dit', `Trouvé mot pour mot dans ${n} vidéo${n > 1 ? 's' : ''}.`],
    translated: ['Trouvé dans une traduction', 'Cette phrase apparaît dans la traduction automatique d\'une vidéo dans une autre langue. Ce n\'est pas la formulation exacte prononcée : écoute la vidéo pour vérifier.'],
    approx: ['Pas mot pour mot, mais des propos proches', 'Tous les mots de ta recherche apparaissent près les uns des autres. Vérifie le contexte.'],
    none: ['Aucune trace', `Cette phrase n'apparaît dans aucune des ${data.video_count} vidéo${data.video_count > 1 ? 's' : ''} indexée${data.video_count > 1 ? 's' : ''}.`],
  };
  const [title, sub] = verdicts[data.verdict];
  out.append(h('div', { class: `verdict card ${data.verdict}` }, h('p', { class: 'eyebrow' }, 'Résultat'), h('h2', {}, title), h('p', {}, sub)));
  data.results.forEach((r) => out.append(renderResult(r)));
}

async function search(q) {
  button.disabled = true;
  out.replaceChildren(h('p', { class: 'hint' }, 'Recherche en cours…'));
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erreur');
    render(data);
  } catch (e) {
    out.replaceChildren(h('p', { class: 'error' }, e.message));
  } finally {
    button.disabled = false;
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (q.length < 3) return;
  history.replaceState(null, '', `?q=${encodeURIComponent(q)}`);
  search(q);
});

fetch('/api/stats')
  .then((r) => r.json())
  .then((s) => {
    if (s.videos) stats.textContent = `${s.videos} vidéo${s.videos > 1 ? 's' : ''} indexée${s.videos > 1 ? 's' : ''}.`;
  })
  .catch(() => {});

const initial = new URLSearchParams(location.search).get('q');
if (initial) {
  input.value = initial;
  search(initial);
}
