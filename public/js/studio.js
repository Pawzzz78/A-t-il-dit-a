// Studio de clips : choix d'une interview, extraits (proposés par l'IA ou libres), sous-titres TikTok (style, police, couleurs,
// contour, position, taille), musique, cadrage, puis création du MP4 sur le serveur. Aucun innerHTML : tout est posé en nœuds.
import { LIMITS, PRESETS, SIMILARITY_WARNING, bannerText, groupWords, lineSimilarity, sanitizeStyle, wordsForExtracts } from './studio-core.js';
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
const secs = (n) => `${Math.round(n)} s`;
const loadPrefs = () => {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}');
  } catch {
    return {};
  }
};
const savePrefs = (S) => {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ style: S.style, music: S.music, voice: S.voice, layout: { fit: S.layout.fit, quality: S.layout.quality, mirror: S.layout.mirror } }));
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
  el('p', { class: 'st-legal' }, 'Les extraits proviennent d’interviews dont les droits appartiennent à leurs auteurs. Un bandeau « Source » est ajouté à chaque clip. Ne déforme pas le sens des propos : garde les phrases entières, et le contexte.');

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
    extracts: [], // { a, b, title } : indices de lignes, bornes incluses
    style: sanitizeStyle(prefs.style, fontIds),
    music: { id: assets.music.some((m) => m.id === prefs.music?.id) ? prefs.music.id : null, volume: Number.isFinite(prefs.music?.volume) ? prefs.music.volume : 0.25 },
    voice: Number.isFinite(prefs.voice) ? prefs.voice : 1,
    layout: { fit: prefs.layout?.fit === 'crop' ? 'crop' : 'blur', cropX: 0.5, quality: prefs.layout?.quality === 'fast' ? 'fast' : 'hd', mirror: prefs.layout?.mirror === true },
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
  const line = (i) => S.lines[i];
  const exMs = (ex) => ({ start_ms: line(ex.a).start_ms, end_ms: line(ex.b).end_ms });
  const exDur = (ex) => (line(ex.b).end_ms - line(ex.a).start_ms) / 1000;
  const totalS = () => S.extracts.reduce((n, ex) => n + exDur(ex), 0);
  const lineAt = (ms) => {
    let best = 0;
    for (let i = 0; i < S.lines.length; i++) if (Math.abs(S.lines[i].start_ms - ms) < Math.abs(S.lines[best].start_ms - ms)) best = i;
    return best;
  };
  const lineEndingAt = (ms) => {
    let best = 0;
    for (let i = 0; i < S.lines.length; i++) if (Math.abs(S.lines[i].end_ms - ms) < Math.abs(S.lines[best].end_ms - ms)) best = i;
    return best;
  };

  // --- aperçu
  let cropSlider = null; // curseur « position du cadrage » de l'onglet Cadrage, tenu à jour quand on glisse la vidéo
  const phone = createPhone({
    onMove: ({ x, y }) => setStyle({ x, y }),
    onCrop: (cropX) => {
      S.layout.cropX = cropX;
      if (cropSlider) cropSlider.value = String(Math.round(cropX * 100));
    },
  });
  const pushFraming = () => phone.setFraming({ fit: S.layout.fit, cropX: S.layout.cropX, mirror: S.layout.mirror });
  const banner = bannerText(S.video.title, S.video.published_at);
  function rebuildSubtitles() {
    const lines = S.edits.size ? S.lines.map((l) => (S.edits.has(l.start_ms) ? { ...l, text: S.edits.get(l.start_ms).text } : l)) : S.lines;
    const { words } = wordsForExtracts(lines, S.extracts.map(exMs));
    phone.configure({ groups: groupWords(words, S.style), style: S.style, font: fontById.get(S.style.font), banner });
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

  function addExtract(a, b, title) {
    if (S.extracts.length >= LIMITS.maxExtracts) return alertNote(`${LIMITS.maxExtracts} extraits au maximum.`);
    const ex = { a, b, title };
    if (totalS() + exDur(ex) > LIMITS.maxTotalS) return alertNote(`Le clip ne peut pas dépasser ${LIMITS.maxTotalS} secondes.`);
    S.extracts.push(ex);
    extractsChanged();
  }
  function extractsChanged() {
    rebuildSubtitles();
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

  function shift(ex, which, delta) {
    const next = { ...ex };
    next[which] += delta;
    if (next.a < 0 || next.b >= S.lines.length || next.a > next.b) return;
    if (exDur(next) < LIMITS.minExtractS) return alertNote(`Un extrait doit durer au moins ${LIMITS.minExtractS} secondes.`);
    if (totalS() - exDur(ex) + exDur(next) > LIMITS.maxTotalS) return alertNote(`Le clip ne peut pas dépasser ${LIMITS.maxTotalS} secondes.`);
    Object.assign(ex, next);
    extractsChanged();
  }
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= S.extracts.length) return;
    [S.extracts[i], S.extracts[j]] = [S.extracts[j], S.extracts[i]];
    extractsChanged();
  };
  const excerpt = (t, n = 70) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

  function extractRow(ex, i) {
    const btn = (label, title, fn, disabled) => el('button', { class: 'st-mini', type: 'button', title, 'aria-label': title, disabled, onclick: fn }, label);
    return el('li', { class: 'st-ex' },
      el('div', { class: 'st-ex-head' }, el('strong', {}, ex.title || 'Passage libre'), el('span', { class: 'badge' }, `${mmss(exMs(ex).start_ms)} → ${mmss(exMs(ex).end_ms)} · ${secs(exDur(ex))}`)),
      el('div', { class: 'st-edge' }, el('span', {}, `Début : « ${excerpt(line(ex.a).text)} »`), el('span', { class: 'st-steps' }, btn('−', 'Commencer une ligne plus tôt', () => shift(ex, 'a', -1)), btn('+', 'Commencer une ligne plus tard', () => shift(ex, 'a', 1)))),
      el('div', { class: 'st-edge' }, el('span', {}, `Fin : « ${excerpt(line(ex.b).text)} »`), el('span', { class: 'st-steps' }, btn('−', 'Finir une ligne plus tôt', () => shift(ex, 'b', -1)), btn('+', 'Finir une ligne plus tard', () => shift(ex, 'b', 1)))),
      el('div', { class: 'st-ex-tools' }, btn('↑', 'Monter', () => move(i, -1), i === 0), btn('↓', 'Descendre', () => move(i, 1), i === S.extracts.length - 1),
        el('button', { class: 'st-link', type: 'button', onclick: () => { S.extracts.splice(i, 1); extractsChanged(); } }, 'Retirer')),
    );
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
    addExtract(i, b, null);
  }

  function renderExtracts() {
    const taken = new Set(S.extracts.map((e) => exMs(e).start_ms));
    panelExtracts.replaceChildren(
      el('h3', {}, 'Mon clip'),
      S.extracts.length ? el('ol', { class: 'st-exlist' }, S.extracts.map(extractRow)) : el('p', { class: 'st-help' }, 'Ajoute un extrait ci-dessous : l’aperçu apparaît à gauche.'),
      el('p', { class: totalS() > LIMITS.maxTotalS ? 'st-total err' : 'st-total' }, S.extracts.length ? `Durée : ${minTotalNote()}` : ''),
      note,
      el('h3', {}, 'Extraits proposés par l’IA'),
      S.suggestions.length
        ? el('ul', { class: 'st-sugg' }, S.suggestions.map((sg) =>
            el('li', { class: 'st-card' },
              el('div', { class: 'st-card-head' }, el('strong', {}, sg.title), el('span', { class: 'badge ok', title: 'Note donnée par l’IA' }, `${sg.score}/10`)),
              el('p', { class: 'st-why' }, sg.why),
              el('p', { class: 'st-meta' }, `${mmss(sg.start_ms)} → ${mmss(sg.end_ms)} · ${secs(sg.duration_s)}`),
              el('details', {}, el('summary', {}, 'Lire l’extrait'), el('p', { class: 'st-text' }, sg.text)),
              taken.has(sg.start_ms)
                ? el('button', { class: 'btn secondary small', type: 'button', onclick: () => { const k = S.extracts.findIndex((e) => exMs(e).start_ms === sg.start_ms); if (k >= 0) { S.extracts.splice(k, 1); extractsChanged(); } } }, 'Retirer de mon clip')
                : el('button', { class: 'btn small', type: 'button', onclick: () => addExtract(lineAt(sg.start_ms), lineEndingAt(sg.end_ms), sg.title) }, 'Ajouter à mon clip'),
            )),
          )
        : el('p', { class: 'st-help' }, 'Pas d’extrait proposé pour cette vidéo : choisis un passage dans la transcription.'),
      el('h3', {}, 'Choisir un autre passage'),
      el('p', { class: 'st-help' }, 'Touche une ligne : l’extrait démarre là (environ 25 s), puis ajuste le début et la fin ligne par ligne.'),
      search,
      lineList,
    );
    renderLines();
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
      if (st.box) { sample.style.background = rgba(st.boxColor, st.boxOpacity); sample.style.padding = '.1em .35em'; }
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
  boxRows.append(row('Couleur du fond', ...colorInput('boxColor')), row('Opacité du fond', ...slider('boxOpacity', 0, 1, 0.02, (v) => `${Math.round(v * 100)} %`)));

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
      const m = exMs(ex);
      for (let i = ex.a; i <= ex.b; i++) rows.push({ k, line: S.lines[i], at: offset + Math.max(0, (S.lines[i].start_ms - m.start_ms) / 1000) });
      offset += (m.end_ms - m.start_ms) / 1000;
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
      el('p', { class: 'st-help' }, 'L’image est retournée gauche-droite ; les sous-titres et le bandeau « Source » ne le sont jamais. Attention : les textes visibles dans l’image (panneaux, logos, bandeaux de chaîne) apparaîtront à l’envers. Le miroir ne change pas les droits sur la vidéo d’origine.'),
      el('p', { class: 'st-help' }, 'Le bandeau « Source : titre · date » est toujours ajouté en haut du clip : il rappelle d’où vient l’extrait.'),
    );
  }

  // ============================================================ onglet Créer
  const panelCreate = el('div', { class: 'st-panel' });
  const createSummary = el('div', {});
  const pledge = el('input', { type: 'checkbox' });
  const makeBtn = el('button', { class: 'btn', type: 'button' }, 'Créer la vidéo');
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
      el('li', {}, el('strong', {}, 'Cadrage : '), `${S.layout.fit === 'blur' ? 'vidéo entière sur fond flou' : 'plein écran'}${S.layout.mirror ? ', en miroir' : ''}`)));
    makeBtn.disabled = !S.extracts.length || !pledge.checked || Boolean(job && ['queued', 'running'].includes(job.status));
  }
  const quality = (value, title, text) => el('label', { class: S.layout.quality === value ? 'st-opt on' : 'st-opt' },
    el('input', { type: 'radio', name: 'quality', value, checked: S.layout.quality === value, onchange: () => { S.layout.quality = value; savePrefs(S); renderCreate(); } }),
    el('strong', {}, title), el('small', {}, text));
  function renderCreate() {
    panelCreate.replaceChildren(
      el('h3', {}, 'Ton clip'), createSummary,
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
          const blob = await (await fetch(url)).blob();
          const file = new File([blob], job.filename, { type: 'video/mp4' });
          if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: 'Lisnard Facts' });
          else { makeMsg.className = 'st-msg'; makeMsg.textContent = 'Le partage direct n’est pas disponible ici : télécharge la vidéo.'; }
        } catch { /* partage annulé */ }
      });
      jobBox.replaceChildren(
        el('p', { class: 'st-job-text ok' }, 'Ta vidéo est prête !'),
        el('video', { class: 'st-result', src: url, controls: true, playsinline: '', preload: 'metadata' }),
        el('div', { class: 'st-job-actions' }, el('a', { class: 'btn', href: url, download: job.filename }, 'Télécharger'), navigator.canShare ? share : null,
          el('button', { class: 'btn secondary small', type: 'button', onclick: () => { job = null; showJob(); renderCreateSummary(); } }, 'Faire un autre clip')),
        el('p', { class: 'st-help' }, 'Pense à citer la source dans ta légende : titre et date de l’interview sont affichés en haut de la vidéo.'));
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
        edits: Object.fromEntries(clipLines().filter((r) => S.edits.has(r.line.start_ms)).map((r) => [r.line.start_ms, S.edits.get(r.line.start_ms).text])),
      });
      showJob();
      poll();
    } catch (e) {
      fail(makeMsg, e);
      renderCreateSummary();
    }
  });

  // ============================================================ mise en page
  const tabs = [['extraits', 'Extraits', panelExtracts], ['style', 'Sous-titres', panelStyle], ['musique', 'Musique', panelMusic], ['cadrage', 'Cadrage', panelFrame], ['creer', 'Créer', panelCreate]];
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
  if (best) addExtract(lineAt(best.start_ms), lineEndingAt(best.end_ms), best.title);
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
