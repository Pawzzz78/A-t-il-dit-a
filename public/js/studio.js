// Studio de clips : choix d'une interview, extraits (proposés par l'IA ou libres), sous-titres TikTok (style, police, couleurs,
// contour, position, taille), musique, cadrage, puis création du MP4 sur le serveur. Aucun innerHTML : tout est posé en nœuds.
import { BROLL, LIMITS, PRESETS, SIMILARITY_WARNING, ZOOM, groupWords, lineSimilarity, sanitizeStyle, sanitizeZoom, sourceText, suggestZoomPoints, wordNear, wordsForExtracts, zoomPlan } from './studio-core.js';
import { createPhone, el, outlineShadow, rgba } from './studio-preview.js';
import { fmtDate } from './ui.js';

const root = document.getElementById('studio');
const params = new URLSearchParams(location.search);
const SWATCHES = ['#FFFFFF', '#FFE600', '#25F4EE', '#FE2C55', '#7CFF6B', '#FF9500', '#000000'];
const PREF_KEY = 'studio.prefs.v1';

const api = async (method, path, body) => {
  const res = await fetch(`/api/studio${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}`), { status: res.status });
  return data;
};
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
const secs = (n) => {
  const r = Math.round(n * 10) / 10;
  return `${String(r).replace('.', ',')} s`;
};
/** Instant d'une vidéo : 1:23,5 (dixièmes) ou 1:23,45 (centièmes si besoin). */
const fmtT = (ms) => {
  const t = Math.max(0, Math.round(ms / 10) * 10);
  const cs = t % 1000;
  const frac = cs % 100 === 0 ? String(cs / 100) : String(cs / 10).padStart(2, '0');
  return `${Math.floor(t / 60000)}:${String(Math.floor((t % 60000) / 1000)).padStart(2, '0')},${frac}`;
};
/** « 1:23,5 », « 1:23.5 », « 83,5 » ou « 83 » -> millisecondes ; null si illisible. */
const parseT = (text) => {
  const m = /^\s*(?:(\d{1,3}):)?(\d{1,5})(?:[.,](\d{1,3}))?\s*$/.exec(String(text));
  if (!m) return null;
  return Math.round(((Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000 + Number((m[3] ?? '').padEnd(3, '0'))) / 10) * 10;
};
const loadPrefs = () => {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}');
  } catch {
    return {};
  }
};
const savePrefs = (S) => {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ style: S.style, music: S.music, voice: S.voice, layout: { fit: S.layout.fit, quality: S.layout.quality, mirror: S.layout.mirror }, step: S.step, zoom: { strength: S.zoom.strength, focus: S.zoom.focus } }));
  } catch {
    // stockage indisponible : sans importance
  }
};
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
const fail = (node, e) => {
  node.className = 'st-msg err';
  node.textContent = e.message;
};

// ---------------------------------------------------------------------------------------- liste des interviews

async function showList() {
  const { videos } = await api('GET', '/videos');
  if (!videos.length) {
    root.replaceChildren(el('section', { class: 'card st-empty' }, el('h2', {}, 'Le studio arrive bientôt'), el('p', {}, 'Aucune interview n’est encore disponible dans le studio. Reviens bientôt !')));
    return;
  }
  root.replaceChildren(
    el('section', { class: 'card st-pick' }, el('p', { class: 'eyebrow' }, 'Étape 1'), el('h2', { class: 'section-title' }, 'Choisis une interview'),
      el('div', { class: 'st-list' }, videos.map((v) =>
        el('a', { class: 'st-video', href: `/studio/?v=${v.youtube_id}` },
          v.thumbnail_url ? el('img', { src: v.thumbnail_url, alt: '', loading: 'lazy' }) : el('span', { class: 'thumb-empty', 'aria-hidden': 'true' }, '▶'),
          el('span', { class: 'st-video-info' }, el('strong', {}, v.title), el('small', {}, [fmtDate(v.published_at), v.suggestions ? `${v.suggestions} extraits proposés` : ''].filter(Boolean).join(' · '))),
        )),
      ),
    ),
    disclaimer(),
  );
}

const disclaimer = () =>
  el('p', { class: 'st-legal' }, 'Les extraits proviennent d’interviews dont les droits appartiennent à leurs auteurs. Pense à citer la source dans la description de ta vidéo (le studio te prépare le texte). Ne déforme pas le sens des propos : garde les phrases entières, et le contexte.');

// ---------------------------------------------------------------------------------------- éditeur

async function openEditor(youtubeId) {
  const [assets, detail] = await Promise.all([api('GET', '/assets'), api('GET', `/videos/${encodeURIComponent(youtubeId)}`)]);
  const fonts = assets.fonts;
  const fontIds = fonts.map((f) => f.id);
  const fontById = new Map(fonts.map((f) => [f.id, f]));
  const prefs = loadPrefs();
  const S = {
    video: detail.video,
    lines: detail.lines.map(([start_ms, end_ms, text]) => ({ start_ms, end_ms, text })),
    suggestions: detail.suggestions,
    extracts: [], // { start_ms, end_ms, title, from } : bornes en millisecondes ; `from` : début de l'extrait proposé d'origine
    step: prefs.step === 'line' ? 'line' : Number.isFinite(prefs.step) && prefs.step >= 10 && prefs.step <= 30000 ? prefs.step : 500, // pas de réglage : 'line' (limite de ligne) ou durée en ms
    style: sanitizeStyle(prefs.style, fontIds),
    music: { id: assets.music.some((m) => m.id === prefs.music?.id) ? prefs.music.id : null, volume: Number.isFinite(prefs.music?.volume) ? prefs.music.volume : 0.25 },
    voice: Number.isFinite(prefs.voice) ? prefs.voice : 1,
    layout: { fit: prefs.layout?.fit === 'crop' ? 'crop' : 'blur', cropX: 0.5, quality: prefs.layout?.quality === 'fast' ? 'fast' : 'hd', mirror: prefs.layout?.mirror === true },
    zoom: { on: false, auto: true, ...sanitizeZoom({ strength: prefs.zoom?.strength, focus: prefs.zoom?.focus }), events: [], picking: false }, // zooms : événements { t, kind } en secondes du clip
    broll: [], // images : { id, start, dur, thumb, photographer, page, alt }
    stock: { q: '', photos: [], page: 0, next: false, busy: false, error: '' },
    ticket: 0,
    edits: new Map(), // corrections de texte : début de la ligne (ms) -> { orig, text }
  };
  // corrections gardées dans le navigateur (un rechargement ne les perd pas) ; ignorées si la transcription a changé depuis
  const editsKey = `studio.edits.${S.video.youtube_id}`;
  try {
    const saved = JSON.parse(localStorage.getItem(editsKey) ?? '{}');
    for (const [start, e] of Object.entries(saved)) {
      if (S.lines.some((l) => l.start_ms === Number(start) && l.text === e.orig) && typeof e.text === 'string') S.edits.set(Number(start), { orig: e.orig, text: e.text });
    }
  } catch {
    // stockage indisponible : sans importance
  }
  const saveEdits = () => {
    try {
      localStorage.setItem(editsKey, JSON.stringify(Object.fromEntries(S.edits)));
    } catch {
      // idem
    }
  };

  // @font-face de toutes les polices (le navigateur ne télécharge que celles qui servent)
  const fontCss = fonts.map((f) => `@font-face{font-family:'ST-${f.id}';src:url('/fonts/studio/${f.file}') format('truetype');font-display:swap}`).join('');
  document.head.append(el('style', {}, fontCss));

  // --- outils sur les extraits
  const exMs = (ex) => ({ start_ms: ex.start_ms, end_ms: ex.end_ms });
  const exDur = (ex) => (ex.end_ms - ex.start_ms) / 1000;
  const totalS = () => S.extracts.reduce((n, ex) => n + exDur(ex), 0);
  /** Ligne de la transcription dite à l'instant `ms` (sinon la plus proche), pour rappeler où l'on en est. */
  const lineAround = (ms) => {
    let best = S.lines[0];
    for (const l of S.lines) {
      if (ms >= l.start_ms && ms < l.end_ms) return l;
      if (Math.abs(l.start_ms - ms) < Math.abs(best.start_ms - ms)) best = l;
    }
    return best;
  };
  const videoEndMs = () => Math.floor(S.video.duration_s * 1000);

  // --- aperçu
  let cropSlider = null; // curseur « position du cadrage » de l'onglet Cadrage, tenu à jour quand on glisse la vidéo
  const phone = createPhone({
    onMove: ({ x, y }) => setStyle({ x, y }),
    onPick: (focus) => {
      S.zoom.focus = focus;
      savePrefs(S);
      renderEffects();
    },
    onCrop: (cropX) => {
      S.layout.cropX = cropX;
      if (cropSlider) cropSlider.value = String(Math.round(cropX * 100));
    },
  });
  const pushFraming = () => phone.setFraming({ fit: S.layout.fit, cropX: S.layout.cropX, mirror: S.layout.mirror });
  /** Mots horodatés du clip, corrections de texte comprises. */
  const clipWords = () => wordsForExtracts(S.edits.size ? S.lines.map((l) => (S.edits.has(l.start_ms) ? { ...l, text: S.edits.get(l.start_ms).text } : l)) : S.lines, S.extracts.map(exMs)).words;
  function rebuildSubtitles() {
    const words = clipWords();
    phone.configure({ groups: groupWords(words, S.style), style: S.style, font: fontById.get(S.style.font) });
  }
  function applyAudio() {
    const track = assets.music.find((m) => m.id === S.music.id);
    phone.setAudio({ url: track ? `/music/${track.file}` : null, volume: S.music.volume, voice: S.voice });
  }
  async function requestPreview() {
    const mine = ++S.ticket;
    if (!S.extracts.length) {
      phone.setBusy('Ajoute un extrait pour voir l’aperçu');
      return;
    }
    phone.setBusy('Préparation de l’aperçu…');
    try {
      const r = await api('POST', '/preview', { youtube_id: S.video.youtube_id, extracts: S.extracts.map(exMs), layout: S.layout });
      if (mine !== S.ticket) return;
      phone.setBusy(null);
      phone.setSource(r.url);
    } catch (e) {
      if (mine === S.ticket) phone.setBusy(e.message);
    }
  }
  const schedulePreview = debounce(requestPreview, 450);

  function setStyle(patch) {
    S.style = sanitizeStyle({ ...S.style, ...patch }, fontIds);
    savePrefs(S);
    rebuildSubtitles();
    syncStyleControls();
  }

  // ============================================================ onglet Extraits
  const panelExtracts = el('div', { class: 'st-panel' });
  const minTotalNote = () => `${secs(totalS())} sur ${LIMITS.maxTotalS} s maximum`;

  function addExtract(start_ms, end_ms, title, from) {
    if (S.extracts.length >= LIMITS.maxExtracts) return alertNote(`${LIMITS.maxExtracts} extraits au maximum.`);
    const ex = { start_ms, end_ms: Math.min(end_ms, videoEndMs()), title, from };
    if (totalS() + exDur(ex) > LIMITS.maxTotalS) return alertNote(`Le clip ne peut pas dépasser ${LIMITS.maxTotalS} secondes.`);
    S.extracts.push(ex);
    extractsChanged();
  }
  function extractsChanged() {
    rebuildSubtitles();
    keepEffectsInClip();
    renderExtracts();
    renderTextEditor();
    schedulePreview();
    renderCreateSummary();
  }
  const note = el('p', { class: 'st-msg' });
  const alertNote = (msg) => {
    note.className = 'st-msg err';
    note.textContent = msg;
    setTimeout(() => (note.textContent = ''), 4000);
  };

  /**
   * Règle une borne de l'extrait (`which` : 'start_ms' ou 'end_ms') sur l'instant `ms`, au centième de seconde. Refuse un clip trop
   * court, trop long ou hors de la vidéo, en le disant.
   */
  function setEdge(ex, which, ms) {
    const next = { ...ex, [which]: Math.round(ms / 10) * 10 };
    if (next.start_ms < 0 || next.end_ms > videoEndMs()) return alertNote(`L’extrait doit rester entre 0:00 et ${fmtT(videoEndMs())}.`);
    if (exDur(next) < LIMITS.minExtractS) return alertNote(`Un extrait doit durer au moins ${LIMITS.minExtractS} secondes.`);
    if (totalS() - exDur(ex) + exDur(next) > LIMITS.maxTotalS) return alertNote(`Le clip ne peut pas dépasser ${LIMITS.maxTotalS} secondes.`);
    Object.assign(ex, next);
    extractsChanged();
  }
  /** Avance (+1) ou recule (-1) une borne d'un pas : une durée, ou jusqu'à la limite de ligne suivante / précédente. */
  function nudge(ex, which, dir) {
    const cur = ex[which];
    if (S.step === 'line') {
      const key = which === 'start_ms' ? 'start_ms' : 'end_ms';
      const marks = S.lines.map((l) => l[key]);
      const target = dir > 0 ? marks.find((t) => t > cur + 20) : [...marks].reverse().find((t) => t < cur - 20);
      return target == null ? alertNote('Il n’y a pas de ligne plus loin.') : setEdge(ex, which, target);
    }
    setEdge(ex, which, cur + dir * S.step);
  }
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= S.extracts.length) return;
    [S.extracts[i], S.extracts[j]] = [S.extracts[j], S.extracts[i]];
    extractsChanged();
  };
  const excerpt = (t, n = 70) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

  let focusKey = '';
  function extractRow(ex, i) {
    const btn = (label, title, fn, disabled, key) => el('button', { class: 'st-mini', type: 'button', title, 'aria-label': title, disabled, 'data-k': key, onclick: fn }, label);
    const edge = (label, which, lessTitle, moreTitle) => {
      const field = el('input', { class: 'st-time', type: 'text', inputmode: 'decimal', value: fmtT(ex[which]), 'aria-label': `${label} de l’extrait (minutes:secondes,dixièmes)`, title: 'Tu peux taper un instant : 1:23,5' });
      field.addEventListener('change', () => {
        const ms = parseT(field.value);
        if (ms == null) { field.value = fmtT(ex[which]); return alertNote('Instant illisible : écris par exemple 1:23,5 ou 83,5.'); }
        focusKey = `${i}:${which}:t`;
        setEdge(ex, which, ms);
        field.value = fmtT(ex[which]);
      });
      field.dataset.k = `${i}:${which}:t`;
      const go = (dir) => { focusKey = `${i}:${which}:${dir}`; nudge(ex, which, dir); };
      return el('div', { class: 'st-edge' },
        el('div', { class: 'st-edge-ctl' }, el('span', { class: 'st-edge-label' }, label), btn('−', lessTitle, () => go(-1), false, `${i}:${which}:-1`), field, btn('+', moreTitle, () => go(1), false, `${i}:${which}:1`)),
        el('span', { class: 'st-edge-text' }, `« ${excerpt(lineAround(ex[which]).text)} »`));
    };
    return el('li', { class: 'st-ex' },
      el('div', { class: 'st-ex-head' }, el('strong', {}, ex.title || 'Passage libre'), el('span', { class: 'badge' }, `${fmtT(ex.start_ms)} → ${fmtT(ex.end_ms)} · ${secs(exDur(ex))}`)),
      edge('Début', 'start_ms', 'Commencer plus tôt (ajoute du temps avant)', 'Commencer plus tard (retire du temps au début)'),
      edge('Fin', 'end_ms', 'Finir plus tôt (retire du temps à la fin)', 'Finir plus tard (ajoute du temps après)'),
      el('div', { class: 'st-ex-tools' }, btn('↑', 'Monter', () => move(i, -1), i === 0), btn('↓', 'Descendre', () => move(i, 1), i === S.extracts.length - 1),
        el('button', { class: 'st-link', type: 'button', onclick: () => { S.extracts.splice(i, 1); extractsChanged(); } }, 'Retirer')),
    );
  }

  /** Pas de réglage des bornes : quelques valeurs rapides, ou n'importe quelle durée (champ libre). */
  function stepBar() {
    const chips = [[100, '0,1 s'], [500, '0,5 s'], [1000, '1 s'], [2000, '2 s'], ['line', 'Ligne']];
    const custom = el('input', { class: 'st-time short', type: 'text', inputmode: 'decimal', 'aria-label': 'Autre pas, en secondes', placeholder: 'autre' });
    const group = el('div', { class: 'seg st-stepchips', role: 'group', 'aria-label': 'Pas de réglage' });
    const sync = () => {
      group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(String(S.step) === b.dataset.step)));
      custom.value = chips.some(([v]) => v === S.step) ? '' : String(S.step / 1000).replace('.', ',');
      custom.classList.toggle('on', Boolean(custom.value));
    };
    for (const [v, label] of chips) group.append(el('button', { type: 'button', 'data-step': String(v), onclick: () => { S.step = v; savePrefs(S); sync(); } }, label));
    custom.addEventListener('change', () => {
      const ms = parseT(custom.value);
      if (ms == null || ms < 10 || ms > 30000) { sync(); return alertNote('Pas libre : entre 0,01 et 30 secondes (par exemple 0,3).'); }
      S.step = ms;
      savePrefs(S);
      sync();
    });
    sync();
    return el('div', { class: 'st-stepbar' }, el('span', { class: 'st-step-label' }, 'Pas des boutons − / +'), group, el('span', { class: 'st-step-custom' }, custom, el('small', {}, 's')));
  }

  const search = el('input', { type: 'search', class: 'st-search', placeholder: 'Chercher un mot dans la transcription…', 'aria-label': 'Chercher dans la transcription' });
  const lineList = el('ul', { class: 'st-lines' });
  let shown = 60;
  function renderLines() {
    const q = search.value.trim().toLowerCase();
    const matches = S.lines.map((l, i) => ({ l, i })).filter(({ l }) => !q || l.text.toLowerCase().includes(q));
    lineList.replaceChildren(
      ...matches.slice(0, shown).map(({ l, i }) =>
        el('li', {}, el('button', { type: 'button', onclick: () => startFree(i) }, el('span', { class: 'st-t' }, mmss(l.start_ms)), el('span', {}, l.text))),
      ),
      matches.length > shown ? el('li', {}, el('button', { type: 'button', class: 'st-more', onclick: () => { shown += 60; renderLines(); } }, `Afficher plus (${matches.length - shown} lignes)`)) : null,
      !matches.length ? el('li', { class: 'st-none' }, 'Aucune ligne ne correspond.') : null,
    );
  }
  search.addEventListener('input', debounce(() => { shown = 60; renderLines(); }, 200));
  function startFree(i) {
    let b = i;
    while (b + 1 < S.lines.length && (S.lines[b].end_ms - S.lines[i].start_ms) / 1000 < 25) b++;
    addExtract(S.lines[i].start_ms, S.lines[b].end_ms, null);
  }

  let suggShown = 6; // extraits proposés affichés d'emblée (les mieux notés d'abord) ; le reste sur demande
  function renderExtracts() {
    const taken = new Set(S.extracts.map((e) => e.from).filter((v) => v != null));
    panelExtracts.replaceChildren(
      el('h3', {}, 'Mon clip'),
      S.extracts.length ? stepBar() : null,
      S.extracts.length ? el('ol', { class: 'st-exlist' }, S.extracts.map(extractRow)) : el('p', { class: 'st-help' }, 'Ajoute un extrait ci-dessous : l’aperçu apparaît à gauche.'),
      el('p', { class: totalS() > LIMITS.maxTotalS ? 'st-total err' : 'st-total' }, S.extracts.length ? `Durée : ${minTotalNote()}` : ''),
      note,
      el('h3', {}, S.suggestions.length ? `Extraits proposés par l’IA (${S.suggestions.length}, du plus au moins viral)` : 'Extraits proposés par l’IA'),
      S.suggestions.length
        ? el('ul', { class: 'st-sugg' }, S.suggestions.slice(0, suggShown).map((sg) =>
            el('li', { class: 'st-card' },
              el('div', { class: 'st-card-head' }, el('strong', {}, sg.title), el('span', { class: 'badge ok', title: 'Potentiel viral estimé par l’IA' }, `${sg.score}/10`)),
              el('p', { class: 'st-why' }, sg.why),
              el('p', { class: 'st-meta' }, `${mmss(sg.start_ms)} → ${mmss(sg.end_ms)} · ${secs(sg.duration_s)}`),
              el('details', {}, el('summary', {}, 'Lire l’extrait'), el('p', { class: 'st-text' }, sg.text)),
              taken.has(sg.start_ms)
                ? el('button', { class: 'btn secondary small', type: 'button', onclick: () => { const k = S.extracts.findIndex((e) => e.from === sg.start_ms); if (k >= 0) { S.extracts.splice(k, 1); extractsChanged(); } } }, 'Retirer de mon clip')
                : el('button', { class: 'btn small', type: 'button', onclick: () => addExtract(sg.start_ms, sg.end_ms, sg.title, sg.start_ms) }, 'Ajouter à mon clip'),
            )),
          )
        : el('p', { class: 'st-help' }, 'Pas d’extrait proposé pour cette vidéo : choisis un passage dans la transcription.'),
      ...(S.suggestions.length > suggShown ? [el('button', { class: 'btn secondary small', type: 'button', onclick: () => { suggShown += 8; renderExtracts(); } }, `Voir ${Math.min(8, S.suggestions.length - suggShown)} extrait${S.suggestions.length - suggShown > 1 ? 's' : ''} de plus (${S.suggestions.length - suggShown} restant${S.suggestions.length - suggShown > 1 ? 's' : ''})`)] : []),
      el('h3', {}, 'Choisir un autre passage'),
      el('p', { class: 'st-help' }, 'Touche une ligne : l’extrait démarre là (environ 25 s), puis ajuste le début et la fin au dixième de seconde (ou tape l’instant exact).'),
      search,
      lineList,
    );
    renderLines();
    if (focusKey) {
      panelExtracts.querySelector(`[data-k="${focusKey}"]`)?.focus({ preventScroll: true });
      focusKey = '';
    }
  }

  // ============================================================ onglet Sous-titres
  const ctl = {}; // références des contrôles, pour les resynchroniser
  const row = (label, ...nodes) => el('div', { class: 'st-row' }, el('label', {}, label), el('div', { class: 'st-row-ctl' }, ...nodes));
  const slider = (key, min, max, step, fmtVal) => {
    const out = el('output', {}, '');
    const input = el('input', { type: 'range', min, max, step, 'aria-label': key });
    input.addEventListener('input', () => setStyle({ [key]: Number(input.value) }));
    ctl[key] = { input, out, fmtVal };
    return [input, out];
  };
  const colorInput = (key) => {
    const input = el('input', { type: 'color', 'aria-label': `Couleur ${key}` });
    input.addEventListener('input', () => setStyle({ [key]: input.value.toUpperCase() }));
    const sw = el('span', { class: 'st-swatches' }, SWATCHES.map((c) => el('button', { type: 'button', class: 'st-sw', style: { background: c }, title: c, 'aria-label': c, onclick: () => setStyle({ [key]: c }) })));
    ctl[key] = { input };
    return [input, sw];
  };
  const toggle = (key, label, toPatch = (checked) => ({ [key]: checked })) => {
    const input = el('input', { type: 'checkbox' });
    input.addEventListener('change', () => setStyle(toPatch(input.checked)));
    ctl[key] = { input };
    return el('label', { class: 'st-check' }, input, label);
  };

  const presetGrid = el('div', { class: 'st-presets' });
  function renderPresets() {
    presetGrid.replaceChildren(...Object.entries(PRESETS).map(([id, p]) => {
      const st = sanitizeStyle({ preset: id }, fontIds);
      const sample = el('span', { class: 'st-sample' }, st.uppercase ? 'LES MOTS' : 'Les mots');
      sample.style.fontFamily = `'ST-${st.font}', sans-serif`;
      sample.style.color = st.color;
      sample.style.fontSize = `${Math.min(30, st.size * 0.28)}px`;
      sample.style.textShadow = st.box ? 'none' : outlineShadow(Math.min(3, st.outline * 0.28), st.outlineColor, 0, 1);
      if (st.box) { sample.style.background = rgba(st.boxColor, st.boxOpacity); sample.style.padding = '.1em .35em'; sample.style.borderRadius = `${st.boxRadius * 0.7}em`; }
      if (st.mode === 'words' || st.mode === 'karaoke') sample.append(el('span', { class: 'st-sample-hl', style: { color: st.highlight } }, ' ici'));
      const b = el('button', { type: 'button', class: 'st-preset', 'data-preset': id, onclick: () => { S.style = sanitizeStyle({ preset: id, x: S.style.x }, fontIds); savePrefs(S); rebuildSubtitles(); syncStyleControls(); } },
        el('span', { class: 'st-sample-box' }, sample), el('strong', {}, p.label), el('small', {}, p.hint));
      return b;
    }));
  }
  const fontGrid = el('div', { class: 'st-fonts', role: 'listbox', 'aria-label': 'Police' });
  function renderFonts() {
    const cats = [...new Set(fonts.map((f) => f.category))];
    fontGrid.replaceChildren(...cats.flatMap((c) => [el('p', { class: 'st-cat' }, c), el('div', { class: 'st-font-row' }, fonts.filter((f) => f.category === c).map((f) => {
      const b = el('button', { type: 'button', class: 'st-font', role: 'option', 'data-font': f.id, onclick: () => setStyle({ font: f.id }) }, el('span', { style: { fontFamily: `'ST-${f.id}', sans-serif` } }, 'Lisnard'), el('small', {}, f.label));
      return b;
    }))]));
  }
  const panelStyle = el('div', { class: 'st-panel' });
  const lookWrap = el('div', {});
  const textWrap = el('div', { hidden: true });
  const subNav = el('div', { class: 'seg st-subnav', role: 'group', 'aria-label': 'Sous-titres' });
  const openSub = (which) => {
    textWrap.hidden = which !== 'text';
    lookWrap.hidden = which !== 'look';
    subNav.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sub === which)));
    if (which === 'text') renderTextEditor();
  };
  for (const [which, label] of [['look', 'Apparence'], ['text', 'Texte']]) subNav.append(el('button', { type: 'button', 'data-sub': which, onclick: () => openSub(which) }, label));
  const boxRows = el('div', { class: 'st-sub' });
  const posButtons = el('div', { class: 'st-pos' }, [['Haut', 0.3], ['Milieu', 0.5], ['Bas', 0.68]].map(([label, y]) => el('button', { type: 'button', class: 'st-mini wide', onclick: () => setStyle({ y }) }, label)), el('button', { type: 'button', class: 'st-mini wide', onclick: () => setStyle({ x: 0.5 }) }, 'Centrer'));
  const rowHl = row('Couleur du mot actif', ...colorInput('highlight'));
  const rowShadow = row('Ombre', ...slider('shadow', 0, 12, 0.5, (v) => (v ? `${v}` : 'aucune')));
  const rowGroup = row('Mots affichés à la fois', ...slider('wordsPerGroup', 1, 8, 1, (v) => `${v}`));
  lookWrap.append(
    el('h3', {}, 'Style'), presetGrid,
    el('h3', {}, 'Police'), fontGrid,
    el('h3', {}, 'Texte'),
    row('Taille', ...slider('size', 30, 220, 1, (v) => `${v}`)),
    row('Couleur du texte', ...colorInput('color')), rowHl,
    toggle('uppercase', 'Majuscules'), rowGroup,
    el('h3', {}, 'Contour et fond'),
    row('Épaisseur du contour', ...slider('outline', 0, 24, 0.5, (v) => (v ? `${v}` : 'aucun'))),
    row('Couleur du contour', ...colorInput('outlineColor')), rowShadow,
    toggle('box', 'Fond sombre derrière le texte'),
    boxRows,
    el('h3', {}, 'Position et animation'),
    row('Largeur du texte', ...slider('maxWidth', 0.4, 0.96, 0.02, (v) => `${Math.round(v * 100)} %`)),
    row('Position verticale', ...slider('y', 0.1, 0.9, 0.01, (v) => `${Math.round(v * 100)} %`)),
    el('p', { class: 'st-help' }, 'Tu peux aussi glisser les sous-titres directement sur l’aperçu avec le doigt ou la souris.'),
    posButtons,
    toggle('animation_pop', 'Petit « pop » à l’apparition de chaque groupe', (checked) => ({ animation: checked ? 'pop' : 'none' })),
  );
  boxRows.append(row('Couleur du fond', ...colorInput('boxColor')), row('Opacité du fond', ...slider('boxOpacity', 0, 1, 0.02, (v) => `${Math.round(v * 100)} %`)),
    row('Arrondi du fond', ...slider('boxRadius', 0, 1, 0.05, (v) => (v ? `${Math.round(v * 100)} %` : 'angles droits'))));

  function syncStyleControls() {
    const s = S.style;
    for (const [key, c] of Object.entries(ctl)) {
      if (key === 'animation_pop') c.input.checked = s.animation === 'pop';
      else if (c.input.type === 'checkbox') c.input.checked = Boolean(s[key]);
      else if (c.input.type === 'color') c.input.value = s[key].toLowerCase();
      else {
        c.input.value = String(s[key]);
        if (c.out) c.out.textContent = c.fmtVal(s[key]);
      }
    }
    presetGrid.querySelectorAll('.st-preset').forEach((b) => b.classList.toggle('on', b.dataset.preset === s.preset));
    fontGrid.querySelectorAll('.st-font').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.font === s.font)));
    rowHl.hidden = !(s.mode === 'words' || s.mode === 'karaoke');
    rowGroup.hidden = s.mode === 'one';
    rowShadow.hidden = s.box;
    boxRows.hidden = !s.box;
    ctl.outline.input.closest('.st-row').hidden = s.box;
    ctl.outlineColor.input.closest('.st-row').hidden = s.box;
  }

  // --- texte des sous-titres : on corrige les mots, la ligne garde son horodatage d'origine
  const clipLines = () => {
    const rows = [];
    let offset = 0;
    S.extracts.forEach((ex, k) => {
      for (const l of S.lines) if (l.end_ms > ex.start_ms && l.start_ms < ex.end_ms) rows.push({ k, line: l, at: offset + Math.max(0, (l.start_ms - ex.start_ms) / 1000) });
      offset += exDur(ex);
    });
    return rows;
  };
  const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const editedInClip = () => clipLines().filter((r) => S.edits.has(r.line.start_ms)).length;

  const fitAreas = () => textWrap.querySelectorAll('textarea').forEach((a) => { a.style.height = 'auto'; a.style.height = `${a.scrollHeight}px`; });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => !textWrap.hidden && fitAreas()).observe(textWrap); // largeur modifiée, onglet ouvert

  function renderTextEditor() {
    if (!textWrap || textWrap.hidden) return;
    const rows = clipLines();
    const summary = el('p', { class: 'st-help' });
    const refreshSummary = () => {
      const n = editedInClip();
      summary.textContent = n ? `${n} ligne${n > 1 ? 's' : ''} corrigée${n > 1 ? 's' : ''}.` : 'Corrige les mots mal reconnus : chaque ligne garde son horodatage, les mots sont répartis sur la même durée.';
    };
    const resetAll = el('button', { type: 'button', class: 'st-link', onclick: () => { for (const r of rows) S.edits.delete(r.line.start_ms); saveEdits(); rebuildSubtitles(); renderTextEditor(); renderCreateSummary(); } }, 'Tout rétablir');
    let lastK = -1;
    const items = rows.flatMap(({ k, line, at }) => {
      const original = line.text;
      const area = el('textarea', { class: 'st-line-text', rows: '1', spellcheck: 'true', lang: 'fr', 'aria-label': `Sous-titre de ${clock(at)}`, maxlength: '500' });
      area.value = S.edits.get(line.start_ms)?.text ?? original;
      const badge = el('span', { class: 'st-badge' }, 'corrigé');
      const warn = el('p', { class: 'st-line-warn' });
      const undo = el('button', { type: 'button', class: 'st-link', title: 'Rétablir le texte de la transcription' }, 'Rétablir');
      const li = el('li', { class: 'st-line' });
      const fit = () => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; };
      const refresh = () => {
        const edited = S.edits.has(line.start_ms);
        const text = area.value.trim();
        li.classList.toggle('edited', edited);
        badge.hidden = undo.hidden = !edited;
        const far = edited && text && lineSimilarity(original, text) < SIMILARITY_WARNING;
        warn.hidden = !(far || (edited && !text));
        warn.textContent = !text ? 'Aucun sous-titre ne sera affiché pour cette ligne.' : '⚠ Ce texte s’écarte beaucoup de la transcription : vérifie qu’il reste fidèle à ce qui est dit.';
        li.classList.toggle('far', Boolean(far));
        refreshSummary();
      };
      area.addEventListener('input', () => {
        if (area.value.trim() === original) S.edits.delete(line.start_ms);
        else S.edits.set(line.start_ms, { orig: original, text: area.value });
        saveEdits(); fit(); refresh(); rebuildSubtitles(); renderCreateSummary();
      });
      area.addEventListener('focus', () => phone.seek(at));
      undo.addEventListener('click', () => { S.edits.delete(line.start_ms); area.value = original; saveEdits(); fit(); refresh(); rebuildSubtitles(); renderCreateSummary(); });
      li.append(
        el('button', { type: 'button', class: 'st-seek', title: 'Écouter cette ligne', onclick: () => phone.seek(at, true) }, `▶ ${clock(at)}`),
        el('div', { class: 'st-line-body' }, area, el('div', { class: 'st-line-meta' }, badge, undo), warn),
      );
      refresh();
      requestAnimationFrame(fit);
      const head = k !== lastK && S.extracts.length > 1 ? el('li', { class: 'st-line-head' }, `Extrait ${k + 1} · ${S.extracts[k].title || 'Passage libre'}`) : null;
      lastK = k;
      return head ? [head, li] : [li];
    });
    textWrap.replaceChildren(
      el('h3', {}, 'Texte des sous-titres'),
      summary,
      ...(S.edits.size ? [resetAll] : []),
      rows.length ? el('ul', { class: 'st-line-list' }, items) : el('p', { class: 'st-help' }, 'Ajoute d’abord un extrait pour corriger ses sous-titres.'),
    );
  }

  // ============================================================ onglet Musique
  const panelMusic = el('div', { class: 'st-panel' });
  const audition = new Audio();
  let auditionId = null;
  audition.addEventListener('ended', () => { auditionId = null; renderMusic(); });
  function renderMusic() {
    const pick = (id) => { S.music.id = id; savePrefs(S); applyAudio(); renderMusic(); };
    const track = (m) => el('li', { class: m.id === S.music.id ? 'st-track on' : 'st-track' },
      el('button', { type: 'button', class: 'st-playtrack', 'aria-label': auditionId === m.id ? `Arrêter ${m.title}` : `Écouter ${m.title}`, onclick: () => {
        if (auditionId === m.id) { audition.pause(); auditionId = null; } else { phone.pause(); audition.src = `/music/${m.file}`; audition.volume = 0.6; audition.play().catch(() => {}); auditionId = m.id; }
        renderMusic();
      } }, auditionId === m.id ? '■' : '▶'),
      el('button', { type: 'button', class: 'st-trackname', onclick: () => pick(m.id) }, el('strong', {}, m.title), el('small', {}, `${m.mood} · ${m.bpm} bpm`)),
      m.id === S.music.id ? el('span', { class: 'badge ok' }, 'choisie') : null);
    const vol = (label, key, min, max, get, set) => {
      const out = el('output', {}, `${Math.round(get() * 100)} %`);
      const input = el('input', { type: 'range', min, max, step: '1', value: String(Math.round(get() * 100)), 'aria-label': label });
      input.addEventListener('input', () => { set(Number(input.value) / 100); out.textContent = `${input.value} %`; savePrefs(S); applyAudio(); });
      return el('div', { class: 'st-row' }, el('label', {}, label), el('div', { class: 'st-row-ctl' }, input, out));
    };
    panelMusic.replaceChildren(
      el('h3', {}, 'Musique de fond'),
      el('p', { class: 'st-help' }, 'Morceaux originaux, libres de droits, joués en boucle sous la voix.'),
      el('ul', { class: 'st-tracks' }, el('li', { class: S.music.id ? 'st-track' : 'st-track on' }, el('button', { type: 'button', class: 'st-trackname', onclick: () => pick(null) }, el('strong', {}, 'Aucune musique'), el('small', {}, 'Seulement la voix')), S.music.id ? null : el('span', { class: 'badge ok' }, 'choisie')), assets.music.map(track)),
      el('h3', {}, 'Volumes'),
      vol('Musique', 'music', 0, 100, () => S.music.volume, (v) => { S.music.volume = v; }),
      vol('Voix', 'voice', 0, 150, () => S.voice, (v) => { S.voice = v; }),
      el('p', { class: 'st-help' }, 'Dans l’aperçu, le volume de la voix ne dépasse pas 100 % ; la vidéo finale applique bien le réglage.'),
    );
  }

  // ============================================================ onglet Cadrage
  const panelFrame = el('div', { class: 'st-panel' });
  function renderFrame() {
    const opt = (value, title, text) => el('label', { class: S.layout.fit === value ? 'st-opt on' : 'st-opt' },
      el('input', { type: 'radio', name: 'fit', value, checked: S.layout.fit === value, onchange: () => { S.layout.fit = value; savePrefs(S); pushFraming(); renderFrame(); schedulePreview(); renderCreateSummary(); } }),
      el('strong', {}, title), el('small', {}, text));
    cropSlider = el('input', { type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(S.layout.cropX * 100)), 'aria-label': 'Position horizontale du cadrage' });
    cropSlider.addEventListener('input', () => { S.layout.cropX = Number(cropSlider.value) / 100; pushFraming(); });
    const mirror = el('input', { type: 'checkbox', checked: S.layout.mirror });
    mirror.addEventListener('change', () => { S.layout.mirror = mirror.checked; savePrefs(S); pushFraming(); renderCreateSummary(); });
    panelFrame.replaceChildren(
      el('h3', {}, 'Cadrage de la vidéo'),
      el('div', { class: 'st-opts' }, opt('blur', 'Vidéo entière', 'Sur un fond flou fait avec la vidéo'), opt('crop', 'Plein écran', 'La vidéo est recadrée pour remplir l’écran')),
      S.layout.fit === 'crop'
        ? el('div', { class: 'st-sub-block' },
            el('p', { class: 'st-help' }, 'Glisse la vidéo vers la gauche ou la droite sur l’aperçu pour recentrer le cadrage sur la personne. Le curseur permet de régler plus finement.'),
            el('div', { class: 'st-row' }, el('label', {}, 'Position du cadrage'), el('div', { class: 'st-row-ctl' }, el('span', { class: 'st-end' }, 'gauche'), cropSlider, el('span', { class: 'st-end' }, 'droite'))),
            el('button', { type: 'button', class: 'st-mini wide', onclick: () => { S.layout.cropX = 0.5; cropSlider.value = '50'; pushFraming(); } }, 'Recentrer'))
        : null,
      el('h3', {}, 'Miroir'),
      el('label', { class: 'st-check' }, mirror, 'Retourner l’image horizontalement (miroir)'),
      el('p', { class: 'st-help' }, 'L’image est retournée gauche-droite ; les sous-titres ne le sont jamais. Attention : les textes visibles dans l’image (panneaux, logos, bandeaux de chaîne) apparaîtront à l’envers. Le miroir ne change pas les droits sur la vidéo d’origine.'),
    );
  }

  // ============================================================ onglet Créer
  const panelCreate = el('div', { class: 'st-panel' });
  const createSummary = el('div', {});
  const pledge = el('input', { type: 'checkbox' });
  const makeBtn = el('button', { class: 'btn', type: 'button' }, 'Créer la vidéo');
  const sourceField = el('textarea', { class: 'st-source-text', readonly: '', rows: '2', 'aria-label': 'Source à citer dans la description' });
  sourceField.value = `${sourceText(S.video.title, S.video.published_at)} — https://www.youtube.com/watch?v=${S.video.youtube_id}`;
  const copyBtn = el('button', { class: 'btn secondary small', type: 'button' }, 'Copier');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(sourceField.value);
    } catch {
      sourceField.select();
      document.execCommand?.('copy');
    }
    copyBtn.textContent = 'Copié ✓';
    setTimeout(() => (copyBtn.textContent = 'Copier'), 2000);
  });
  const sourceBox = el('div', { class: 'st-source' }, sourceField, copyBtn);
  const makeMsg = el('p', { class: 'st-msg' });
  const jobBox = el('div', { class: 'st-job' });
  let job = null;
  let polling = 0;

  function renderCreateSummary() {
    const track = assets.music.find((m) => m.id === S.music.id);
    createSummary.replaceChildren(el('ul', { class: 'st-sum' },
      el('li', {}, el('strong', {}, 'Durée : '), S.extracts.length ? `${secs(totalS())} (${S.extracts.length} extrait${S.extracts.length > 1 ? 's' : ''})` : 'aucun extrait choisi'),
      el('li', {}, el('strong', {}, 'Sous-titres : '), `${PRESETS[S.style.preset].label}, ${fontById.get(S.style.font).label}`),
      el('li', {}, el('strong', {}, 'Musique : '), track ? track.title : 'aucune'),
      ...(editedInClip() ? [el('li', {}, el('strong', {}, 'Texte : '), `${editedInClip()} ligne${editedInClip() > 1 ? 's' : ''} de sous-titres corrigée${editedInClip() > 1 ? 's' : ''}`)] : []),
      ...(S.zoom.on && S.zoom.events.some((e) => e.kind === 'in') || S.broll.length ? [el('li', {}, el('strong', {}, 'B-roll : '), [S.zoom.on && S.zoom.events.some((e) => e.kind === 'in') ? `${S.zoom.events.filter((e) => e.kind === 'in').length} zoom${S.zoom.events.filter((e) => e.kind === 'in').length > 1 ? 's' : ''}` : '', S.broll.length ? `${S.broll.length} image${S.broll.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(', '))] : []),
      el('li', {}, el('strong', {}, 'Cadrage : '), `${S.layout.fit === 'blur' ? 'vidéo entière sur fond flou' : 'plein écran'}${S.layout.mirror ? ', en miroir' : ''}`)));
    makeBtn.disabled = !S.extracts.length || !pledge.checked || Boolean(job && ['queued', 'running'].includes(job.status));
  }
  const quality = (value, title, text) => el('label', { class: S.layout.quality === value ? 'st-opt on' : 'st-opt' },
    el('input', { type: 'radio', name: 'quality', value, checked: S.layout.quality === value, onchange: () => { S.layout.quality = value; savePrefs(S); renderCreate(); } }),
    el('strong', {}, title), el('small', {}, text));
  function renderCreate() {
    panelCreate.replaceChildren(
      el('h3', {}, 'Ton clip'), createSummary,
      el('h3', {}, 'Source à citer'),
      el('p', { class: 'st-help' }, 'La vidéo n’affiche pas la source : colle ce texte dans la description de ta publication.'),
      sourceBox,
      el('h3', {}, 'Qualité'),
      el('div', { class: 'st-opts' }, quality('hd', 'HD 1080 × 1920', 'Meilleure qualité, un peu plus long à créer'), quality('fast', 'Rapide 720 × 1280', 'Création plus rapide, fichier plus léger')),
      el('label', { class: 'st-check pledge' }, pledge, 'Je m’engage à ne pas déformer le sens des propos de cette interview, y compris dans les sous-titres que j’ai corrigés.'),
      makeBtn, makeMsg, jobBox,
      el('p', { class: 'st-help' }, 'Ta vidéo est conservée une heure sur le serveur : télécharge-la dès qu’elle est prête.'),
    );
    renderCreateSummary();
  }
  pledge.addEventListener('change', renderCreateSummary);

  function showJob() {
    if (!job) { jobBox.replaceChildren(); return; }
    if (job.status === 'queued' || job.status === 'running') {
      const pct = Math.round(job.progress * 100);
      jobBox.replaceChildren(
        el('p', { class: 'st-job-text' }, job.status === 'queued' ? `En attente… (${job.position}${job.position > 1 ? 'e' : 'er'} dans la file)` : `Création de la vidéo… ${pct} %`),
        el('progress', { max: '100', value: String(job.status === 'queued' ? 0 : pct) }),
        el('button', { class: 'btn secondary small', type: 'button', onclick: async () => { try { await api('DELETE', `/render/${job.id}`); } catch { /* déjà terminé */ } } }, 'Annuler'));
    } else if (job.status === 'done') {
      const url = `/api/studio/render/${job.id}/file`;
      const share = el('button', { class: 'btn secondary small', type: 'button' }, 'Partager');
      share.addEventListener('click', async () => {
        try {
          const blob = await (await fetch(`${url}?use=share`)).blob();
          const file = new File([blob], job.filename, { type: 'video/mp4' });
          if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Lisnard Facts' });
          else { makeMsg.className = 'st-msg'; makeMsg.textContent = 'Le partage direct n’est pas disponible ici : télécharge la vidéo.'; }
        } catch { /* partage annulé */ }
      });
      jobBox.replaceChildren(
        el('p', { class: 'st-job-text ok' }, 'Ta vidéo est prête !'),
        el('video', { class: 'st-result', src: url, controls: true, playsinline: '', preload: 'metadata' }),
        el('div', { class: 'st-job-actions' }, el('a', { class: 'btn', href: `${url}?use=download`, download: job.filename }, 'Télécharger'), navigator.canShare ? share : null,
          el('button', { class: 'btn secondary small', type: 'button', onclick: () => { job = null; showJob(); renderCreateSummary(); } }, 'Faire un autre clip')),
        el('p', { class: 'st-help' }, 'N’oublie pas de citer la source dans la description (texte à copier dans l’onglet Créer).'));
    } else if (job.status === 'cancelled') {
      jobBox.replaceChildren(el('p', { class: 'st-job-text' }, 'Création annulée.'));
    } else {
      jobBox.replaceChildren(el('p', { class: 'st-job-text err' }, job.error || 'La création a échoué.'));
    }
    renderCreateSummary();
  }
  async function poll() {
    clearTimeout(polling);
    if (!job || !['queued', 'running'].includes(job.status)) return;
    try {
      job = await api('GET', `/render/${job.id}`);
    } catch (e) {
      job = { status: 'error', error: e.message };
    }
    showJob();
    polling = setTimeout(poll, 900);
  }
  makeBtn.addEventListener('click', async () => {
    makeMsg.textContent = '';
    makeBtn.disabled = true;
    try {
      job = await api('POST', '/render', {
        youtube_id: S.video.youtube_id,
        extracts: S.extracts.map(exMs),
        layout: S.layout,
        style: S.style,
        music: S.music.id ? S.music : null,
        voice: S.voice,
        zoom: S.zoom.on && S.zoom.events.length ? { strength: S.zoom.strength, focus: S.zoom.focus, events: S.zoom.events } : null,
        broll: S.broll.map(({ id, start, dur }) => ({ id, start, dur })),
        edits: Object.fromEntries(clipLines().filter((r) => S.edits.has(r.line.start_ms)).map((r) => [r.line.start_ms, S.edits.get(r.line.start_ms).text])),
      });
      showJob();
      poll();
    } catch (e) {
      fail(makeMsg, e);
      renderCreateSummary();
    }
  });

  // ============================================================ onglet B-roll (zooms et images)
  const panelFx = el('div', { class: 'st-panel' });
  const fxNote = el('p', { class: 'st-msg' });
  const fxAlert = (msg) => {
    fxNote.className = 'st-msg err';
    fxNote.textContent = msg;
    setTimeout(() => (fxNote.textContent = ''), 4500);
  };
  const playhead = () => Math.round((phone.video.currentTime || 0) * 100) / 100;
  const tMs = (t) => Math.round(t * 1000);

  /** Envoie zooms et images à l'aperçu. */
  function pushFx() {
    phone.setEffects({
      plan: S.zoom.on ? zoomPlan(S.zoom.events, S.zoom.strength) : [],
      focus: S.zoom.focus,
      picking: S.zoom.picking,
      broll: S.broll.map((b) => ({ start: b.start, dur: b.dur, url: `/api/studio/stock/image/${b.id}` })),
    });
  }
  function effectsChanged() {
    S.zoom.events = sanitizeZoom({ ...S.zoom, events: S.zoom.events }).events;
    pushFx();
    renderEffects();
    updateSource();
    renderCreateSummary();
  }
  /** Zooms automatiques sur les mots importants du clip. */
  function autoZoom() {
    S.zoom.events = suggestZoomPoints(clipWords(), totalS()).events;
    S.zoom.auto = true;
  }
  /** Le clip a changé : les zooms automatiques sont recalculés, les réglages manuels et les images sont gardés tant qu'ils restent dans le clip. */
  function keepEffectsInClip() {
    const total = totalS();
    if (S.zoom.on && S.zoom.auto) autoZoom();
    else S.zoom.events = S.zoom.events.filter((e) => e.t <= total);
    S.broll = S.broll.filter((b) => b.start < total - 0.5).map((b) => ({ ...b, dur: Math.min(b.dur, Math.round((total - b.start) * 100) / 100) }));
    pushFx();
    renderEffects();
    updateSource();
  }
  const setZoomEvents = (events, manual = true) => {
    S.zoom.events = events;
    if (manual) S.zoom.auto = false;
    effectsChanged();
  };
  function addZoom(kind) {
    const t = Math.min(totalS() - 0.1, playhead());
    if (!S.extracts.length) return fxAlert('Ajoute d’abord un extrait.');
    if (S.zoom.events.some((e) => Math.abs(e.t - t) < ZOOM.minGap)) return fxAlert(`Trop près d’un autre zoom (${String(ZOOM.minGap).replace('.', ',')} s au minimum).`);
    if (S.zoom.events.length >= ZOOM.maxEvents) return fxAlert(`${ZOOM.maxEvents} zooms au maximum.`);
    S.zoom.on = true;
    setZoomEvents([...S.zoom.events, { t, kind }].sort((a, b) => a.t - b.t));
  }

  // --- images libres de droits
  async function searchStock(more = false) {
    const st = S.stock;
    const q = st.q.trim();
    if (q.length < 2 || st.busy) return;
    st.busy = true;
    st.error = '';
    renderEffects();
    try {
      const page = more ? st.page + 1 : 1;
      const r = await api('GET', `/stock/search?${new URLSearchParams({ q, page })}`);
      st.photos = more ? [...st.photos, ...r.photos] : r.photos;
      st.page = r.page;
      st.next = r.next;
      if (!r.photos.length && !more) st.error = 'Aucune image trouvée : essaie un autre mot.';
    } catch (e) {
      st.error = e.message;
    }
    st.busy = false;
    renderEffects();
  }
  /** Première place libre (au moins `dur` secondes) à partir de `from`. */
  function freeSlot(from, dur, ignore = null) {
    const total = totalS();
    const items = S.broll.filter((b) => b !== ignore).sort((a, b) => a.start - b.start);
    let start = Math.max(0, from);
    for (const b of items) {
      if (start + dur <= b.start + 1e-9) break;
      if (start < b.start + b.dur) start = b.start + b.dur;
    }
    return start + dur <= total + 1e-9 ? Math.round(start * 100) / 100 : null;
  }
  function addBroll(photo) {
    const total = totalS();
    if (!S.extracts.length) return fxAlert('Ajoute d’abord un extrait.');
    if (S.broll.length >= BROLL.maxItems) return fxAlert(`${BROLL.maxItems} images au maximum.`);
    const at = Math.min(playhead(), Math.max(0, total - BROLL.minS));
    const dur = Math.min(BROLL.defaultS, total - at);
    const start = freeSlot(at, dur) ?? freeSlot(0, Math.min(BROLL.defaultS, total));
    if (start == null) return fxAlert('Il n’y a plus de place pour une image dans ce clip.');
    S.broll.push({ id: photo.id, start, dur: Math.min(BROLL.defaultS, total - start), thumb: photo.thumb, photographer: photo.photographer, page: photo.page, alt: photo.alt });
    S.broll.sort((a, b) => a.start - b.start);
    effectsChanged();
    phone.seek(start);
  }
  function updateBroll(b, patch) {
    const next = { ...b, ...patch };
    const total = totalS();
    next.start = Math.round(next.start * 100) / 100;
    next.dur = Math.round(Math.min(BROLL.maxS, Math.max(BROLL.minS, next.dur)) * 100) / 100;
    if (next.start < 0 || next.start + next.dur > total + 1e-9) return fxAlert(`L’image doit rester dans le clip (${secs(total)}).`);
    if (S.broll.some((o) => o !== b && next.start < o.start + o.dur && o.start < next.start + next.dur)) return fxAlert('Deux images ne peuvent pas se chevaucher.');
    Object.assign(b, next);
    S.broll.sort((x, y) => x.start - y.start);
    effectsChanged();
  }
  /** Source à citer : l'interview, plus les photographes des images utilisées. */
  function updateSource() {
    const credits = [...new Set(S.broll.map((b) => b.photographer).filter(Boolean))];
    sourceField.value =
      `${sourceText(S.video.title, S.video.published_at)} — https://www.youtube.com/watch?v=${S.video.youtube_id}` +
      (credits.length ? `\nImages : ${credits.join(', ')} (${assets.stock?.provider ?? 'banque d’images'})` : '');
    sourceField.rows = credits.length ? 3 : 2;
  }

  const timeField = (label, ms, onSet, extra = {}) => {
    const input = el('input', { class: 'st-time', type: 'text', inputmode: 'decimal', value: fmtT(ms), 'aria-label': label, title: 'Tu peux taper un instant : 0:12,5', ...extra });
    input.addEventListener('change', () => {
      const v = parseT(input.value);
      if (v == null) { input.value = fmtT(ms); return fxAlert('Instant illisible : écris par exemple 0:12,5 ou 12,5.'); }
      onSet(v / 1000);
    });
    return input;
  };

  function renderEffects() {
    const total = totalS();
    const words = clipWords();
    const strengthChips = el('div', { class: 'seg st-stepchips', role: 'group', 'aria-label': 'Force du zoom' },
      [['light', 'Léger'], ['medium', 'Moyen'], ['strong', 'Fort']].map(([k, label]) =>
        el('button', { type: 'button', 'aria-pressed': String(S.zoom.strength === ZOOM.strengths[k]), onclick: () => { S.zoom.strength = ZOOM.strengths[k]; savePrefs(S); effectsChanged(); } }, label)));
    const zoomRows = S.zoom.events.map((e, i) =>
      el('li', { class: 'st-fxrow' },
        timeField(`Instant du zoom ${i + 1}`, tMs(e.t), (t) => {
          if (t > total) return fxAlert('Cet instant est après la fin du clip.');
          if (S.zoom.events.some((o, j) => j !== i && Math.abs(o.t - t) < ZOOM.minGap)) return fxAlert('Trop près d’un autre zoom.');
          const events = S.zoom.events.map((o, j) => (j === i ? { ...o, t } : o)).sort((a, b) => a.t - b.t);
          setZoomEvents(events);
        }),
        el('select', { class: 'st-select', 'aria-label': `Type du zoom ${i + 1}`, onchange: (ev) => setZoomEvents(S.zoom.events.map((o, j) => (j === i ? { ...o, kind: ev.target.value } : o))) },
          el('option', { value: 'in', selected: e.kind === 'in' }, 'Zoom avant'), el('option', { value: 'out', selected: e.kind === 'out' }, 'Zoom arrière')),
        el('span', { class: 'st-fxword' }, e.kind === 'in' ? wordNear(words, e.t + 0.15) : ''),
        el('button', { type: 'button', class: 'st-mini', title: 'Voir ce moment', 'aria-label': 'Voir ce moment', onclick: () => phone.seek(Math.max(0, e.t - 0.6), true) }, '▶'),
        el('button', { type: 'button', class: 'st-mini', title: 'Supprimer ce zoom', 'aria-label': 'Supprimer ce zoom', onclick: () => setZoomEvents(S.zoom.events.filter((_, j) => j !== i)) }, '×')));

    const stockOn = assets.stock?.enabled;
    const hints = suggestZoomPoints(words, total, { minSep: 0.01, max: 6 }).hints.map((h) => h.word).filter((w, i, a) => w && a.indexOf(w) === i);
    const searchInput = el('input', { type: 'search', class: 'st-search', placeholder: 'Chercher une image (ex. mairie, argent, école)…', 'aria-label': 'Chercher une image', value: S.stock.q });
    searchInput.addEventListener('input', () => { S.stock.q = searchInput.value; });
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchStock(); } });
    const brollRows = S.broll.map((b, i) =>
      el('li', { class: 'st-fxrow broll' },
        el('img', { class: 'st-bthumb', src: b.thumb, alt: b.alt || 'Image', loading: 'lazy' }),
        el('div', { class: 'st-bfields' },
          el('label', {}, 'Début', timeField(`Début de l’image ${i + 1}`, tMs(b.start), (t) => updateBroll(b, { start: t }))),
          el('label', {}, 'Durée', timeField(`Durée de l’image ${i + 1}`, tMs(b.dur), (t) => updateBroll(b, { dur: t }), { title: 'Durée en secondes : 2,5' }))),
        el('button', { type: 'button', class: 'st-mini', title: 'Voir cette image', 'aria-label': 'Voir cette image', onclick: () => phone.seek(Math.max(0, b.start - 0.4), true) }, '▶'),
        el('button', { type: 'button', class: 'st-mini', title: 'Retirer cette image', 'aria-label': 'Retirer cette image', onclick: () => { S.broll = S.broll.filter((o) => o !== b); effectsChanged(); } }, '×')));

    panelFx.replaceChildren(...[
      el('h3', {}, 'Zooms'),
      el('label', { class: 'st-check' }, el('input', { type: 'checkbox', checked: S.zoom.on, onchange: (e) => { S.zoom.on = e.target.checked; if (S.zoom.on && !S.zoom.events.length) autoZoom(); effectsChanged(); } }), 'Zooms sur les mots importants'),
      el('p', { class: 'st-help' }, 'Un zoom avant au moment d’un mot important, puis un zoom arrière. Le mouvement est lissé image par image : jamais de saccade. Les sous-titres et les images ne bougent pas.'),
      ...(S.zoom.on
        ? [
            el('div', { class: 'st-row' }, el('label', {}, 'Force'), el('div', { class: 'st-row-ctl' }, strengthChips)),
            el('div', { class: 'st-fxbar' },
              el('button', { type: 'button', class: 'btn small', onclick: () => { if (!S.extracts.length) return fxAlert('Ajoute d’abord un extrait.'); autoZoom(); effectsChanged(); } }, 'Placer automatiquement'),
              el('button', { type: 'button', class: 'btn secondary small', onclick: () => addZoom('in') }, 'Zoom avant ici'),
              el('button', { type: 'button', class: 'btn secondary small', onclick: () => addZoom('out') }, 'Zoom arrière ici')),
            el('p', { class: 'st-help' }, '« Ici » = l’instant où se trouve l’aperçu : mets l’aperçu en pause au bon endroit (curseur sous la vidéo), puis choisis.'),
            el('div', { class: 'st-fxbar' },
              el('button', { type: 'button', class: S.zoom.picking ? 'btn small' : 'btn secondary small', onclick: () => { S.zoom.picking = !S.zoom.picking; pushFx(); renderEffects(); } }, S.zoom.picking ? 'Terminé' : 'Choisir le point de zoom'),
              el('span', { class: 'st-help inline' }, `Point de zoom : ${Math.round(S.zoom.focus.x * 100)} % à droite, ${Math.round(S.zoom.focus.y * 100)} % en bas`),
              el('button', { type: 'button', class: 'st-link', onclick: () => { S.zoom.focus = { ...ZOOM.focus }; savePrefs(S); effectsChanged(); } }, 'Réinitialiser')),
            zoomRows.length ? el('ol', { class: 'st-fxlist' }, zoomRows) : el('p', { class: 'st-help' }, 'Aucun zoom : « Placer automatiquement » ou ajoute-en à la main.'),
          ]
        : []),
      el('h3', {}, 'Images'),
      el('p', { class: 'st-help' }, 'Une image plein écran par-dessus la vidéo pendant que la voix continue (b-roll), avec un très léger zoom lent. Images libres de droits.'),
      ...(stockOn
        ? [
            el('div', { class: 'st-searchbar' }, searchInput, el('button', { type: 'button', class: 'btn small', disabled: S.stock.busy, onclick: () => searchStock() }, S.stock.busy ? 'Recherche…' : 'Chercher')),
            hints.length ? el('div', { class: 'st-chips' }, el('small', {}, 'Mots du clip :'), hints.map((w) => el('button', { type: 'button', class: 'st-chip', onclick: () => { S.stock.q = w; searchStock(); } }, w))) : null,
            S.stock.error ? el('p', { class: 'st-msg err' }, S.stock.error) : null,
            S.stock.photos.length
              ? el('div', { class: 'st-photos' }, S.stock.photos.map((p) =>
                  el('button', { type: 'button', class: 'st-photo', title: `Ajouter à l’instant de l’aperçu — ${p.photographer} / ${assets.stock.provider}`, style: { background: p.color }, onclick: () => addBroll(p) },
                    el('img', { src: p.thumb, alt: p.alt || 'Image', loading: 'lazy' }))))
              : null,
            S.stock.next ? el('button', { type: 'button', class: 'btn secondary small', disabled: S.stock.busy, onclick: () => searchStock(true) }, 'Plus d’images') : null,
            S.stock.photos.length ? el('p', { class: 'st-help' }, `Touche une image pour l’ajouter à l’instant où se trouve l’aperçu. Images ${assets.stock.provider} : les crédits sont ajoutés au texte « Source à citer ».`) : null,
            brollRows.length ? el('h4', {}, `Images du clip (${brollRows.length}/${BROLL.maxItems})`) : null,
            brollRows.length ? el('ul', { class: 'st-fxlist' }, brollRows) : null,
          ]
        : [el('p', { class: 'st-help' }, 'La recherche d’images n’est pas encore activée sur ce site (clé de la banque d’images manquante).')]),
      fxNote,
    ].filter(Boolean));
  }

  // ============================================================ mise en page
  const tabs = [['extraits', 'Extraits', panelExtracts], ['style', 'Sous-titres', panelStyle], ['musique', 'Musique', panelMusic], ['fx', 'B-roll', panelFx], ['cadrage', 'Cadrage', panelFrame], ['creer', 'Créer', panelCreate]];
  const tabBar = el('div', { class: 'st-tabs', role: 'tablist' });
  const stage = el('div', { class: 'st-stage card' });
  function openTab(id) {
    tabs.forEach(([tid, , panel]) => (panel.hidden = tid !== id));
    tabBar.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === id));
      if (b.dataset.tab === id) b.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
    if (id !== 'musique' && auditionId) { audition.pause(); auditionId = null; renderMusic(); }
    if (id === 'creer') renderCreateSummary();
    if (id === 'fx') renderEffects();
    if (id !== 'fx' && S.zoom.picking) { S.zoom.picking = false; pushFx(); } // on ne reste pas bloqué en choix du point de zoom
  }
  tabs.forEach(([id, label]) => tabBar.append(el('button', { type: 'button', role: 'tab', 'data-tab': id, onclick: () => openTab(id) }, label)));
  stage.append(tabBar, ...tabs.map(([, , p]) => p));

  root.replaceChildren(
    el('div', { class: 'st-top' }, el('a', { class: 'st-back', href: '/studio/' }, '← Autres interviews'), el('p', { class: 'st-title' }, S.video.title)),
    el('div', { class: 'st-grid' }, el('div', { class: 'st-left' }, phone.root), stage),
    disclaimer(),
  );

  renderPresets();
  renderFonts();
  renderExtracts();
  renderMusic();
  renderFrame();
  renderCreate();
  panelStyle.prepend(subNav, textWrap, lookWrap);
  openSub('look');
  syncStyleControls();
  applyAudio();
  pushFraming();
  openTab('extraits');

  // premier extrait : le mieux noté
  const best = [...S.suggestions].sort((x, y) => y.score - x.score)[0];
  if (best) addExtract(best.start_ms, best.end_ms, best.title, best.start_ms);
  else extractsChanged();
}

(async () => {
  try {
    const id = params.get('v');
    if (id) await openEditor(id);
    else await showList();
  } catch (e) {
    root.replaceChildren(el('section', { class: 'card st-empty' }, el('h2', {}, 'Oups'), el('p', {}, e.message), el('a', { class: 'btn small', href: '/studio/' }, 'Retour à la liste')));
  }
})();
