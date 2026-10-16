// Library page: public listing, « Mes clips » and the clip dialog; data from /api/library
import { sourceText } from './studio-core.js';

const $ = (id) => document.getElementById(id);
const PAGE = 24;
const SORTS = [['recent', 'Récents'], ['downloads', 'Plus téléchargés'], ['rating', 'Mieux notés']];
const state = { tab: 'all', sort: 'recent', v: '', clips: [], total: 0, canWrite: true, membersOnly: false, ticket: 0 };

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

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api/library${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Connexion impossible : vérifie ton réseau.');
  }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { status: res.status, data });
  return data;
}

const loginHref = () => `/api/auth/login?next=${encodeURIComponent(location.pathname + location.search)}`;
const fmt = new Intl.NumberFormat('fr-FR');
const dur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const stars = (c) => (c.rating ? `★ ${String(c.rating).replace('.', ',')} (${c.rating_count})` : '★ pas encore noté');
const downloads = (c) => `${fmt.format(c.downloads)} téléchargement${c.downloads > 1 ? 's' : ''}`;
const media = (c) => (c.kind === 'repost' && c.original ? c.original : c);

function card(c) {
  const m = media(c);
  const chips = [];
  if (state.tab === 'mine') {
    if (c.kind === 'repost') chips.push(c.original ? 'Republié' : 'Original retiré');
    else chips.push(c.visibility === 'public' ? 'Public' : 'Privé');
    if (c.hidden) chips.push('Masqué');
  }
  if (m.file_state === 'archived') chips.push('Archivé');
  if (m.file_state === 'pending') chips.push('En création');
  const photo = el('span', { class: 'clip-photo' },
    m.has_poster ? el('img', { src: `/api/library/clips/${m.id}/poster?v=${m.file_version}`, alt: '', loading: 'lazy', decoding: 'async', onerror: (e) => e.target.remove() }) : null,
    el('span', { class: 'lib-dur' }, dur(m.duration_s)),
    chips.length ? el('span', { class: 'lib-chips' }, chips.map((t) => el('span', {}, t))) : null);
  return el('li', { class: 'clip' },
    el('button', { class: 'clip-open', type: 'button', 'aria-label': `Voir le clip : ${m.video_title}`, onclick: () => openClip(c.id) },
      photo,
      el('span', { class: 'clip-caption' },
        el('span', { class: 'clip-author lib-title' }, m.video_title || 'Interview'),
        el('span', { class: 'clip-stats' }, el('span', {}, `⬇ ${fmt.format(m.downloads)}`), el('span', {}, stars(m))))));
}

function renderSorts() {
  const box = $('sorts');
  if (!box.childElementCount) {
    for (const [key, label] of SORTS) box.append(el('button', { type: 'button', 'data-sort': key, onclick: () => { state.sort = key; sync(); load(); } }, label));
  }
  for (const b of box.children) b.setAttribute('aria-pressed', String(b.dataset.sort === state.sort));
}

function sync() {
  const q = new URLSearchParams();
  if (state.tab === 'mine') q.set('onglet', 'mes-clips');
  if (state.sort !== 'recent') q.set('tri', state.sort);
  if (state.v) q.set('v', state.v);
  const query = q.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
  for (const [id, tab] of [['tab-all', 'all'], ['tab-mine', 'mine']]) {
    const b = $(id);
    b.setAttribute('aria-selected', String(state.tab === tab));
    b.tabIndex = state.tab === tab ? 0 : -1;
  }
  $('panel').setAttribute('aria-labelledby', state.tab === 'mine' ? 'tab-mine' : 'tab-all');
  $('bar').hidden = state.tab === 'mine';
  renderSorts();
}

function fillInterviews(list) {
  const select = $('interview');
  const keep = state.v;
  select.replaceChildren(el('option', { value: '' }, 'Toutes'), ...list.map((i) => el('option', { value: i.youtube_id }, `${i.title} (${i.clips})`)));
  select.value = list.some((i) => i.youtube_id === keep) ? keep : '';
}

async function load({ append = false } = {}) {
  const mine = ++state.ticket;
  if (!append) {
    state.clips = [];
    $('grid').replaceChildren();
    $('state').textContent = 'Chargement…';
  }
  $('more').hidden = true;
  try {
    if (state.tab === 'mine') return await loadMine(mine);
    const q = new URLSearchParams({ sort: state.sort, limit: String(PAGE), offset: String(state.clips.length) });
    if (state.v) q.set('v', state.v);
    const data = await api('GET', `/?${q}`);
    if (mine !== state.ticket) return;
    state.canWrite = data.can_write;
    state.membersOnly = data.members_only;
    state.total = data.total;
    state.clips.push(...data.clips);
    fillInterviews(data.interviews);
    $('grid').append(...data.clips.map(card));
    $('summary').textContent = data.total ? `${fmt.format(data.total)} clip${data.total > 1 ? 's' : ''}` : '';
    $('state').textContent = data.total ? '' : state.v ? 'Aucun clip pour cette interview.' : 'La bibliothèque est vide pour le moment : crée le premier clip dans le studio !';
    $('more').hidden = state.clips.length >= data.total;
  } catch (e) {
    if (mine !== state.ticket) return;
    $('state').replaceChildren(...(e.status === 503 ? ['La bibliothèque n’est pas disponible pour le moment.'] : [`${e.message} `, el('button', { class: 'btn small', type: 'button', onclick: () => load() }, 'Réessayer')]));
  }
}

async function loadMine(ticket) {
  const data = await api('GET', '/mine');
  if (ticket !== state.ticket) return;
  state.clips = data.clips;
  $('grid').replaceChildren(...data.clips.map(card));
  $('summary').replaceChildren(...[
    `${data.active} / ${data.limit} clips gardés dans la bibliothèque`,
    data.clips.length ? el('button', { class: 'st-link lib-forget', type: 'button', onclick: forgetMe }, 'Effacer mes données') : null].filter(Boolean));
  $('state').replaceChildren(...(data.clips.length ? [] : ['Tu n’as encore rien publié. ', el('a', { href: '/' }, 'Crée un clip dans le studio'), ' : il apparaîtra ici.']));
}

async function forgetMe() {
  if (!confirm('Effacer tous tes clips, tes notes et tes signalements de la bibliothèque ? C’est définitif.')) return;
  try {
    await api('DELETE', '/mine');
    load();
  } catch (e) {
    alert(e.message);
  }
}

const dialog = $('dialog');
let current = null;
let pendingTimer = 0;

async function openClip(id) {
  clearTimeout(pendingTimer);
  try {
    current = await api('GET', `/clips/${id}`);
  } catch (e) {
    alert(e.message);
    return;
  }
  renderDialog();
  if (!dialog.open) dialog.showModal();
  const q = new URLSearchParams(location.search);
  q.set('clip', id);
  history.replaceState(null, '', `${location.pathname}?${q}`);
}

const say = (node, text, err = false) => {
  node.className = err ? 'st-msg err' : 'st-msg';
  node.textContent = text;
};

async function act(msg, fn) {
  try {
    await fn();
  } catch (e) {
    if (e.status === 401) return msg.replaceChildren(el('a', { href: loginHref() }, 'Connecte-toi avec ton compte adhérent'), ' pour faire cela.');
    say(msg, e.message, true);
  }
}

function starsInput(c, msg) {
  const box = el('div', { class: 'lib-stars', role: 'radiogroup', 'aria-label': 'Ta note' });
  for (let n = 1; n <= 5; n++) {
    box.append(el('button', { type: 'button', role: 'radio', 'aria-checked': String(c.my_rating === n), 'aria-label': `${n} étoile${n > 1 ? 's' : ''}`, class: c.my_rating >= n ? 'on' : '',
      onclick: () => act(msg, async () => {
        const next = await api(c.my_rating === n ? 'DELETE' : 'PUT', `/clips/${c.id}/rating`, c.my_rating === n ? undefined : { stars: n });
        Object.assign(current, { rating: next.rating, rating_count: next.rating_count, my_rating: next.my_rating });
        renderDialog();
        say($('dialog-msg'), next.my_rating ? 'Merci pour ta note !' : 'Note retirée.');
      }) }, '★'));
  }
  return box;
}

function reportForm(c, msg) {
  const reason = el('textarea', { rows: '2', maxlength: '300', placeholder: 'Pourquoi ce clip pose problème ? (facultatif)' });
  return el('details', { class: 'lib-report' }, el('summary', {}, 'Signaler ce clip'),
    el('label', { class: 'st-help' }, 'Propos déformés, contenu choquant, droits… L’équipe le vérifiera.'), reason,
    el('button', { class: 'btn secondary small', type: 'button', onclick: (e) => act(msg, async () => {
      await api('POST', `/clips/${c.id}/report`, { reason: reason.value });
      e.target.closest('details').replaceChildren(el('p', { class: 'st-help' }, 'Merci : ton signalement a été transmis.'));
    }) }, 'Envoyer le signalement'));
}

async function share(m, msg) {
  const url = `${location.origin}/bibliotheque/?clip=${m.id}`;
  try {
    if (navigator.share) return await navigator.share({ title: 'Lisnard Studio', text: sourceText(m.video_title, m.video_published_at), url });
    await navigator.clipboard.writeText(url);
    say(msg, 'Lien copié.');
  } catch (e) {
    if (e?.name !== 'AbortError') say(msg, 'Copie impossible : copie l’adresse de la page.', true);
  }
}

function pollPending(id) {
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(async () => {
    if (!dialog.open || current?.id !== id) return;
    try {
      const next = await api('GET', `/clips/${id}`);
      current = next;
      renderDialog();
      if (media(next).file_state === 'pending') pollPending(id);
      else if (state.tab === 'mine' || state.clips.some((c) => c.id === id)) load();
    } catch {
      pollPending(id);
    }
  }, 2500);
}

function renderDialog() {
  const c = current;
  const m = media(c);
  const msg = el('p', { class: 'st-msg', id: 'dialog-msg', role: 'status' });
  const write = state.canWrite;
  const src = sourceText(m.video_title, m.video_published_at);
  const player = m.file_state === 'active'
    ? el('video', { class: 'lib-video', src: `/api/library/clips/${m.id}/file?v=${m.file_version}`, poster: m.has_poster ? `/api/library/clips/${m.id}/poster?v=${m.file_version}` : null, controls: true, playsinline: true, preload: 'metadata' })
    : el('div', { class: 'lib-archived' },
      m.has_poster ? el('img', { src: `/api/library/clips/${m.id}/poster`, alt: '' }) : null,
      el('p', {}, m.file_state === 'pending' ? 'Création du clip en cours…' : 'Ce clip a plus de 30 jours : la vidéo a été archivée, ses réglages sont gardés.'),
      m.file_state === 'archived' && write ? el('button', { class: 'btn small', type: 'button', onclick: () => act(msg, async () => {
        const next = await api('POST', `/clips/${m.id}/recreate`);
        if (c.kind === 'repost') current.original = next; else current = { ...c, ...next };
        renderDialog();
        pollPending(c.id);
      }) }, 'Recréer la vidéo') : null);
  if (m.file_state === 'pending') pollPending(c.id);
  const mine = c.mine && c.kind === 'clip';
  if (c.kind === 'repost' && !c.original) {
    $('dialog-body').replaceChildren(
      el('h2', { id: 'dialog-title' }, c.video_title || 'Clip'),
      el('p', { class: 'dialog-text' }, 'L’original de ce clip a été retiré ou rendu privé par son auteur.'),
      el('button', { class: 'btn secondary small', type: 'button', onclick: () => act(msg, async () => { await api('DELETE', `/clips/${c.id}`); dialog.close(); load(); }) }, 'Retirer de mes clips'),
      msg);
    return;
  }
  $('dialog-body').replaceChildren(...[
    el('h2', { id: 'dialog-title' }, m.video_title || 'Clip'),
    el('p', { class: 'dialog-text' }, src),
    el('div', { class: 'dialog-player' }, player),
    el('div', { class: 'dialog-stats' }, el('span', {}, downloads(m)), el('span', {}, stars(m)), el('span', {}, dur(m.duration_s)), m.remix_of ? el('span', {}, 'Version modifiée d’un autre clip') : null),
    el('div', { class: 'lib-actions' },
      m.file_state === 'active' ? el('a', { class: 'btn small', href: `/api/library/clips/${m.id}/file?use=download`, download: '', onclick: () => setTimeout(() => openClip(c.id), 1500) }, 'Télécharger') : null,
      el('button', { class: 'btn secondary small', type: 'button', onclick: () => share(m, msg) }, 'Partager'),
      el('a', { class: 'btn secondary small', href: `/?v=${encodeURIComponent(m.youtube_id)}&clip=${m.id}` }, 'Modifier'),
      !c.mine && write ? el('button', { class: 'btn secondary small', type: 'button', onclick: () => act(msg, async () => { await api('POST', `/clips/${m.id}/repost`); say(msg, 'Ajouté à « Mes clips ».'); }) }, 'Republier') : null),
    el('p', { class: 'st-help' }, 'Télécharger : la vidéo telle quelle. Modifier : ouvre ses réglages dans l’éditeur pour faire ta version (autres extraits, style, légende).'),
    !m.mine && c.kind === 'clip' ? (write ? el('div', { class: 'lib-rate' }, el('span', {}, 'Ta note'), starsInput(c, msg)) : el('p', { class: 'st-help' }, el('a', { href: loginHref() }, 'Connecte-toi'), ' pour noter ou republier ce clip.')) : null,
    mine ? el('div', { class: 'lib-actions' },
      el('button', { class: 'btn secondary small', type: 'button', onclick: () => act(msg, async () => { current = { ...c, ...(await api('PATCH', `/clips/${c.id}`, { visibility: c.visibility === 'public' ? 'private' : 'public' })) }; renderDialog(); load(); }) },
        c.visibility === 'public' ? 'Passer en privé' : 'Rendre public'),
      el('button', { class: 'btn secondary small danger', type: 'button', onclick: () => act(msg, async () => {
        if (!confirm('Retirer ce clip de la bibliothèque ?')) return;
        await api('DELETE', `/clips/${c.id}`);
        dialog.close();
        load();
      }) }, 'Retirer')) : null,
    c.mine && c.kind === 'repost' ? el('button', { class: 'btn secondary small', type: 'button', onclick: () => act(msg, async () => { await api('DELETE', `/clips/${c.id}`); dialog.close(); load(); }) }, 'Retirer de mes clips') : null,
    !m.mine && write && c.kind === 'clip' ? reportForm(c, msg) : null,
    msg].filter(Boolean));
}

dialog.addEventListener('close', () => {
  clearTimeout(pendingTimer);
  dialog.querySelector('video')?.pause();
  const q = new URLSearchParams(location.search);
  q.delete('clip');
  const query = q.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}`);
});
dialog.addEventListener('click', (e) => {
  if (e.target !== dialog) return;
  const r = dialog.getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close();
});

const params = new URLSearchParams(location.search);
if (params.get('onglet') === 'mes-clips') state.tab = 'mine';
if (SORTS.some(([k]) => k === params.get('tri'))) state.sort = params.get('tri');
if (/^[A-Za-z0-9_-]{11}$/.test(params.get('v') ?? '')) state.v = params.get('v');
const setTab = (tab) => {
  if (state.tab === tab) return;
  state.tab = tab;
  sync();
  load();
};
$('tab-all').addEventListener('click', () => setTab('all'));
$('tab-mine').addEventListener('click', () => setTab('mine'));
document.querySelector('.lib-tabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const next = state.tab === 'all' ? 'mine' : 'all';
  setTab(next);
  $(next === 'mine' ? 'tab-mine' : 'tab-all').focus();
});
$('interview').addEventListener('change', () => { state.v = $('interview').value; sync(); load(); });
$('more').addEventListener('click', () => load({ append: true }));
sync();
load();
if (/^[0-9a-f]{24}$/.test(params.get('clip') ?? '')) openClip(params.get('clip'));
