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

const fmtDuration = (sec) => {
  if (sec == null) return '';
  if (sec < 60) return `${sec} s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
};

const fmtDate = (d) => {
  if (!d) return '—';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('fr-FR');
};

function status(el, msg, kind = '') {
  el.textContent = msg;
  el.className = `status ${kind}`;
}


const SCRIPT_URL = 'https://github.com/Pawzzz78/A-t-il-dit-a/tree/ccr-cd4ad929-84sbtv/tools';

/** Commande à copier-coller, avec un bouton « Copier ». */
function commandBox(command) {
  const status = h('span', { class: 'status' });
  const copy = h(
    'button',
    {
      class: 'btn secondary small',
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(command);
          status.textContent = 'Copié';
        } catch {
          const range = document.createRange();
          range.selectNodeContents(box);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          status.textContent = 'Sélectionné : copie-le à la main';
        }
      },
    },
    'Copier la commande',
  );
  const box = h('pre', { class: 'cmd' }, command);
  return h('div', {}, box, h('div', { class: 'actions' }, copy, status));
}

const whisperCommand = (youtubeId) =>
  `python tools/transcribe.py --site ${location.origin} https://www.youtube.com/watch?v=${youtubeId}`;

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
    else if (location.hash === '#/sync') await renderSync();
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
    h('a', { href: '#/sync' }, 'Synchronisation'),
    h('a', { href: '/' }, 'Voir le site'),
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
        h('td', {}, h('div', { class: 't' }, v.title || v.youtube_id), h('div', { class: 'status' }, [v.channel, fmtDuration(v.duration_s)].filter(Boolean).join(' · '))),
        h('td', {}, fmtDate(v.published_at)),
        h('td', {}, String(v.segment_count)),
        h(
          'td',
          {},
          v.translated ? h('span', { class: 'badge ok', title: `Traduit automatiquement depuis ${v.original_lang ?? '?'}` }, `traduit ${v.original_lang ?? ''}→${v.lang ?? ''}`) : null,
          !v.translated && v.lang && v.lang !== 'fr' ? h('span', { class: 'badge warn', title: 'Transcription non traduite' }, `langue : ${v.lang}`) : null,
          v.sync_status === 'pending' ? h('span', { class: 'badge' }, 'en attente') : null,
          v.sync_status === 'failed' ? h('span', { class: 'badge warn', title: v.sync_error ?? '' }, 'échec') : null,
          v.segment_count === 0 && !v.sync_status ? h('span', { class: 'badge' }, 'vide') : null,
          v.edited ? h('span', { class: 'badge ok' }, 'corrigée') : h('span', { class: 'badge' }, { supadata: 'auto', whisper: 'whisper' }[v.source] ?? 'manuelle'),
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


// ------------------------------------------------------------- synchronisation

let syncFlash = null; // message affiché après le rechargement de la page

async function renderSync() {
  const o = await api('GET', '/sync/overview');
  const msg = h('p', { class: 'status' });
  if (syncFlash) {
    status(msg, syncFlash.text, syncFlash.kind);
    syncFlash = null;
  }
  // fn peut renvoyer un texte à afficher une fois la page rechargée
  const act = async (fn, okMsg) => {
    try {
      const result = await fn();
      const text = typeof result === 'string' ? result : okMsg;
      if (text) syncFlash = { text, kind: 'ok' };
      await renderSync();
    } catch (e) {
      status(msg, e.message, 'err');
    }
  };

  const plural = (n, one, many) => (n > 1 ? many : one);
  /** Aperçu puis, après confirmation, suppression des Shorts déjà importés d'une chaîne. */
  const purgeShortsFlow = async (c) => {
    const p = await api('POST', `/sync/channels/${c.id}/shorts/preview`, {});
    if (!p.total) {
      return p.protected
        ? `Aucun Short à supprimer (${p.protected} corrigé${plural(p.protected, '', 's')} à la main conservé${plural(p.protected, '', 's')}).`
        : 'Aucun Short à supprimer : la chaîne est propre.';
    }
    const text = [
      `${p.total} Short${plural(p.total, '', 's')} (ou vidéo${plural(p.total, '', 's')} trop courte${plural(p.total, '', 's')}) à supprimer : ${p.with_transcript} déjà transcrit${plural(p.with_transcript, '', 's')} (crédits Supadata déjà dépensés) et ${p.pending} en attente.`,
      p.detection === 'playlist'
        ? `Détection : liste des Shorts de YouTube + durée de 60 s ou moins${c.min_duration_s ? ` + durée inférieure à ${c.min_duration_s} s` : ''}.`
        : c.min_duration_s
          ? `Détection par la durée seule (60 s ou moins, ou inférieure à ${c.min_duration_s} s).`
          : 'Détection par la durée seule (60 s ou moins) : les Shorts plus longs ne seront pas repérés. Utilise « Durée minimale… » (181 s) pour les écarter tous.',
      p.protected ? `${p.protected} corrigé${plural(p.protected, '', 's')} à la main : conservé${plural(p.protected, '', 's')}.` : '',
      `Exemples :\n${p.examples.map((e) => `• ${e.title} (${fmtDuration(e.duration_s) || '?'})`).join('\n')}`,
      'Les vidéos ajoutées à la main ne sont jamais touchées. Les Shorts supprimés ne reviendront pas. Cette action est définitive. Continuer ?',
    ].filter(Boolean).join('\n\n');
    if (!confirm(text)) return null;
    const r = await api('POST', `/sync/channels/${c.id}/shorts/purge`, { confirm: true });
    return `${r.removed} Short${plural(r.removed, '', 's')} supprimé${plural(r.removed, '', 's')}. Ils ne seront plus importés.`;
  };
  const when = (d) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
  const keyLine = (ok, name, help) =>
    h('li', {}, ok ? '✅ ' : '❌ ', h('strong', {}, name), ok ? ' configurée' : ` manquante — ${help}`);

  const stat = (n, label) => h('div', { class: 'stat' }, h('div', { class: 'n' }, String(n)), h('div', { class: 'l' }, label));

  const state = h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Synchronisation automatique'),
    h(
      'ul',
      { class: 'checks' },
      keyLine(o.keys.youtube, 'YOUTUBE_API_KEY', 'nécessaire pour lister les vidéos d’une chaîne (clé « YouTube Data API v3 », gratuite)'),
      keyLine(o.keys.supadata, 'SUPADATA_API_KEY', 'nécessaire pour récupérer les transcriptions'),
    ),
    h('div', { class: 'stats' }, stat(o.counts.pending, 'en attente'), stat(o.counts.done, 'transcrites auto.'), stat(o.counts.failed, 'en échec'), stat(o.counts.manual, 'ajoutées à la main')),
    h(
      'p',
      { class: 'status' },
      `Chaque jour (toutes les ${o.interval_hours} h), les nouvelles vidéos des chaînes suivies sont détectées puis mises en file d’attente. `,
      'Chaque vidéo coûte 1 crédit Supadata (sous-titres existants uniquement : aucune transcription générée par IA). ',
      'Les vidéos déjà présentes ne sont jamais retraitées : leurs transcriptions, automatiques ou corrigées à la main, ne sont jamais modifiées.',
    ),
    o.paused
      ? h(
          'p',
          { class: 'notice' },
          `Traitement en pause. ${o.counts.pending} vidéo${o.counts.pending > 1 ? 's' : ''} en attente ≈ ${o.counts.pending} crédit${o.counts.pending > 1 ? 's' : ''} Supadata. La détection des nouvelles vidéos continue, mais aucune transcription n’est demandée tant que tu n’as pas démarré.`,
        )
      : h('p', { class: 'status ok' }, '▶ Traitement actif.'),
    o.llm_error
      ? h(
          'p',
          { class: 'notice' },
          `Dernière erreur du modèle IA (${o.llm_error.feature}, ${when(o.llm_error.at)}) : ${o.llm_error.message}`,
        )
      : null,
    o.cooldown_until ? h('p', { class: 'status err' }, `Traitement suspendu jusqu’à ${when(o.cooldown_until)} : ${o.last_error ?? ''}`) : null,
    h(
      'div',
      { class: 'actions' },
      o.paused
        ? h('button', { class: 'btn', type: 'button', disabled: !o.keys.supadata, onclick: () => act(() => api('POST', '/sync/resume', {}), 'Traitement démarré.') }, 'Démarrer le traitement')
        : h('button', { class: 'btn secondary', type: 'button', onclick: () => act(() => api('POST', '/sync/pause', {}), 'Mis en pause.') }, 'Mettre en pause'),
      !o.paused ? h('button', { class: 'btn secondary', type: 'button', onclick: () => act(() => api('POST', '/sync/run', {}), 'Passe lancée.') }, 'Lancer une passe maintenant') : null,
      msg,
    ),
  );


  // --- résumés automatiques
  const sm = o.summaries;
  const summariesPanel = h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Résumés automatiques'),
    h('ul', { class: 'checks' }, keyLine(sm.configured, 'OPENROUTER_API_KEY', 'nécessaire pour rédiger les résumés')),
    h('div', { class: 'stats' }, stat(sm.ready, 'résumés prêts'), stat(sm.waiting, 'en attente'), stat(sm.failed, 'en échec')),
    h(
      'p',
      { class: 'status' },
      `Chaque vidéo transcrite reçoit automatiquement son résumé, quelques minutes après sa transcription (modèle : ${sm.model}). Un résumé n’est écrit qu’une seule fois : une vidéo qui en a un n’est jamais re-résumée automatiquement. Les visiteurs ne font qu’afficher les résumés déjà prêts : ils ne déclenchent aucun appel à l’IA, donc aucun coût.`,
    ),
    sm.paused
      ? h('p', { class: 'notice' }, 'Génération des résumés en pause : les nouvelles vidéos n’auront pas de résumé tant que tu ne l’as pas relancée.')
      : sm.configured
        ? h('p', { class: 'status ok' }, 'Génération automatique active.')
        : null,
    sm.cooldown_until ? h('p', { class: 'status err' }, `Génération suspendue jusqu’à ${when(sm.cooldown_until)} après une erreur du modèle (voir le message ci-dessus).`) : null,
    h(
      'div',
      { class: 'actions' },
      sm.paused
        ? h('button', { class: 'btn', type: 'button', disabled: !sm.configured, onclick: () => act(() => api('POST', '/sync/summaries/resume', {}), 'Génération des résumés relancée.') }, 'Relancer les résumés')
        : h('button', { class: 'btn secondary', type: 'button', onclick: () => act(() => api('POST', '/sync/summaries/pause', {}), 'Génération des résumés mise en pause.') }, 'Mettre en pause'),
      !sm.paused && sm.configured ? h('button', { class: 'btn secondary', type: 'button', onclick: () => act(() => api('POST', '/sync/summaries/run', {}), 'Passe lancée : les résumés en attente sont rédigés (une minute environ chacun).') }, 'Lancer maintenant') : null,
    ),
    sm.failed_list.length
      ? h(
          'div',
          { class: 'chan-list', style: 'margin-top:1rem' },
          h('p', { class: 'status' }, 'Résumés en échec (5 tentatives) :'),
          sm.failed_list.map((v) =>
            h(
              'article',
              { class: 'chan' },
              h('div', { class: 't' }, v.title),
              h('p', { class: 'status err' }, v.summary_error ?? ''),
              h(
                'div',
                { class: 'actions' },
                h('button', { class: 'btn secondary small', type: 'button', onclick: () => act(() => api('POST', `/sync/summaries/${v.id}/retry`, {}), 'Nouvelle tentative lancée.') }, 'Réessayer'),
                h('a', { class: 'btn small', href: `#/video/${v.id}` }, 'Ouvrir'),
              ),
            ),
          ),
        )
      : null,
  );

  // --- chaînes
  const input = h('input', { type: 'text', placeholder: 'https://www.youtube.com/@nomdelachaine', required: true });
  const minD = h('input', { type: 'number', min: '0', value: '0' });
  const noShorts = h('input', { type: 'checkbox', checked: true });
  const addMsg = h('p', { class: 'status' });
  const addBtn = h('button', { class: 'btn', type: 'submit', disabled: !o.keys.youtube }, 'Ajouter et lister les vidéos');
  const addForm = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        addBtn.disabled = true;
        status(addMsg, 'Recherche de la chaîne et liste des vidéos… (peut prendre quelques secondes)');
        try {
          const r = await api('POST', '/sync/channels', { input: input.value, min_duration_s: Number(minD.value) || 0, exclude_shorts: noShorts.checked });
          if (r.error) status(addMsg, `Chaîne ajoutée, mais la liste a échoué : ${r.error}`, 'err');
          else {
            await renderSync();
            status(document.querySelector('#sync-msg'), `${r.added} vidéo${r.added > 1 ? 's' : ''} trouvée${r.added > 1 ? 's' : ''} et mise${r.added > 1 ? 's' : ''} en file d’attente.`, 'ok');
          }
        } catch (err) {
          status(addMsg, err.message, 'err');
          addBtn.disabled = !o.keys.youtube;
        }
      },
    },
    h('div', { class: 'row' }, h('label', { class: 'field' }, 'Chaîne YouTube (URL, @nom ou identifiant UC…)', input), h('label', { class: 'field' }, 'Durée minimale (secondes, 0 = aucune)', minD)),
    h('label', { class: 'radio' }, noShorts, 'Exclure les Shorts (vidéos courtes verticales) : seulement les vidéos longues'),
    h('div', { class: 'actions' }, addBtn, addMsg),
  );

  const rows = o.channels.map((c) =>
    h(
      'article',
      { class: 'chan' },
      h('div', { class: 't' }, c.title || c.youtube_channel_id, c.handle ? h('span', { class: 'status' }, ` ${c.handle}`) : null),
      h(
        'p',
        { class: 'chan-meta' },
        h('span', {}, `${c.video_count} vidéo${plural(c.video_count, '', 's')}`),
        h('span', {}, `Durée min. : ${c.min_duration_s ? `${c.min_duration_s} s` : 'aucune'}`),
        h('span', {}, 'Shorts : ', c.exclude_shorts ? 'exclus' : h('strong', { class: 'status err' }, 'inclus')),
        h('span', {}, c.enabled ? '' : 'suspendue'),
        h('span', {}, c.last_discovery_error ? h('span', { class: 'status err' }, c.last_discovery_error) : `Vérifiée : ${when(c.last_discovery_at)}`),
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn secondary small', type: 'button', onclick: () => act(async () => { const r = await api('POST', `/sync/channels/${c.id}/discover`, {}); return `${r.added} nouvelle${r.added > 1 ? 's' : ''} vidéo${r.added > 1 ? 's' : ''}.`; }) }, 'Chercher maintenant'),
        h('button', { class: 'btn small', type: 'button', title: 'Supprime les Shorts déjà importés (aperçu et confirmation avant)', onclick: () => act(() => purgeShortsFlow(c)) }, 'Retirer les Shorts…'),
        h(
          'button',
          {
            class: 'btn secondary small',
            type: 'button',
            title: 'Les vidéos plus courtes ne sont pas importées, et « Retirer les Shorts… » supprime celles déjà importées',
            onclick: () => act(async () => {
              const v = prompt('Durée minimale des vidéos, en secondes (0 = aucune).\n\nAstuce : 181 écarte tous les Shorts, même ceux de 1 à 3 minutes (les vidéos de moins de 3 minutes ne sont alors plus importées).\n\nPuis clique sur « Retirer les Shorts… » pour supprimer celles déjà importées.', String(c.min_duration_s || 0));
              if (v === null) return null;
              const n = Number(v);
              if (!Number.isFinite(n) || n < 0) throw new Error('Durée invalide.');
              await api('PATCH', `/sync/channels/${c.id}`, { min_duration_s: Math.round(n) });
              return n ? `Durée minimale : ${Math.round(n)} s. Clique sur « Retirer les Shorts… » pour supprimer celles déjà importées.` : 'Plus de durée minimale.';
            }),
          },
          'Durée minimale…',
        ),
        c.exclude_shorts ? null : h('button', { class: 'btn secondary small', type: 'button', onclick: () => act(() => api('PATCH', `/sync/channels/${c.id}`, { exclude_shorts: true }), 'Les Shorts sont désormais exclus.') }, 'Exclure les Shorts'),
        h('button', { class: 'btn secondary small', type: 'button', onclick: () => act(() => api('PATCH', `/sync/channels/${c.id}`, { enabled: !c.enabled })) }, c.enabled ? 'Suspendre' : 'Reprendre'),
        h('button', { class: 'btn danger small', type: 'button', onclick: () => confirm('Ne plus suivre cette chaîne ? Les vidéos déjà importées sont conservées.') && act(() => api('DELETE', `/sync/channels/${c.id}`)) }, 'Retirer la chaîne'),
      ),
    ),
  );
  const channels = h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Chaînes suivies'),
    h('p', { id: 'sync-msg', class: 'status' }),
    rows.length ? h('div', { class: 'chan-list' }, rows) : h('p', { class: 'status' }, 'Aucune chaîne suivie.'),
    h('h3', { style: 'margin-top:1.2rem' }, 'Ajouter une chaîne'),
    addForm,
  );

  // --- échecs
  const failed = o.failed.length
    ? h(
        'section',
        { class: 'panel' },
        h('h2', {}, `Vidéos en échec (${o.counts.failed})`),
        h('p', { class: 'status' }, 'Souvent : pas de sous-titres disponibles. Pour une vidéo récente, la synchro réessaie toute seule (les sous-titres automatiques arrivent parfois après quelques heures). Sinon, transcris-les gratuitement avec Whisper sur ton ordinateur (une fois fini, la transcription est enregistrée pour tout le monde). Pour toutes les vidéos de cette liste d’un coup :'),
        commandBox(`python tools/transcribe.py --site ${location.origin} --all-failed`),
        h('p', { class: 'status' }, h('a', { href: SCRIPT_URL, target: '_blank', rel: 'noopener' }, 'Récupérer le dossier tools/ ↗'), ' · ou ouvre une vidéo pour la transcrire seule, ou coller une transcription à la main.'),
        h(
          'div',
          { class: 'chan-list' },
          o.failed.map((v) =>
            h(
              'article',
              { class: 'chan' },
              h('div', { class: 't' }, v.title || v.youtube_id),
              h('p', { class: 'status err' }, v.sync_error ?? ''),
              h(
                'div',
                { class: 'actions' },
                h('button', { class: 'btn secondary small', type: 'button', onclick: () => act(() => api('POST', `/sync/videos/${v.id}/retry`, {}), 'Remise en file d’attente.') }, 'Réessayer'),
                h('a', { class: 'btn small', href: `#/video/${v.id}` }, 'Ouvrir'),
              ),
            ),
          ),
        ),
      )
    : null;

  $app.replaceChildren(...[state, summariesPanel, channels, failed].filter(Boolean));
  const timer = setInterval(() => document.hidden || renderSync().catch(() => {}), 20000);
  cleanup = () => clearInterval(timer);
}

// ---------------------------------------------------------------------- éditeur

async function renderEditor(id) {
  const { video, segments, summary } = await api('GET', `/videos/${id}`);
  const config = await api('GET', '/config');
  let clipState = await api('GET', `/videos/${id}/clips`).catch(() => null);
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
      config.youtube
        ? h(
            'button',
            {
              class: 'btn secondary small',
              type: 'button',
              title: 'Remplace titre, chaîne, date de publication et miniature par ceux de YouTube',
              onclick: async () => {
                if (!confirm('Remplacer titre, chaîne et date de publication par ceux de YouTube ?')) return;
                try {
                  const v = await api('POST', `/videos/${id}/refresh-meta`, {});
                  f.title.value = v.title;
                  f.channel.value = v.channel;
                  f.date.value = v.published_at?.slice(0, 10) ?? '';
                  status(infoMsg, 'Mis à jour depuis YouTube', 'ok');
                } catch (e) {
                  status(infoMsg, e.message, 'err');
                }
              },
            },
            'Mettre à jour depuis YouTube',
          )
        : null,
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
        h('div', { class: 'textcell' }, ta, s.text_original ? h('div', { class: 'orig', title: 'Texte d’origine avant traduction' }, s.text_original) : null),
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
            segs.splice(i + 1, 0, { start_ms: newStart, duration_ms: null, text: right, text_original: null, orig: '', origStart: -1 });
            markDirty();
            renderSegs();
          }),
          btn('⤵', 'Fusionner avec la suivante', () => {
            const next = segs[i + 1];
            if (!next) return;
            s.text = `${s.text.trim()} ${next.text.trim()}`;
            s.text_original = [s.text_original, next.text_original].filter(Boolean).join(' ') || null;
            s.duration_ms = null;
            segs.splice(i + 1, 1);
            markDirty();
            renderSegs();
          }),
          btn('＋', 'Insérer un segment dessous', () => {
            segs.splice(i + 1, 0, { start_ms: s.start_ms + (s.duration_ms ?? 0), duration_ms: null, text: '', text_original: null, orig: '', origStart: -1 });
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


  // --- traduction
  const trMsg = h('p', { class: 'status' });
  const translatable = Boolean(video.lang) && video.lang !== 'fr';
  const translatePanel = h(
    'section',
    { class: 'panel' },
    h(
      'details',
      { open: translatable || video.translated },
      h('summary', {}, 'Langue et traduction'),
      h(
        'p',
        { class: 'status' },
        `Langue du texte affiché : ${video.lang ?? 'inconnue'}. `,
        video.translated ? `Traduit automatiquement depuis « ${video.original_lang ?? '?'} » : le texte d’origine est conservé sous chaque segment. Sur le site, les résultats sont signalés comme traduction.` : '',
      ),
      translatable
        ? config.translate
          ? h(
              'button',
              {
                class: 'btn secondary small',
                type: 'button',
                onclick: async () => {
                  if (dirty) return status(trMsg, 'Enregistre d’abord tes modifications.', 'err');
                  if (!confirm('Le texte affiché sera remplacé par une traduction automatique en français (le texte d’origine est conservé). Continuer ?')) return;
                  status(trMsg, 'Traduction en cours… (une à deux minutes pour une longue vidéo)');
                  try {
                    await api('POST', `/videos/${id}/translate`, { lang: 'fr' });
                    route();
                  } catch (e) {
                    status(trMsg, e.message, 'err');
                  }
                },
              },
              'Traduire en français',
            )
          : h('p', { class: 'status err' }, 'OPENROUTER_API_KEY manquante : impossible de traduire automatiquement.')
        : null,
      trMsg,
    ),
  );



  // --- résumé IA (modifiable à la main)
  const sumMsg = h('p', { class: 'status' });
  const sumDate = (d) => (d ? new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '');
  const sumText = {
    edited: `Corrigé à la main le ${sumDate(summary.edited_at)} : il n’est jamais régénéré automatiquement.${summary.outdated ? ' La transcription a été modifiée depuis : relis ce résumé.' : ''}`,
    ready: `Rédigé par l’IA le ${sumDate(summary.created_at)} (modèle ${summary.model}). Il s’affiche sur le site et n’est jamais refait automatiquement.${summary.outdated ? ' La transcription a été modifiée depuis : si besoin, corrige le résumé ou clique sur « Régénérer avec l’IA ».' : ''}`,
    waiting: 'Sera rédigé automatiquement dans quelques minutes (délai après la dernière modification). Tu peux aussi l’écrire toi-même ci-dessous.',
    failed: `En échec après ${summary.attempts} tentatives : ${summary.error ?? ''} Tu peux l’écrire toi-même ci-dessous.`,
    none: 'Pas de transcription : pas de résumé.',
  }[summary.status];
  const sumArea = h('textarea', { class: 'text sum-area', rows: 14, spellcheck: 'true', 'aria-label': 'Résumé de la vidéo', value: summary.content });
  sumArea.value = summary.content;
  const saveSum = h('button', { class: 'btn small', type: 'button', disabled: true }, 'Enregistrer le résumé');
  sumArea.addEventListener('input', () => {
    saveSum.disabled = sumArea.value === summary.content;
    status(sumMsg, '');
  });
  saveSum.addEventListener('click', async () => {
    saveSum.disabled = true;
    try {
      const r = await api('PUT', `/videos/${id}/summary`, { markdown: sumArea.value });
      sumArea.value = r.markdown;
      summary.content = r.markdown;
      status(sumMsg, 'Résumé enregistré : il est affiché tel quel sur le site.', 'ok');
    } catch (e) {
      saveSum.disabled = false;
      status(sumMsg, e.message, 'err');
    }
  });
  const summaryPanel = h(
    'section',
    { class: 'panel' },
    h(
      'details',
      { open: summary.status === 'failed' || summary.status === 'edited' },
      h('summary', {}, `Résumé IA : ${{ edited: 'corrigé à la main', ready: 'prêt', waiting: 'en attente', failed: 'en échec', none: 'aucun' }[summary.status]}`),
      h('p', { class: summary.status === 'failed' ? 'status err' : 'status' }, sumText),
      summary.status === 'none'
        ? null
        : [
            h(
              'p',
              { class: 'status' },
              'Format : « ## En bref » puis du texte ; « ## [12:34] Titre » pour une section avec repère de temps cliquable ; « - » pour une puce ; **gras** pour un mot important.',
            ),
            sumArea,
            h(
              'div',
              { class: 'actions' },
              saveSum,
              h(
                'button',
                {
                  class: 'btn secondary small',
                  type: 'button',
                  onclick: async () => {
                    if (dirty) return status(sumMsg, 'Enregistre d’abord tes modifications de la transcription.', 'err');
                    if (summary.content && !confirm('Régénérer remplacera le résumé actuel (y compris tes corrections) par un nouveau résumé IA. Continuer ?')) return;
                    status(sumMsg, 'Rédaction du résumé… (environ une minute)');
                    try {
                      await api('POST', `/videos/${id}/summary`, {});
                      route();
                    } catch (e) {
                      status(sumMsg, e.message, 'err');
                    }
                  },
                },
                'Régénérer avec l’IA',
              ),
            ),
          ],
      sumMsg,
    ),
  );

  // --- clips TikTok / Reels : fichier vidéo, autorisation, extraits proposés
  const clipsPanel = h('section', { class: 'panel' });
  let clipsPreview = null; // <video> d'aperçu (pour « Voir » un extrait)
  let uploading = null; // { abort, ... } pendant un dépôt
  const mo = (bytes) => `${(bytes / 1024 / 1024).toFixed(bytes > 99 * 1024 * 1024 ? 0 : 1)} Mo`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const putChunk = (url, blob, onLoaded, signal) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && onLoaded(e.loaded);
      xhr.onload = () => {
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // réponse sans corps JSON
        }
        if (xhr.status < 300) resolve(body);
        else reject(Object.assign(new Error(xhr.status === 401 ? 'Session expirée : reconnecte-toi puis recommence.' : body.error || `Erreur ${xhr.status}`), { status: xhr.status, body }));
      };
      xhr.onerror = () => reject(Object.assign(new Error('Connexion interrompue'), { network: true }));
      xhr.onabort = () => reject(Object.assign(new Error('Dépôt annulé'), { aborted: true }));
      signal.addEventListener('abort', () => xhr.abort());
      xhr.send(blob);
    });

  /** Dépôt par morceaux : une coupure ne fait pas tout recommencer (le serveur indique où reprendre). */
  async function uploadVideoFile(file, onProgress, signal) {
    const total = file.size;
    const { chunk_bytes: step } = await api('POST', `/videos/${id}/file/start`, { size: total });
    let offset = 0;
    let retries = 0;
    while (offset < total) {
      if (signal.aborted) throw Object.assign(new Error('Dépôt annulé'), { aborted: true });
      const end = Math.min(offset + step, total);
      try {
        await putChunk(`/api/admin/videos/${id}/file/chunk?offset=${offset}&total=${total}`, file.slice(offset, end), (loaded) => onProgress(offset + loaded, total), signal);
        offset = end;
        retries = 0;
      } catch (e) {
        if (e.aborted) throw e;
        if (e.status === 409 && typeof e.body?.received === 'number') {
          offset = e.body.received; // le serveur a déjà reçu ce morceau (réponse perdue) : on repart de là
          continue;
        }
        if (e.status && e.status < 500) throw e;
        if (++retries > 6) throw new Error(`Connexion perdue pendant le dépôt (${e.message}). Relance le dépôt.`);
        await sleep(1000 * retries);
      }
      onProgress(offset, total);
    }
    return api('POST', `/videos/${id}/file/finish`, { size: total });
  }

  const clipMsg = h('p', { class: 'status' });
  function renderClips() {
    const st = clipState;
    if (!st) {
      clipsPanel.replaceChildren(h('p', { class: 'status err' }, 'Le studio de clips est indisponible.'));
      return;
    }
    const f = st.file;
    const label = f ? (st.enabled ? 'clips autorisés' : 'fichier prêt') : 'pas de fichier';
    const fileInput = h('input', { type: 'file', accept: 'video/mp4,video/quicktime,video/x-matroska,video/webm,.mp4,.mov,.mkv,.webm' });
    const progress = h('progress', { max: 100, value: 0, hidden: true });
    const progressText = h('span', { class: 'status' });
    const sendBtn = h('button', { class: 'btn small', type: 'button' }, f ? 'Remplacer la vidéo' : 'Déposer la vidéo');
    const cancelBtn = h('button', { class: 'btn secondary small', type: 'button', hidden: true }, 'Annuler');
    const guard = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    sendBtn.addEventListener('click', async () => {
      const file = fileInput.files?.[0];
      if (!file) return status(clipMsg, 'Choisis d’abord un fichier vidéo.', 'err');
      if (file.size > st.max_mb * 1024 * 1024) return status(clipMsg, `Fichier trop gros (${st.max_mb} Mo au maximum). Télécharge plutôt la vidéo en 720p.`, 'err');
      const ctrl = new AbortController();
      uploading = ctrl;
      sendBtn.disabled = true;
      fileInput.disabled = true;
      progress.hidden = false;
      cancelBtn.hidden = false;
      cancelBtn.onclick = () => ctrl.abort();
      status(clipMsg, '');
      window.addEventListener('beforeunload', guard);
      try {
        clipState = await uploadVideoFile(
          file,
          (done, total) => {
            progress.value = (done / total) * 100;
            progressText.textContent = `${Math.round((done / total) * 100)} % · ${mo(done)} / ${mo(total)}`;
          },
          ctrl.signal,
        );
        uploading = null;
        window.removeEventListener('beforeunload', guard);
        renderClips();
        status(clipMsg, 'Vidéo déposée et vérifiée.', 'ok');
      } catch (e) {
        uploading = null;
        window.removeEventListener('beforeunload', guard);
        sendBtn.disabled = false;
        fileInput.disabled = false;
        progress.hidden = true;
        cancelBtn.hidden = true;
        progressText.textContent = '';
        status(clipMsg, e.message, 'err');
      }
    });

    const fileBlock = f
      ? [
          h('p', { class: 'status' }, `${f.width && f.height ? `${f.height}p · ` : ''}${fmtDuration(Math.round(f.duration_s))} · ${mo(f.size)} · déposée le ${new Date(f.uploaded_at).toLocaleDateString('fr-FR')}${f.has_audio ? '' : ' · sans son'}`),
          f.duration_mismatch
            ? h('p', { class: 'status err' }, `Attention : ce fichier dure ${fmtDuration(Math.round(f.duration_s))} alors que la vidéo YouTube dure ${fmtDuration(f.youtube_duration_s)}. Ce n’est sans doute pas la même version : les extraits seraient décalés.`)
            : null,
          f.has_audio ? null : h('p', { class: 'status err' }, 'Ce fichier n’a pas de piste audio.'),
        ]
      : [h('p', { class: 'status' }, 'Télécharge la vidéo (de préférence en 720p) puis dépose-la ici. Elle doit être exactement la même que sur YouTube pour que les extraits tombent au bon endroit.')];

    clipsPreview = f ? h('video', { class: 'clip-preview', controls: true, preload: 'metadata', playsinline: true, src: `/api/admin/videos/${id}/file?v=${encodeURIComponent(f.uploaded_at)}` }) : null;

    const toggle = h('input', { type: 'checkbox', checked: st.enabled, disabled: !f || !st.has_text });
    toggle.addEventListener('change', async () => {
      toggle.disabled = true;
      status(clipMsg, toggle.checked ? 'Autorisation… (les extraits sont proposés au passage, environ une minute)' : '');
      try {
        const r = await api('PUT', `/videos/${id}/clips`, { enabled: toggle.checked });
        clipState = r;
        renderClips();
        status(clipMsg, r.suggestions_error ? `Clips autorisés, mais les extraits n’ont pas pu être proposés : ${r.suggestions_error}` : '', r.suggestions_error ? 'err' : '');
      } catch (e) {
        toggle.checked = !toggle.checked;
        toggle.disabled = false;
        status(clipMsg, e.message, 'err');
      }
    });

    const sg = st.suggestions;
    const suggestBtn = h('button', { class: 'btn secondary small', type: 'button', disabled: !st.llm || !st.has_text }, sg ? 'Régénérer les extraits' : 'Proposer des extraits');
    suggestBtn.addEventListener('click', async () => {
      suggestBtn.disabled = true;
      status(clipMsg, 'Recherche des meilleurs extraits… (une minute environ)');
      try {
        clipState = await api('POST', `/videos/${id}/clips/suggest`, {});
        renderClips();
        status(clipMsg, 'Extraits proposés.', 'ok');
      } catch (e) {
        suggestBtn.disabled = false;
        status(clipMsg, e.message, 'err');
      }
    });

    const cards = (sg?.clips ?? []).map((c) => {
      const seek = h('button', { class: 'btn secondary small', type: 'button' }, 'Voir');
      seek.addEventListener('click', () => {
        if (clipsPreview) {
          clipsPreview.currentTime = c.start_ms / 1000;
          clipsPreview.play().catch(() => {});
          clipsPreview.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else window.open(`https://www.youtube.com/watch?v=${video.youtube_id}&t=${Math.floor(c.start_ms / 1000)}s`, '_blank', 'noopener');
      });
      return h(
        'article',
        { class: 'clip-card' },
        h('div', { class: 'clip-top' }, h('strong', {}, `${fmtTs(c.start_ms)} → ${fmtTs(c.end_ms)}`), h('span', { class: 'badge' }, `${Math.round(c.duration_s)} s`), h('span', { class: 'badge ok', title: 'Note donnée par l’IA' }, `${c.score}/10`), seek),
        h('p', { class: 'clip-title' }, c.title),
        c.why ? h('p', { class: 'status' }, c.why) : null,
        h('details', {}, h('summary', {}, 'Texte de l’extrait'), h('p', { class: 'clip-text' }, c.text)),
      );
    });

    clipsPanel.replaceChildren(
      h(
        'details',
        { open: Boolean(f) || Boolean(sg) },
        h('summary', {}, `Clips TikTok : ${label}`),
        st.ffmpeg ? null : h('p', { class: 'status err' }, 'ffmpeg n’est pas installé sur ce serveur : le dépôt de vidéos est impossible.'),
        st.ffmpeg && !st.render_ready ? h('p', { class: 'status err' }, 'Le ffmpeg de ce serveur ne sait pas incruster de sous-titres ou encoder en H.264 : le studio ne pourra pas créer de clips (voir les journaux de démarrage).') : null,
        ...fileBlock,
        clipsPreview,
        h('div', { class: 'actions' }, fileInput),
        h('div', { class: 'actions' }, sendBtn, cancelBtn, f ? h('button', { class: 'btn secondary small', type: 'button', onclick: async () => {
          if (!confirm('Supprimer le fichier vidéo ? Les clips ne seront plus proposés au public pour cette vidéo.')) return;
          try {
            clipState = await api('DELETE', `/videos/${id}/file`);
            renderClips();
          } catch (e) {
            status(clipMsg, e.message, 'err');
          }
        } }, 'Supprimer le fichier') : null),
        progress,
        progressText,
        h('label', { class: 'switch-row' }, toggle, h('span', {}, 'Autoriser les clips pour le public')),
        h('p', { class: 'status' }, 'Les visiteurs pourront créer des TikToks à partir de cette vidéo. N’autorise que des vidéos dont tu peux diffuser des extraits.'),
        h('h3', { class: 'clips-sub' }, 'Extraits proposés par l’IA'),
        sg?.outdated ? h('p', { class: 'status err' }, 'La transcription a changé depuis : régénère les extraits.') : null,
        cards.length ? h('div', { class: 'clip-list' }, cards) : h('p', { class: 'status' }, st.llm ? 'Pas encore d’extraits.' : 'OPENROUTER_API_KEY manquante : impossible de proposer des extraits.'),
        h('div', { class: 'actions' }, suggestBtn),
        clipMsg,
      ),
    );
  }
  renderClips();

  // --- transcription locale (Whisper)
  const hasTranscript = segs.length > 0;
  const whisperPanel = h(
    'section',
    { class: 'panel' },
    h(
      'details',
      { open: !hasTranscript },
      h('summary', {}, hasTranscript ? 'Refaire la transcription (Whisper)' : 'Transcrire avec Whisper (gratuit)'),
      h(
        'p',
        { class: 'status' },
        hasTranscript
          ? 'Cette vidéo a déjà une transcription : elle ne sera pas remplacée sauf si tu ajoutes --overwrite à la commande (attention, ça écrase tes corrections).'
          : 'Whisper tourne sur ton ordinateur (il ne peut pas tourner dans ce navigateur) : il télécharge l’audio, le transcrit, puis envoie le texte ici. Dès que c’est fini, la transcription est enregistrée dans la base : elle est visible par tout le monde (recherche, résumés) sans rien d’autre à faire.',
      ),
      h(
        'ol',
        { class: 'steps' },
        h('li', {}, 'Une seule fois : récupère le dossier ', h('a', { href: SCRIPT_URL, target: '_blank', rel: 'noopener' }, 'tools/ ↗'), ' puis ', h('code', {}, 'pip install -r tools/requirements.txt'), ' (Python 3.10+).'),
        h('li', {}, 'Lance cette commande (le mot de passe de l’admin est demandé) :'),
      ),
      commandBox(whisperCommand(video.youtube_id)),
      h(
        'ol',
        { class: 'steps', start: '3' },
        h('li', {}, 'Une fois terminé, recharge cette page.'),
      ),
      h('button', { class: 'btn secondary small', type: 'button', onclick: () => route() }, 'Recharger la page'),
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
        segments: segs.map(({ start_ms, duration_ms, text, text_original }) => ({ start_ms, duration_ms, text, text_original })),
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
    h('div', { class: 'editor' }, h('aside', { class: 'side' }, playerBox, summaryPanel, clipsPanel, whisperPanel, translatePanel, tools, source, danger), list),
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
