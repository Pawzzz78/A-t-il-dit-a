// Interface d'administration : liste des vidéos, ajout, édition de la transcription.

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');

// ---------------------------------------------------------------- utilitaires

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (['value', 'checked', 'disabled', 'selected'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

class AuthError extends Error {}

async function api(method, path, body) {
  const res = await fetch(`/api/admin${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') throw new AuthError();
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { data, status: res.status });
  return data;
}

function parseTs(str) {
  const s = String(str).trim();
  let m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (m) {
    const [, hh = '0', mm, ss, ms = '0'] = m;
    return ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + Number(ms.padEnd(3, '0'));
  }
  m = s.match(/^(\d+)(?:[.,](\d{1,3}))?$/);
  return m ? Number(m[1]) * 1000 + Number((m[2] ?? '0').padEnd(3, '0')) : null;
}

function fmtTs(ms) {
  const t = Math.floor(ms / 1000);
  const hh = Math.floor(t / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  const rest = `${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
  return hh ? `${hh}:${rest}` : rest;
}

const fmtDate = (d) => {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('fr-FR');
};

function status(el, msg, kind = '') {
  el.textContent = msg;
  el.className = `status ${kind}`;
}

let cleanup = () => {};
let dirtyGuard = () => false;

let ytPromise;
function loadYT() {
  ytPromise ??= new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    document.head.append(h('script', { src: 'https://www.youtube.com/iframe_api' }));
  });
  return ytPromise;
}

// --------------------------------------------------------------------- routeur

async function route() {
  if (dirtyGuard() && !confirm('Des modifications ne sont pas enregistrées. Quitter quand même ?')) {
    history.back();
    return;
  }
  cleanup();
  cleanup = () => {};
  dirtyGuard = () => false;
  try {
    const me = await api('GET', '/me');
    if (!me.authenticated) return renderLogin();
    renderNav();
    const m = location.hash.match(/^#\/video\/(\d+)/);
    if (m) await renderEditor(Number(m[1]));
    else await renderList();
  } catch (e) {
    if (e instanceof AuthError) return renderLogin();
    $app.replaceChildren(h('p', { class: 'status err' }, e.message));
  }
}
window.addEventListener('hashchange', route);

function renderNav() {
  $nav.replaceChildren(
    h('a', { href: '#/' }, 'Vidéos'),
    ' · ',
    h('a', { href: '/' }, 'Voir le site'),
    ' · ',
    h(
      'a',
      {
        href: '#',
        onclick: async (e) => {
          e.preventDefault();
          await api('POST', '/logout', {});
          renderLogin();
        },
      },
      'Déconnexion',
    ),
  );
}

// ----------------------------------------------------------------------- login

function renderLogin() {
  $nav.replaceChildren();
  const msg = h('p', { class: 'status' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, autofocus: true });
  const form = h(
    'form',
    {
      class: 'panel login',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/login', { password: pw.value });
          route();
        } catch (err) {
          status(msg, err.message, 'err');
        }
      },
    },
    h('h2', {}, 'Connexion'),
    h('label', { class: 'field' }, 'Mot de passe', pw),
    h('button', { class: 'btn', type: 'submit' }, 'Se connecter'),
    msg,
  );
  $app.replaceChildren(form);
  pw.focus();
}

// ----------------------------------------------------------------------- liste

async function renderList() {
  const [videos, config] = await Promise.all([api('GET', '/videos'), api('GET', '/config')]);

  const tbody = h('tbody');
  for (const v of videos) {
    tbody.append(
      h(
        'tr',
        { class: 'clickable', onclick: () => (location.hash = `#/video/${v.id}`) },
        h('td', {}, v.thumbnail_url ? h('img', { src: v.thumbnail_url, alt: '', loading: 'lazy' }) : null),
        h('td', {}, h('div', { class: 't' }, v.title || v.youtube_id), h('div', { class: 'status' }, v.channel)),
        h('td', {}, fmtDate(v.published_at)),
        h('td', {}, String(v.segment_count)),
        h(
          'td',
          {},
          v.segment_count === 0 ? h('span', { class: 'badge' }, 'vide') : null,
          v.edited ? h('span', { class: 'badge ok' }, 'corrigée') : h('span', { class: 'badge' }, v.source === 'supadata' ? 'auto' : 'manuelle'),
        ),
      ),
    );
  }

  const list = h(
    'section',
    { class: 'panel' },
    h('h2', {}, `Vidéos (${videos.length})`),
    videos.length
      ? h(
          'table',
          { class: 'videos' },
          h('thead', {}, h('tr', {}, ...['', 'Titre', 'Date', 'Segments', 'Transcription'].map((t) => h('th', {}, t)))),
          tbody,
        )
      : h('p', { class: 'status' }, 'Aucune vidéo pour le moment. Ajoute-en une ci-dessous.'),
  );

  $app.replaceChildren(addForm(config), list);
}

function addForm(config) {
  const msg = h('p', { class: 'status' });
  const url = h('input', { type: 'text', placeholder: 'https://www.youtube.com/watch?v=…', required: true });
  const lang = h('input', { type: 'text', value: 'fr', maxlength: '5' });
  const title = h('input', { type: 'text', placeholder: 'Rempli automatiquement si vide' });
  const channel = h('input', { type: 'text', placeholder: 'Rempli automatiquement si vide' });
  const date = h('input', { type: 'date' });
  const paste = h('textarea', { rows: '8', placeholder: 'SRT, VTT, ou lignes « [00:12] texte »… ou texte brut' });
  const pasteWrap = h('label', { class: 'field', hidden: true }, 'Transcription à coller', paste);
  pasteWrap.hidden = true;

  const mode = (value, label, checked, disabled = false) =>
    h(
      'label',
      { class: 'radio' },
      h('input', {
        type: 'radio',
        name: 'mode',
        value,
        checked,
        disabled,
        onchange: () => (pasteWrap.hidden = value !== 'paste'),
      }),
      label,
    );

  const submit = h('button', { class: 'btn', type: 'submit' }, 'Ajouter la vidéo');
  const form = h(
    'form',
    {
      class: 'panel',
      onsubmit: async (e) => {
        e.preventDefault();
        const chosen = form.querySelector('input[name=mode]:checked').value;
        submit.disabled = true;
        status(msg, chosen === 'supadata' ? 'Récupération de la transcription…' : 'Ajout…');
        try {
          const { id } = await api('POST', '/videos', {
            input: url.value,
            mode: chosen,
            lang: lang.value || 'fr',
            transcript: paste.value,
            title: title.value || undefined,
            channel: channel.value || undefined,
            published_at: date.value || undefined,
          });
          location.hash = `#/video/${id}`;
        } catch (err) {
          if (err.status === 409 && err.data?.id) {
            status(msg, 'Déjà ajoutée — ouverture…', 'ok');
            location.hash = `#/video/${err.data.id}`;
          } else status(msg, err.message, 'err');
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('h2', {}, 'Ajouter une vidéo'),
    h('label', { class: 'field' }, 'URL ou identifiant YouTube', url),
    h(
      'div',
      { class: 'field' },
      'Transcription',
      mode('supadata', config.supadata ? 'Récupérer automatiquement (Supadata)' : 'Récupérer automatiquement — SUPADATA_API_KEY non configurée', config.supadata, !config.supadata),
      mode('paste', 'Coller une transcription', !config.supadata),
      mode('empty', 'Vide (je la saisis dans l’éditeur)', false),
    ),
    pasteWrap,
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'field' }, 'Langue', lang),
      h('label', { class: 'field' }, 'Titre (optionnel)', title),
      h('label', { class: 'field' }, 'Chaîne (optionnel)', channel),
      h('label', { class: 'field' }, 'Date de publication', date),
    ),
    h('div', { class: 'actions' }, submit, msg),
  );
  pasteWrap.hidden = config.supadata;
  return form;
}

// ---------------------------------------------------------------------- éditeur

async function renderEditor(id) {
  const { video, segments } = await api('GET', `/videos/${id}`);
  let segs = segments.map((s) => ({ ...s, orig: s.text, origStart: s.start_ms }));
  let dirty = false;
  let player = null;
  let activeIdx = -1;

  const markDirty = (v = true) => {
    dirty = v;
    saveBtn.disabled = !dirty;
    saveMsg.textContent = dirty ? 'Modifications non enregistrées' : 'À jour';
    saveMsg.className = `status${dirty ? '' : ' ok'}`;
  };
  dirtyGuard = () => dirty;
  const beforeUnload = (e) => dirty && e.preventDefault();
  window.addEventListener('beforeunload', beforeUnload);
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  };
  window.addEventListener('keydown', onKey);

  // --- infos de la vidéo
  const infoMsg = h('span', { class: 'status' });
  const f = {
    title: h('input', { type: 'text', value: video.title }),
    channel: h('input', { type: 'text', value: video.channel }),
    date: h('input', { type: 'date', value: video.published_at?.slice(0, 10) ?? '' }),
    lang: h('input', { type: 'text', value: video.lang ?? '', maxlength: '5' }),
  };
  const info = h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'field' }, 'Titre', f.title),
      h('label', { class: 'field' }, 'Chaîne', f.channel),
      h('label', { class: 'field' }, 'Date', f.date),
      h('label', { class: 'field' }, 'Langue', f.lang),
    ),
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        {
          class: 'btn secondary small',
          type: 'button',
          onclick: async () => {
            try {
              await api('PATCH', `/videos/${id}`, {
                title: f.title.value,
                channel: f.channel.value,
                published_at: f.date.value || null,
                lang: f.lang.value,
              });
              status(infoMsg, 'Infos enregistrées', 'ok');
            } catch (e) {
              status(infoMsg, e.message, 'err');
            }
          },
        },
        'Enregistrer les infos',
      ),
      infoMsg,
      h('a', { href: `https://www.youtube.com/watch?v=${video.youtube_id}`, target: '_blank', rel: 'noopener' }, 'Ouvrir sur YouTube ↗'),
    ),
  );

  // --- liste des segments
  const list = h('div', { class: 'panel segs' });
  const rowEls = [];

  const autosize = (ta) => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };

  function renderSegs() {
    rowEls.length = 0;
    list.replaceChildren();
    if (!segs.length) list.append(h('p', { class: 'status' }, 'Aucun segment. Utilise « + » ou importe une transcription.'));
    segs.forEach((s, i) => {
      const ts = h('input', {
        class: 'ts',
        type: 'text',
        value: fmtTs(s.start_ms),
        'aria-label': 'Horodatage',
        onchange: () => {
          const ms = parseTs(ts.value);
          if (ms == null) ts.value = fmtTs(s.start_ms);
          else if (Math.floor(ms / 1000) !== Math.floor(s.start_ms / 1000)) {
            s.start_ms = ms;
            ts.value = fmtTs(ms);
            row.classList.add('dirty');
            markDirty();
          }
        },
      });
      const ta = h('textarea', {
        class: 'seg',
        rows: '1',
        value: s.text,
        spellcheck: 'true',
        lang: 'fr',
        oninput: () => {
          s.text = ta.value;
          row.classList.toggle('dirty', s.text !== s.orig || s.start_ms !== s.origStart);
          autosize(ta);
          markDirty();
        },
      });
      const btn = (label, title, fn) => h('button', { type: 'button', title, 'aria-label': title, onclick: fn }, label);
      const row = h(
        'div',
        { class: `seg${s.text !== s.orig || s.start_ms !== s.origStart ? ' dirty' : ''}` },
        h(
          'div',
          { class: 'tcell' },
          h('button', { class: 'play', type: 'button', title: 'Écouter à partir d’ici', onclick: () => seek(s.start_ms) }, '▶'),
          ts,
        ),
        ta,
        h(
          'div',
          { class: 'tools' },
          btn('✂', 'Couper au curseur', () => {
            const at = ta.selectionStart;
            const left = s.text.slice(0, at).trim();
            const right = s.text.slice(at).trim();
            if (!left || !right) return;
            const next = segs[i + 1];
            const span = s.duration_ms ?? (next ? next.start_ms - s.start_ms : 0);
            const newStart = s.start_ms + Math.round(Math.max(span, 0) * (left.length / s.text.length));
            s.text = left;
            segs.splice(i + 1, 0, { start_ms: newStart, duration_ms: null, text: right, orig: '', origStart: -1 });
            markDirty();
            renderSegs();
          }),
          btn('⤵', 'Fusionner avec la suivante', () => {
            const next = segs[i + 1];
            if (!next) return;
            s.text = `${s.text.trim()} ${next.text.trim()}`;
            s.duration_ms = null;
            segs.splice(i + 1, 1);
            markDirty();
            renderSegs();
          }),
          btn('＋', 'Insérer un segment dessous', () => {
            segs.splice(i + 1, 0, { start_ms: s.start_ms + (s.duration_ms ?? 0), duration_ms: null, text: '', orig: '', origStart: -1 });
            markDirty();
            renderSegs();
            rowEls[i + 1]?.querySelector('textarea').focus();
          }),
          btn('✕', 'Supprimer', () => {
            segs.splice(i, 1);
            markDirty();
            renderSegs();
          }),
        ),
      );
      rowEls.push(row);
      list.append(row);
    });
    requestAnimationFrame(() => list.querySelectorAll('textarea.seg').forEach(autosize));
    activeIdx = -1;
  }

  // --- lecteur
  const playerBox = h('div', { class: 'player' }, h('div', { id: 'yt-player' }));
  const follow = h('input', { type: 'checkbox', checked: true });
  loadYT().then((YT) => {
    player = new YT.Player('yt-player', {
      videoId: video.youtube_id,
      width: '100%',
      height: '100%',
      playerVars: { rel: 0, modestbranding: 1, cc_load_policy: 0 },
    });
  });
  function seek(ms) {
    if (!player?.seekTo) return;
    player.seekTo(ms / 1000, true);
    player.playVideo();
  }
  const timer = setInterval(() => {
    if (!player?.getCurrentTime || player.getPlayerState?.() !== 1) return;
    const t = player.getCurrentTime() * 1000;
    let idx = -1;
    for (let i = 0; i < segs.length; i++) if (segs[i].start_ms <= t) idx = i;
    if (idx === activeIdx) return;
    rowEls[activeIdx]?.classList.remove('active');
    activeIdx = idx;
    const el = rowEls[idx];
    el?.classList.add('active');
    if (follow.checked) el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 400);

  // --- chercher / remplacer
  const findIn = h('input', { class: 'text', type: 'text', placeholder: 'Chercher…' });
  const replIn = h('input', { class: 'text', type: 'text', placeholder: 'Remplacer par…' });
  const findMsg = h('span', { class: 'status' });
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const countMatches = () => {
    if (!findIn.value) return status(findMsg, '');
    const re = new RegExp(escapeRe(findIn.value), 'gi');
    const n = segs.reduce((acc, s) => acc + (s.text.match(re)?.length ?? 0), 0);
    status(findMsg, `${n} occurrence${n > 1 ? 's' : ''}`);
  };
  findIn.addEventListener('input', countMatches);
  const tools = h(
    'section',
    { class: 'panel' },
    h('h3', {}, 'Chercher / remplacer'),
    h('p', { class: 'status' }, 'Pratique pour corriger un nom propre mal reconnu (insensible à la casse).'),
    findIn,
    h('div', { style: 'height:.4rem' }),
    replIn,
    h(
      'div',
      { class: 'actions', style: 'margin-top:.6rem' },
      h(
        'button',
        {
          class: 'btn secondary small',
          type: 'button',
          onclick: () => {
            if (!findIn.value) return;
            const re = new RegExp(escapeRe(findIn.value), 'gi');
            let n = 0;
            for (const s of segs) {
              const next = s.text.replace(re, () => (n++, replIn.value));
              s.text = next;
            }
            if (n) {
              markDirty();
              renderSegs();
            }
            status(findMsg, `${n} remplacement${n > 1 ? 's' : ''}`, n ? 'ok' : '');
          },
        },
        'Tout remplacer',
      ),
      findMsg,
    ),
  );

  // --- source de la transcription
  const srcMsg = h('p', { class: 'status' });
  const pasteArea = h('textarea', { class: 'text', rows: '6', placeholder: 'SRT, VTT, « [00:12] texte »…' });
  const config = await api('GET', '/config');
  const source = h(
    'section',
    { class: 'panel' },
    h(
      'details',
      {},
      h('summary', {}, 'Remplacer la transcription'),
      h('p', { class: 'status' }, 'Écrase les segments actuels (modifications non enregistrées comprises).'),
      config.supadata
        ? h(
            'button',
            {
              class: 'btn secondary small',
              type: 'button',
              onclick: async () => {
                if (!confirm(video.edited ? 'Tes corrections manuelles seront perdues. Continuer ?' : 'Récupérer à nouveau la transcription ?')) return;
                status(srcMsg, 'Récupération…');
                try {
                  await api('POST', `/videos/${id}/refetch`, { lang: f.lang.value || undefined });
                  dirty = false;
                  route();
                } catch (e) {
                  status(srcMsg, e.message, 'err');
                }
              },
            },
            'Récupérer via Supadata',
          )
        : null,
      h('div', { style: 'height:.6rem' }),
      pasteArea,
      h(
        'button',
        {
          class: 'btn secondary small',
          type: 'button',
          style: 'margin-top:.5rem',
          onclick: async () => {
            if (!pasteArea.value.trim() || !confirm('Remplacer toute la transcription par ce texte ?')) return;
            try {
              await api('POST', `/videos/${id}/import`, { transcript: pasteArea.value });
              dirty = false;
              route();
            } catch (e) {
              status(srcMsg, e.message, 'err');
            }
          },
        },
        'Importer le texte collé',
      ),
      srcMsg,
    ),
  );

  const danger = h(
    'section',
    { class: 'panel' },
    h(
      'button',
      {
        class: 'btn danger small',
        type: 'button',
        onclick: async () => {
          if (!confirm('Supprimer cette vidéo et sa transcription ?')) return;
          await api('DELETE', `/videos/${id}`);
          dirty = false;
          location.hash = '#/';
        },
      },
      'Supprimer la vidéo',
    ),
  );

  // --- enregistrement
  const saveMsg = h('span', { class: 'status ok' }, 'À jour');
  const saveBtn = h('button', { class: 'btn', type: 'button', disabled: true, onclick: () => save() }, 'Enregistrer (Ctrl+S)');
  async function save() {
    if (!dirty) return;
    saveBtn.disabled = true;
    status(saveMsg, 'Enregistrement…');
    try {
      segs = segs.filter((s) => s.text.trim());
      await api('PUT', `/videos/${id}/segments`, {
        segments: segs.map(({ start_ms, duration_ms, text }) => ({ start_ms, duration_ms, text })),
      });
      segs.forEach((s) => ((s.orig = s.text), (s.origStart = s.start_ms)));
      renderSegs();
      markDirty(false);
    } catch (e) {
      status(saveMsg, e.message, 'err');
      saveBtn.disabled = false;
    }
  }

  const savebar = h(
    'div',
    { class: 'savebar' },
    h('span', {}, h('strong', {}, `${video.title || video.youtube_id}`), ' ', video.edited ? h('span', { class: 'badge ok' }, 'corrigée') : null),
    h('label', { class: 'status' }, follow, ' Suivre la lecture'),
    saveMsg,
    saveBtn,
  );

  renderSegs();
  $app.replaceChildren(
    h('p', {}, h('a', { href: '#/' }, '← Toutes les vidéos')),
    info,
    h('div', { class: 'editor' }, h('aside', { class: 'side' }, playerBox, tools, source, danger), list),
    savebar,
  );

  cleanup = () => {
    clearInterval(timer);
    window.removeEventListener('beforeunload', beforeUnload);
    window.removeEventListener('keydown', onKey);
    player?.destroy?.();
  };
}

route();
