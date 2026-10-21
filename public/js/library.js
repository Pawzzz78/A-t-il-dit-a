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
let refreshTimer = 0; // rafraîchissement des compteurs après un téléchargement : annulé si la fiche change
let openTicket = 0; // seule la dernière ouverture demandée s'affiche

// Version unique du clip pour la personne qui l'ouvre : le serveur prépare une copie (deuxième passe avec
// micro-transforms invisibles) pendant la lecture ; le téléchargement la sert, sinon l'original.
// `retrying` : la personne a déjà le fichier standard, un nouvel échec ne relance pas de téléchargement
const uniq = { key: null, state: 'idle', progress: 0, timer: 0, want: false, error: '', retry: true, retrying: false };
const uniqKey = (m) => `${m.id}:${m.file_version}`;
const stopUniq = () => {
  clearTimeout(uniq.timer);
  uniq.timer = 0;
  uniq.want = false;
  uniq.retrying = false;
};
const readUniq = (st) => {
  uniq.state = st.state;
  uniq.progress = st.progress ?? 0;
  uniq.error = st.error ?? '';
  uniq.retry = st.retry !== false;
};

function prepUniq(m) {
  const key = uniqKey(m);
  if (uniq.key === key) return;
  uniq.key = key;
  uniq.state = 'idle';
  uniq.progress = 0;
  api('POST', `/clips/${m.id}/variant`)
    .then((st) => {
      if (uniq.key !== key) return;
      readUniq(st);
      uniqTick(m);
    })
    .catch(() => {
      if (uniq.key !== key) return;
      uniq.state = 'error'; // préparation indisponible : le téléchargement servira l'original
      uniqTick(m);
    });
}

function uniqTick(m) {
  const key = uniqKey(m);
  clearTimeout(uniq.timer);
  uniq.timer = setTimeout(async () => {
    if (!dialog.open || !current || uniq.key !== key || uniqKey(media(current)) !== key) return;
    let st;
    try {
      st = await api('GET', `/clips/${m.id}/variant`);
    } catch {
      return uniqTick(m); // à-coup réseau : on réessaie
    }
    if (uniq.key !== key) return;
    readUniq(st);
    if (uniq.want) {
      if (['ready', 'disabled', 'skipped', 'error'].includes(uniq.state)) {
        uniqDownload(m, $('dialog-msg'));
        return;
      }
      const msg = $('dialog-msg');
      if (msg) say(msg, `Préparation de ta version unique ${uniq.progress >= 0.99 ? '' : `${Math.round(uniq.progress * 100)} %` + ' '}…`);
    }
    if (['queued', 'running'].includes(uniq.state)) uniqTick(m);
  }, 1500);
}

function uniqDownload(m, msg) {
  const { state, retrying } = uniq;
  stopUniq();
  // réessai raté : la version standard est déjà téléchargée, on l'annonce sans la relancer
  if (!(retrying && state !== 'ready')) {
    const a = el('a', { href: `/api/library/clips/${m.id}/file?use=download`, download: '' });
    document.body.append(a);
    a.click();
    a.remove();
  }
  if (msg) {
    if (state === 'error') {
      const why = `Ta version unique n'a pas pu être préparée${uniq.error ? ` : ${uniq.error}` : ''}.`;
      say(msg, retrying ? `${why} Tu gardes la version standard déjà téléchargée.` : `${why} Tu télécharges la version standard du clip.`, true);
      if (uniq.retry) msg.append(' ', el('button', { class: 'btn secondary small', type: 'button', onclick: () => retryUniq(m, msg) }, 'Réessayer'));
    } else if (state === 'skipped') {
      say(msg, 'La version unique est momentanément indisponible (file d’attente pleine) : tu télécharges la version standard du clip.');
    } else {
      say(msg, state === 'ready' ? 'Version unique : téléchargement lancé.' : 'Téléchargement lancé.');
    }
  }
  // en cas d'échec le message reste visible (pas de rafraîchissement) ; sinon les compteurs se rafraîchissent
  if (state !== 'error' && state !== 'skipped') {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => current?.id === m.id && dialog.open && openClip(m.id), 1500);
  }
}

function retryUniq(m, msg) {
  stopUniq();
  uniq.key = null; // le serveur remet en file le job raté
  uniq.state = 'idle';
  uniq.progress = 0;
  uniq.error = '';
  uniq.want = true; // comme au premier clic : quand la version est prête (ou qu'elle échoue), on conclut tout seul
  uniq.retrying = true;
  if (msg) say(msg, 'Nouvelle préparation de ta version unique…');
  prepUniq(m);
}

function onDownload(m, msg) {
  const key = uniqKey(m);
  if (uniq.key !== key) {
    uniq.key = key;
    uniq.state = 'idle';
  }
  if (['ready', 'disabled', 'skipped', 'error'].includes(uniq.state)) return uniqDownload(m, msg);
  uniq.want = true;
  say(msg, 'Préparation de ta version unique…');
  if (uniq.state === 'idle') prepUniq(m);
  else uniqTick(m);
}

async function openClip(id) {
  const ticket = ++openTicket;
  clearTimeout(pendingTimer);
  clearTimeout(refreshTimer);
  stopUniq();
  uniq.key = null;
  let clip;
  try {
    clip = await api('GET', `/clips/${id}`);
  } catch (e) {
    if (ticket === openTicket) alert(e.message);
    return;
  }
  if (ticket !== openTicket) return; // une autre fiche a été demandée entre-temps
  current = clip;
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
    if (navigator.share) return await navigator.share({ title: 'Studio Lisnard', text: sourceText(m.video_title, m.video_published_at), url });
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
  if (m.file_state === 'active') prepUniq(m); // pendant que la personne regarde, sa version se prépare
  const active = m.file_state === 'active';
  const section = (cls, title, hint, ...kids) => el('section', { class: `lib-sec ${cls}` }, el('h3', {}, title), hint ? el('p', { class: 'lib-sec-hint' }, hint) : null, ...kids);
  // Download arrow: both options read as actions, not as a choice to tick
  const arrow = () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [k, v] of Object.entries({ d: 'M12 4v11M7 10l5 5 5-5M5 20h14', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(k, v);
    svg.append(path);
    return svg;
  };
  const choice = (props, title, text, tag = 'button') => el(tag, { class: 'lib-choice', ...(tag === 'button' ? { type: 'button' } : {}), ...props }, String(props.class ?? '').includes('dl') ? arrow() : null, el('strong', {}, title), el('span', {}, text));
  const getIt = active ? section('lib-sec-get', 'Récupérer la vidéo', null,
    m.end_card_s
      ? el('div', { class: 'lib-choices' },
        choice({ class: 'lib-choice dl', onclick: () => onDownload(m, msg) }, 'Télécharger avec l’écran de fin', `${dur(m.duration_s)} · finit sur la carte et la source`),
        choice({ class: 'lib-choice dl', href: `/api/library/clips/${m.id}/file?use=download&end=0`, download: '', onclick: () => say(msg, 'Téléchargement sans l’écran de fin lancé.') }, 'Télécharger sans l’écran de fin', `${dur(m.duration_s - m.end_card_s)} · le clip seul`, 'a'))
      : el('div', { class: 'lib-choices' }, choice({ class: 'lib-choice dl', onclick: () => onDownload(m, msg) }, 'Télécharger', `${dur(m.duration_s)} · la vidéo telle quelle, prête à publier`)),
    el('button', { class: 'st-link lib-share', type: 'button', onclick: () => share(m, msg) }, 'Partager le lien de ce clip')) : null;
  const reuse = section('lib-sec-reuse', 'Le réutiliser', null,
    el('div', { class: 'lib-choices' },
      choice({ href: `/?v=${encodeURIComponent(m.youtube_id)}&clip=${m.id}` }, 'Modifier', 'Ouvre ses réglages dans l’éditeur : change l’extrait, le style ou la musique, puis crée ta version.', 'a'),
      !c.mine && write ? choice({ onclick: () => act(msg, async () => { await api('POST', `/clips/${m.id}/repost`); say(msg, 'Ajouté à « Mes clips ».'); }) }, 'Republier', 'L’ajoute à « Mes clips », tel quel, pour le retrouver et le partager.') : null));
  const opinion = !m.mine && c.kind === 'clip'
    ? section('lib-sec-rate', 'Ton avis', null,
      write ? el('div', { class: 'lib-rate' }, el('span', {}, 'Ta note'), starsInput(c, msg)) : el('p', { class: 'st-help' }, el('a', { href: loginHref() }, 'Connecte-toi'), ' pour noter, republier ou signaler ce clip.'),
      write ? reportForm(c, msg) : null)
    : null;
  const manage = c.mine
    ? section('lib-sec-mine', c.kind === 'clip' ? 'Ton clip' : 'Dans tes clips', c.kind === 'clip' ? (c.visibility === 'public' ? 'Public : tout le monde peut le voir, le télécharger et le réutiliser.' : 'Privé : visible seulement par toi, dans « Mes clips ».') : null,
      el('div', { class: 'lib-actions' },
        mine ? el('button', { class: 'btn secondary small', type: 'button', onclick: () => act(msg, async () => { current = { ...c, ...(await api('PATCH', `/clips/${c.id}`, { visibility: c.visibility === 'public' ? 'private' : 'public' })) }; renderDialog(); load(); }) },
          c.visibility === 'public' ? 'Passer en privé' : 'Rendre public') : null,
        el('button', { class: 'btn secondary small danger', type: 'button', onclick: () => act(msg, async () => {
          if (mine && !confirm('Retirer ce clip de la bibliothèque ?')) return;
          await api('DELETE', `/clips/${c.id}`);
          dialog.close();
          load();
        }) }, mine ? 'Retirer de la bibliothèque' : 'Retirer de mes clips')))
    : null;
  $('dialog-body').replaceChildren(...[
    el('header', { class: 'lib-head' },
      el('h2', { id: 'dialog-title' }, m.video_title || 'Clip'),
      el('p', { class: 'dialog-text' }, src),
      el('div', { class: 'lib-chipline' }, el('span', {}, dur(m.duration_s)), el('span', {}, downloads(m)), el('span', {}, stars(m)), m.remix_of ? el('span', {}, 'Version modifiée') : null)),
    el('div', { class: 'lib-body' },
      el('div', { class: 'dialog-player' }, player),
      el('div', { class: 'lib-side' }, getIt, reuse, opinion, manage, msg)),
  ].filter(Boolean));
}

dialog.addEventListener('close', () => {
  openTicket++; // une ouverture encore en vol ne rouvre pas la fiche
  clearTimeout(pendingTimer);
  clearTimeout(refreshTimer);
  stopUniq();
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
