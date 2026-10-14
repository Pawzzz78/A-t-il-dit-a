// Mur des clips : classement des TikToks du hashtag suivi. Les données viennent de /api/wall (lue dans la base du serveur).

const SORTS = [
  ['score', 'Classement'],
  ['views', 'Vues'],
  ['likes', 'J’aime'],
  ['comments', 'Commentaires'],
  ['recent', 'Récents'],
];
// adresses lisibles : /mur/?tri=vues&periode=7
const SORT_PARAM = { score: 'classement', views: 'vues', likes: 'jaime', comments: 'commentaires', recent: 'recents' };
const FIRST_PAGE = 27; // 3 du podium + 24 dans la grille
const PAGE = 24;

const $ = (id) => document.getElementById(id);
const state = { sort: 'score', period: 'all', clips: [], total: 0, loading: false, ticket: 0 };

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

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
  const one = (name, n, label) => el('span', { title: `${full.format(n)} ${label}` }, icon(name), fmt(n), withLabels ? ` ${label}` : null);
  return [one('views', c.views, c.views > 1 ? 'vues' : 'vue'), one('likes', c.likes, 'j’aime'), one('comments', c.comments, c.comments > 1 ? 'commentaires' : 'commentaire')];
}

function card(c, rank) {
  const label = `Voir le clip de @${c.author}${rank ? `, numéro ${rank}` : ''} : ${fmt(c.views)} vues`;
  const cover = c.cover ? el('img', { src: c.cover, alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => e.target.remove() }) : null;
  const button = el('button', { class: 'clip-open', type: 'button', 'aria-label': label, onclick: () => openClip(c) },
    cover,
    rank ? el('span', { class: 'clip-rank', 'aria-hidden': 'true' }, `#${rank}`) : null,
    el('span', { class: 'clip-play', 'aria-hidden': 'true' }, icon('play')),
    el('span', { class: 'clip-info' }, el('span', { class: 'clip-author' }, `@${c.author}`), el('span', { class: 'clip-stats' }, stats(c))));
  return el('li', { class: 'clip' }, button);
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
  $('sorts').replaceChildren(...SORTS.map(([key, label]) => el('button', { type: 'button', 'aria-pressed': String(state.sort === key), onclick: () => { state.sort = key; sync(); load(true); } }, label)));
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
  $('podium').replaceChildren(...podium.map((c, i) => card(c, i + 1)));
  $('grid').replaceChildren(...rest.map((c, i) => card(c, ranked ? podium.length + i + 1 : null)));
  $('more').hidden = state.clips.length >= state.total;
  $('more').disabled = state.loading;
}

async function load(reset) {
  const mine = ++state.ticket;
  state.loading = true;
  if (reset) {
    state.clips = [];
    state.total = 0;
    render();
    $('state').textContent = 'Chargement du mur…';
  }
  const offset = state.clips.length;
  const limit = state.sort === 'score' && offset === 0 ? FIRST_PAGE : PAGE;
  try {
    const res = await fetch(`/api/wall?sort=${state.sort}&period=${state.period}&limit=${limit}&offset=${offset}`);
    if (!res.ok) throw new Error(`Erreur ${res.status}`);
    const data = await res.json();
    if (mine !== state.ticket) return;
    state.clips = [...state.clips, ...data.clips];
    state.total = data.total;
    state.loading = false;
    $('updated').textContent = data.updated_at ? `Mis à jour ${ago(data.updated_at) === 'aujourd’hui' ? 'aujourd’hui' : ago(data.updated_at)}, ${new Date(data.updated_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.` : '';
    $('explain').textContent = `Le classement additionne les vues, ${data.weights.likes} fois les j’aime et ${data.weights.comments} fois les commentaires (${data.weights.views === 1 ? 'les vues comptent pour 1' : `les vues comptent pour ${data.weights.views}`}). Sont repris les clips publiés avec #${data.hashtag}.`;
    $('state').textContent = state.total ? '' : data.enabled === false ? 'Le mur est désactivé pour le moment.' : state.period === 'all' ? 'Le mur se remplit : aucun clip pour le moment. Sois le premier : publie ton TikTok avec #lisnard2027 !' : 'Aucun clip sur cette période.';
    render();
  } catch {
    if (mine !== state.ticket) return;
    state.loading = false;
    $('state').replaceChildren('Impossible de charger le mur. ', el('button', { class: 'btn small', type: 'button', onclick: () => load(reset) }, 'Réessayer'));
    render();
  }
}

// --- démarrage -------------------------------------------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const fromParam = Object.entries(SORT_PARAM).find(([, v]) => v === params.get('tri'));
if (fromParam) state.sort = fromParam[0];
if (['7', '30'].includes(params.get('periode'))) state.period = params.get('periode');
$('period').addEventListener('change', () => { state.period = $('period').value; sync(); load(true); });
$('more').addEventListener('click', () => load(false));
sync();
load(true);
