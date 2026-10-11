// Liste complète des vidéos : filtre par titre, tri, pagination (« Voir plus »).
import { renderVideoCard } from './video-card.js';

const list = document.getElementById('list');
const input = document.getElementById('f');
const sortSelect = document.getElementById('sort');
const count = document.getElementById('count');
const empty = document.getElementById('empty');
const more = document.getElementById('more');

const params = new URLSearchParams(location.search);
input.value = params.get('q') ?? '';
sortSelect.value = params.get('sort') === 'old' ? 'old' : 'recent';

let page = 1;
let ticket = 0; // ignore les réponses devenues obsolètes (frappe rapide)

const plural = (n, one, many) => (n > 1 ? many : one);

async function load(reset) {
  const mine = ++ticket;
  if (reset) page = 1;
  const q = input.value.trim();
  const sort = sortSelect.value;
  const qs = new URLSearchParams({ page: String(page), sort });
  if (q) qs.set('q', q);
  const shown = new URLSearchParams({ ...(q ? { q } : {}), ...(sort === 'old' ? { sort } : {}) }).toString();
  history.replaceState(null, '', shown ? `?${shown}` : location.pathname);
  more.disabled = true;
  try {
    const res = await fetch(`/api/videos?${qs}`);
    const data = await res.json();
    if (mine !== ticket) return;
    if (!res.ok) throw new Error(data.error || 'Erreur');
    const cards = data.videos.map((v) => renderVideoCard(v, data.summaries_enabled));
    if (reset) list.replaceChildren(...cards);
    else list.append(...cards);
    count.textContent = q
      ? `${data.total} résultat${plural(data.total, '', 's')} pour « ${q} »`
      : `${data.total} vidéo${plural(data.total, '', 's')} transcrite${plural(data.total, '', 's')}`;
    empty.hidden = data.total > 0;
    empty.textContent = q ? 'Aucune vidéo ne correspond. Essaie avec un autre mot du titre.' : "Aucune vidéo n'est encore transcrite.";
    more.hidden = !data.has_more;
  } catch (e) {
    if (mine !== ticket) return;
    count.textContent = e.message;
  } finally {
    more.disabled = false;
  }
}

let timer;
input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(() => load(true), 250);
});
sortSelect.addEventListener('change', () => load(true));
document.getElementById('filters').addEventListener('submit', (e) => {
  e.preventDefault();
  load(true);
});
more.addEventListener('click', () => {
  page += 1;
  load(false);
});

load(true);
