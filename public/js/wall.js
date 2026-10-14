// Mur des clips : classement des TikToks du hashtag suivi, présenté comme un collage d'affiches. Les données viennent de /api/wall
// (lue dans la base du serveur) ; le papier déchiré et l'inclinaison des affiches sont tirés au hasard à partir de l'identifiant du clip,
// donc stables d'une visite à l'autre.

const SORTS = [
  ['score', 'Classement'],
  ['views', 'Vues'],
  ['likes', 'J’aime'],
  ['comments', 'Commentaires'],
  ['recent', 'Récents'],
];
// adresses lisibles : /mur/?tri=vues&periode=7
const SORT_PARAM = { score: 'classement', views: 'vues', likes: 'jaime', comments: 'commentaires', recent: 'recents' };
const PAGE = 60; // le serveur limite de toute façon le classement à son nombre maximal de clips (13)

const $ = (id) => document.getElementById(id);
const state = { sort: 'score', period: 'all', clips: [], total: 0, max: 13, loading: false, ticket: 0 };

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

// --- papier déchiré -------------------------------------------------------------------------------------------------------------------

const hash = (s) => [...String(s)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
/** Générateur pseudo-aléatoire (mulberry32) : le même identifiant donne toujours la même suite. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Découpe irrégulière d'un rectangle (propriété clip-path) : les côtés demandés (`edges` : lettres t, r, b, l) sont « déchirés », avec des
 * dents de 0 à `amp` pixels, parfois plus profondes ; les autres restent droits.
 */
export function tornPolygon(seed, { edges = 'tblr', amp = 5, along = 18 } = {}) {
  const rnd = rng(hash(seed));
  const jag = (on) => {
    if (!on) return 0;
    const bite = rnd() < 0.12 ? 1.8 : 1; // une encoche plus profonde de temps en temps
    return Math.round(rnd() * amp * bite * 10) / 10;
  };
  const pts = [];
  const side = (n, on, at) => {
    for (let i = 0; i < n; i++) pts.push(at((i / n) * 100 + rnd() * (100 / n) * 0.6, jag(on)));
  };
  side(along, edges.includes('t'), (x, j) => `${x.toFixed(1)}% ${j}px`);
  side(Math.round(along * 1.5), edges.includes('r'), (y, j) => `calc(100% - ${j}px) ${y.toFixed(1)}%`);
  side(along, edges.includes('b'), (x, j) => `${(100 - x).toFixed(1)}% calc(100% - ${j}px)`);
  side(Math.round(along * 1.5), edges.includes('l'), (y, j) => `${j}px ${(100 - y).toFixed(1)}%`);
  return `polygon(${pts.join(', ')})`;
}

/** Applique un bord déchiré aux éléments marqués data-torn (bannière, bande d'appel) : « t » haut, « b » bas, « tb » les deux. */
function tearMarked() {
  document.querySelectorAll('[data-torn]').forEach((node, i) => {
    node.style.clipPath = tornPolygon(`${node.className}-${i}`, { edges: node.dataset.torn, amp: node.classList.contains('torn-edge') ? 16 : 9, along: 30 });
  });
}

// --- icônes et nombres ----------------------------------------------------------------------------------------------------------------

const ICONS = {
  views: 'M12 5C6.5 5 2.7 8.9 1.5 12c1.2 3.1 5 7 10.5 7s9.3-3.9 10.5-7C21.3 8.9 17.5 5 12 5zm0 11.2A4.2 4.2 0 1 1 12 7.8a4.2 4.2 0 0 1 0 8.4zm0-6.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z',
  likes: 'M12 21s-7.5-4.6-9.6-9.1C.9 8.5 2.7 5 6.1 5c2 0 3.3 1.1 3.9 2.2h.0C10.6 6.1 12 5 14 5c3.4 0 5.2 3.5 3.7 6.9C19.5 16.4 12 21 12 21z',
  comments: 'M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  play: 'M7 4.5v15l13-7.5z',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'currentColor');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('fr-FR');
const fmt = (n) => (n < 1000 ? String(n) : compact.format(n));

function ago(iso) {
  if (!iso) return '';
  const days = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  if (days < 1) return 'aujourd’hui';
  if (days < 30) return rtf.format(-days, 'day');
  if (days < 365) return rtf.format(-Math.round(days / 30), 'month');
  return rtf.format(-Math.round(days / 365), 'year');
}

const tiktokUrl = (c) => (/^https:\/\/(www\.|m\.)?tiktok\.com\//.test(c.url) ? c.url : `https://www.tiktok.com/@${encodeURIComponent(c.author)}/video/${encodeURIComponent(c.id)}`);

function stats(c, withLabels = false) {
  const one = (cls, name, n, label) => el('span', { class: cls, title: `${full.format(n)} ${label}` }, icon(name), fmt(n), withLabels ? ` ${label}` : null);
  return [one('s-views', 'views', c.views, c.views > 1 ? 'vues' : 'vue'), one('s-likes', 'likes', c.likes, 'j’aime'), one('s-comments', 'comments', c.comments, c.comments > 1 ? 'commentaires' : 'commentaire')];
}

// --- une affiche ----------------------------------------------------------------------------------------------------------------------

const ordinal = (n) => el('span', {}, String(n), el('small', {}, n === 1 ? 'er' : 'e'));

function card(c, rank, { podium = false } = {}) {
  const rnd = rng(hash(c.id));
  const tilt = (rnd() < 0.5 ? -1 : 1) * (0.9 + rnd() * 2.2); // entre 0,9° et 3,1°, dans un sens ou dans l'autre
  const lift = Math.round(rnd() * 16 - 4);
  const label = `Voir le clip de @${c.author}${rank ? `, numéro ${rank}` : ''} : ${fmt(c.views)} vues`;
  const photo = el('span', { class: 'clip-photo' },
    c.cover ? el('img', { src: c.cover, alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => e.target.remove() }) : null,
    el('span', { class: 'clip-play', 'aria-hidden': 'true' }, icon('play')));
  const button = el('button', { class: 'clip-open', type: 'button', 'aria-label': label, style: `clip-path:${tornPolygon(c.id, { amp: podium ? 6 : 5, edges: 'tblr', along: 16 })}`, onclick: () => openClip(c) },
    photo,
    el('span', { class: 'clip-caption' }, el('span', { class: 'clip-author' }, `@${c.author}`), el('span', { class: 'clip-stats' }, stats(c))));
  return el('li', { class: 'clip', style: podium ? '' : `--tilt:${tilt.toFixed(2)}deg;--lift:${lift}px;--tape:${(rnd() * 14 - 7).toFixed(1)}deg` },
    button,
    el('span', { class: 'clip-tape', 'aria-hidden': 'true' }),
    rank ? el('span', { class: 'clip-rank', 'aria-hidden': 'true' }, ordinal(rank)) : null);
}

// --- fenêtre du clip ----------------------------------------------------------------------------------------------------------------

const dialog = $('dialog');
function openClip(c) {
  $('dialog-title').textContent = `@${c.author}`;
  $('dialog-text').textContent = [c.text, ago(c.created_at)].filter(Boolean).join(' · ');
  $('dialog-stats').replaceChildren(...stats(c, true));
  $('dialog-link').href = tiktokUrl(c);
  // le lecteur officiel de TikTok n'est chargé qu'ici, à la demande du visiteur
  $('dialog-player').replaceChildren(el('iframe', { src: `https://www.tiktok.com/embed/v2/${encodeURIComponent(c.id)}`, title: `Clip de @${c.author}`, allow: 'encrypted-media; fullscreen', allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin', loading: 'eager' }));
  dialog.showModal();
}
dialog.addEventListener('close', () => $('dialog-player').replaceChildren()); // arrête la lecture
dialog.addEventListener('click', (e) => e.target === dialog && dialog.close()); // clic sur le fond

// --- affichage ------------------------------------------------------------------------------------------------------------------------

function renderSorts() {
  $('sorts').replaceChildren(...SORTS.map(([key, label]) => el('button', { type: 'button', 'aria-pressed': String(state.sort === key), onclick: () => { state.sort = key; sync(); load(); } }, label)));
}

function sync() {
  const q = new URLSearchParams();
  if (state.sort !== 'score') q.set('tri', SORT_PARAM[state.sort]);
  if (state.period !== 'all') q.set('periode', state.period);
  const query = q.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
  renderSorts();
  $('period').value = state.period;
}

function render() {
  const ranked = state.sort !== 'recent';
  const podium = state.sort === 'score' && state.clips.length >= 3 ? state.clips.slice(0, 3) : [];
  const rest = state.clips.slice(podium.length);
  $('podium').replaceChildren(...podium.map((c, i) => card(c, i + 1, { podium: true })));
  $('grid').replaceChildren(...rest.map((c, i) => card(c, ranked ? podium.length + i + 1 : null)));
  const sub = $('sub');
  sub.hidden = !rest.length;
  sub.textContent = podium.length ? `Du ${podium.length + 1}ᵉ au ${state.clips.length}ᵉ rang` : state.sort === 'recent' ? 'Les plus récents d’abord' : 'Tout le classement';
}

async function load() {
  const mine = ++state.ticket;
  state.loading = true;
  state.clips = [];
  state.total = 0;
  render();
  $('state').textContent = 'Chargement du mur…';
  try {
    const res = await fetch(`/api/wall?sort=${state.sort}&period=${state.period}&limit=${PAGE}&offset=0`);
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    const data = await res.json();
    if (mine !== state.ticket) return;
    state.clips = data.clips;
    state.total = data.total;
    state.max = data.max ?? state.max;
    state.loading = false;
    $('stamp-n').textContent = state.max;
    $('stamp').hidden = false;
    $('updated').textContent = data.updated_at ? `Mis à jour ${ago(data.updated_at)}, ${new Date(data.updated_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.` : '';
    $('explain').textContent = `Le mur présente les ${data.max} meilleurs clips ; les onglets les réordonnent. Le classement additionne les vues, ${data.weights.likes} fois les j’aime et ${data.weights.comments} fois les commentaires (${data.weights.views === 1 ? 'les vues comptent pour 1' : `les vues comptent pour ${data.weights.views}`}). Sont repris les clips publiés avec #${data.hashtag}.`;
    $('state').textContent = state.total ? '' : data.enabled === false ? 'Le mur est désactivé pour le moment.' : state.period === 'all' ? 'Le mur se remplit : aucun clip pour le moment. Sois le premier : publie ton TikTok avec #lisnard2027 !' : 'Aucun clip sur cette période.';
    render();
  } catch {
    if (mine !== state.ticket) return;
    state.loading = false;
    $('state').replaceChildren('Impossible de charger le mur. ', el('button', { class: 'btn small', type: 'button', onclick: () => load() }, 'Réessayer'));
    render();
  }
}

// --- démarrage -------------------------------------------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const fromParam = Object.entries(SORT_PARAM).find(([, v]) => v === params.get('tri'));
if (fromParam) state.sort = fromParam[0];
if (['7', '30'].includes(params.get('periode'))) state.period = params.get('periode');
$('period').addEventListener('change', () => { state.period = $('period').value; sync(); load(); });
tearMarked();
sync();
load();
