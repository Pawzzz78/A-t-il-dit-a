// Cœur du studio de clips, sans dépendance au navigateur ni à Node : il est utilisé par l'éditeur (aperçu en direct) ET par le
// serveur (rendu ffmpeg). Une seule source de vérité pour les horaires des mots, le découpage en groupes et les styles :
// ce qu'on voit dans l'aperçu est ce qui est incrusté dans la vidéo.
//
// Vocabulaire : « lignes » = segments de la transcription ({ start_ms, end_ms, text }), « extraits » = plages de lignes choisies
// ({ start_ms, end_ms }), « mots » = mots horodatés de la ligne du clip final (en secondes, sur la durée du clip).

// Repère unique des tailles (police, contour, position) : 1080 × 1920, quelle que soit la qualité de sortie.
// La « taille » d'un style est la taille d'em du texte, comme une font-size CSS : libass, lui, dessine un texte de taille ASS N avec
// une em de N × em_ratio (propre à chaque police, mesuré) : buildAss convertit, ce qui rend l'aperçu fidèle à la vidéo.
export const OUT = { w: 1080, h: 1920 };
export const LIMITS = { maxExtracts: 4, minExtractS: 3, maxTotalS: 90 };
export const MODES = ['words', 'one', 'phrase', 'karaoke'];

/** Styles « classiques TikTok » : chacun fixe le comportement (mode) et des valeurs de départ, toutes modifiables ensuite. */
export const PRESETS = {
  hormozi: {
    label: 'Mots en surbrillance',
    hint: 'Quelques mots à la fois, le mot prononcé s’allume',
    style: { mode: 'words', wordsPerGroup: 3, font: 'anton', size: 100, color: '#FFFFFF', highlight: '#FFE600', outline: 10, outlineColor: '#000000', shadow: 0, box: false, uppercase: true, animation: 'pop', y: 0.62 },
  },
  'un-mot': {
    label: 'Un mot à la fois',
    hint: 'Un seul gros mot, très rythmé',
    style: { mode: 'one', wordsPerGroup: 1, font: 'montserrat', size: 128, color: '#FFFFFF', highlight: '#FFFFFF', outline: 12, outlineColor: '#000000', shadow: 0, box: false, uppercase: true, animation: 'pop', y: 0.6 },
  },
  karaoke: {
    label: 'Karaoké',
    hint: 'La phrase se remplit au rythme de la voix',
    style: { mode: 'karaoke', wordsPerGroup: 6, font: 'poppins', size: 66, color: '#FFFFFF', highlight: '#25F4EE', outline: 8, outlineColor: '#000000', shadow: 0, box: false, uppercase: false, animation: 'none', y: 0.66 },
  },
  classique: {
    label: 'Classique',
    hint: 'Blanc cerné de noir, phrase par phrase',
    style: { mode: 'phrase', wordsPerGroup: 7, font: 'montserrat', size: 62, color: '#FFFFFF', highlight: '#FFFFFF', outline: 8, outlineColor: '#000000', shadow: 2, box: false, uppercase: false, animation: 'none', y: 0.68 },
  },
  boite: {
    label: 'Sur fond sombre',
    hint: 'Texte sur un bandeau semi-transparent',
    style: { mode: 'phrase', wordsPerGroup: 7, font: 'inter', size: 56, color: '#FFFFFF', highlight: '#FFFFFF', outline: 0, outlineColor: '#000000', shadow: 0, box: true, boxColor: '#000000', boxOpacity: 0.62, uppercase: false, animation: 'none', y: 0.7 },
  },
};

export const DEFAULT_PRESET = 'hormozi';
export const DEFAULT_STYLE = {
  preset: DEFAULT_PRESET,
  ...PRESETS[DEFAULT_PRESET].style,
  boxColor: '#000000',
  boxOpacity: 0.62,
  x: 0.5,
  maxWidth: 0.86,
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const color = (v, dflt) => (typeof v === 'string' && HEX.test(v) ? v.toUpperCase() : dflt);

/**
 * Style complet et sûr à partir d'une saisie quelconque : valeurs bornées, couleurs valides, police connue.
 * `fontIds` : identifiants de polices autorisés (la première sert de repli).
 */
export function sanitizeStyle(input = {}, fontIds = []) {
  const s = input && typeof input === 'object' ? input : {};
  const preset = PRESETS[s.preset] ? s.preset : DEFAULT_PRESET;
  const base = { ...DEFAULT_STYLE, ...PRESETS[preset].style };
  const mode = MODES.includes(s.mode) ? s.mode : base.mode;
  return {
    preset,
    mode,
    font: fontIds.includes(s.font) ? s.font : fontIds.includes(base.font) ? base.font : (fontIds[0] ?? base.font),
    size: Math.round(clamp(s.size, 30, 220, base.size)),
    color: color(s.color, base.color),
    highlight: color(s.highlight, base.highlight),
    outline: Math.round(clamp(s.outline, 0, 24, base.outline) * 10) / 10,
    outlineColor: color(s.outlineColor, base.outlineColor),
    shadow: Math.round(clamp(s.shadow, 0, 12, base.shadow) * 10) / 10,
    box: typeof s.box === 'boolean' ? s.box : base.box,
    boxColor: color(s.boxColor, base.boxColor),
    boxOpacity: Math.round(clamp(s.boxOpacity, 0, 1, base.boxOpacity) * 100) / 100,
    uppercase: typeof s.uppercase === 'boolean' ? s.uppercase : base.uppercase,
    wordsPerGroup: mode === 'one' ? 1 : Math.round(clamp(s.wordsPerGroup, 1, 10, base.wordsPerGroup)),
    animation: s.animation === 'pop' || s.animation === 'none' ? s.animation : base.animation,
    x: Math.round(clamp(s.x, 0.1, 0.9, 0.5) * 1000) / 1000,
    y: Math.round(clamp(s.y, 0.1, 0.9, base.y) * 1000) / 1000,
    maxWidth: Math.round(clamp(s.maxWidth, 0.4, 0.96, 0.86) * 100) / 100,
  };
}

// --- mots horodatés --------------------------------------------------------------------------

const SENTENCE_END = /[.!?…]["»”')\]]*$/;
const PAUSE = /[,;:]["»”')\]]*$/;

/** Poids d'un mot pour répartir la durée d'une ligne : sa longueur (la parole est à peu près proportionnelle), plus une pause après la ponctuation. */
function weight(token) {
  const letters = token.replace(/[^\p{L}\p{N}]/gu, '').length;
  return Math.max(2, letters) + (SENTENCE_END.test(token) ? 3 : PAUSE.test(token) ? 1.5 : 0);
}

/**
 * Mots horodatés du clip final. `lines` : [{ start_ms, end_ms, text }] ; `extracts` : [{ start_ms, end_ms }].
 * Les extraits sont mis bout à bout. Renvoie { words: [{ text, start, end, line }], duration, segments: [{ offset, length }] }
 * (secondes, sur la durée du clip final ; `line` numérote les lignes d'origine).
 */
export function wordsForExtracts(lines, extracts) {
  const words = [];
  const segments = [];
  let offset = 0;
  let lineNo = 0;
  for (const ex of extracts) {
    const length = (ex.end_ms - ex.start_ms) / 1000;
    segments.push({ offset, length });
    for (const ln of lines) {
      if (ln.start_ms < ex.start_ms - 50 || ln.start_ms >= ex.end_ms) continue;
      const tokens = String(ln.text ?? '').split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      const s = Math.max(ln.start_ms, ex.start_ms) / 1000;
      const e = Math.min(ln.end_ms, ex.end_ms) / 1000;
      const ws = tokens.map(weight);
      const total = ws.reduce((a, b) => a + b, 0);
      let acc = 0;
      tokens.forEach((text, i) => {
        const a = s + ((e - s) * acc) / total;
        acc += ws[i];
        const b = s + ((e - s) * acc) / total;
        words.push({ text, start: offset + (a - ex.start_ms / 1000), end: offset + (b - ex.start_ms / 1000), line: lineNo });
      });
      lineNo++;
    }
    offset += length;
  }
  return { words, duration: offset, segments };
}

/** Découpe un tableau en `parts` morceaux de tailles proches. */
function balanced(arr, max) {
  const parts = Math.ceil(arr.length / max);
  const size = Math.ceil(arr.length / parts);
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Groupes de mots affichés ensemble : { start, end, words }. Selon le mode : N mots (« words »), un mot (« one »), ou une phrase
 * découpée en blocs d'au plus N mots (« phrase », « karaoke »). Un groupe ne chevauche jamais deux lignes d'origine ni une fin de phrase.
 */
export function groupWords(words, style) {
  const n = style.mode === 'one' ? 1 : Math.max(1, style.wordsPerGroup);
  const groups = [];
  if (style.mode === 'words' || style.mode === 'one') {
    let cur = [];
    const flush = () => {
      if (cur.length) groups.push(cur);
      cur = [];
    };
    words.forEach((w, i) => {
      if (cur.length && (cur.length >= n || cur[0].line !== w.line)) flush();
      cur.push(w);
      if (SENTENCE_END.test(w.text) || i === words.length - 1) flush();
    });
    flush();
  } else {
    const byLine = new Map();
    for (const w of words) byLine.set(w.line, [...(byLine.get(w.line) ?? []), w]);
    for (const lineWords of byLine.values()) groups.push(...balanced(lineWords, n));
  }
  // un groupe reste affiché jusqu'au suivant s'il n'y a qu'une courte pause (pas de clignotement), au plus 0,35 s sinon
  return groups.map((ws, i) => {
    const start = ws[0].start;
    const natural = ws.at(-1).end;
    const next = groups[i + 1]?.[0].start;
    const end = next != null ? Math.min(next, natural + 0.35) : natural + 0.2;
    return { start, end: Math.max(end, natural), words: ws };
  });
}

/** Groupe (et mot actif) à l'instant t, pour l'aperçu. */
export function activeAt(groups, t) {
  const g = groups.find((x) => t >= x.start && t < x.end);
  if (!g) return null;
  let active = -1;
  g.words.forEach((w, i) => {
    if (t >= w.start) active = i;
  });
  return { group: g, active };
}

export const displayText = (text, style) => (style.uppercase ? text.toLocaleUpperCase('fr-FR') : text);

/** Largeur utilisable du texte (en px du repère 1080) : jamais au-delà de l'écran, même déplacé vers un bord. */
export const usableWidth = (style) => Math.min(style.maxWidth, 2 * Math.min(style.x, 1 - style.x)) * OUT.w;

/**
 * Facteur de réduction (≤ 1) d'un groupe de mots : un seul mot trop long ne peut pas passer à la ligne et déborderait de l'écran.
 * Estimation avec la largeur d'une capitale de la police (`cap_em`, mesurée avec libass) ; identique pour l'aperçu et le rendu.
 */
export function fitScale(texts, style, font) {
  const longest = Math.max(1, ...texts.map((t) => [...t].length));
  const pad = style.box ? style.size * 0.56 : style.outline * 2;
  const text = longest * style.size * (font?.cap_em ?? 0.62) * (style.uppercase ? 0.98 : 0.85);
  const usable = usableWidth(style);
  // le contour (ou les marges du fond) ne rétrécit pas avec le texte : on ne réduit que la part « texte »
  return text + pad > usable ? Math.max(0.45, (usable - pad) / text) : 1;
}

// --- sous-titres ASS ----------------------------------------------------------------------------

const hex2 = (n) => Math.round(n).toString(16).toUpperCase().padStart(2, '0');
/** « #RRGGBB » -> « &HAABBGGRR » (alpha 00 = opaque). */
export function assColor(hex, alpha = 0) {
  const h = HEX.test(hex) ? hex : '#FFFFFF';
  return `&H${hex2(alpha)}${h.slice(5, 7)}${h.slice(3, 5)}${h.slice(1, 3)}`.toUpperCase();
}
const assTag = (hex) => `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`.toUpperCase();

export function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

/** Texte sûr pour ASS : pas d'accolades ni de retours à la ligne ni d'antislash. */
export const assEscape = (t) => String(t).replace(/\\/g, '/').replace(/[{}]/g, '').replace(/[\r\n]+/g, ' ');

/** Bandeau de source, obligatoire sur chaque clip : titre et date de la vidéo d'origine. */
export function bannerText(title, publishedAt) {
  let t = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (t.length > 56) t = `${t.slice(0, 55).trimEnd()}…`;
  let date = '';
  if (publishedAt) {
    const [y, m, d] = String(publishedAt).slice(0, 10).split('-').map(Number);
    date = y ? new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  }
  return `Source : ${t || 'interview'}${date ? ` · ${date}` : ''}`;
}

/**
 * Fichier ASS complet. `font` : { ass_name, em_ratio, cap_em } de la police choisie ; `banner` : texte du bandeau de source (toujours affiché).
 * Les positions et tailles sont exprimées dans le repère 1080 × 1920 : libass les adapte à la définition de sortie.
 */
export function buildAss({ groups, style, font, banner, duration }) {
  const W = OUT.w;
  const H = OUT.h;
  const cx = Math.round(style.x * W);
  const cy = Math.round(style.y * H);
  // largeur maximale du texte, sans jamais dépasser de l'écran quand on déplace le bloc vers un bord
  const margin = Math.max(0, Math.round((W - usableWidth(style)) / 2));
  const fontSize = (f) => Math.round(style.size / (f?.em_ratio ?? 1)); // taille d'em -> taille ASS
  const boxed = style.box;
  const outline = boxed ? Math.round(style.size * 0.28) : style.outline;
  const outlineCol = boxed ? assColor(style.boxColor, (1 - style.boxOpacity) * 255) : assColor(style.outlineColor);
  const primary = style.mode === 'karaoke' ? style.highlight : style.color; // karaoké : « rempli » = couleur d'accent
  const secondary = style.mode === 'karaoke' ? style.color : style.color;
  const shadowCol = assColor('#000000', 90);

  const out = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Main,${font.ass_name},${fontSize(font)},${assColor(primary)},${assColor(secondary)},${outlineCol},${shadowCol},0,0,0,0,100,100,0,0,${boxed ? 3 : 1},${outline},${boxed ? 0 : style.shadow},5,${margin},${margin},0,1`,
    `Style: Banner,${font.banner_name ?? font.ass_name},${Math.round(30 / (font.banner_em_ratio ?? 1))},&H00FFFFFF,&H00FFFFFF,${assColor('#000000', 115)},&H00000000,0,0,0,0,100,100,0,0,3,10,0,8,60,60,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const pos = `{\\an5\\pos(${cx},${cy})`;
  // `k` : réduction d'un mot trop long ; le « pop » (grossit puis se pose) part de 72 % et finit à la taille normale réduite de k
  const scaleTags = (k, popped) => {
    const pc = (v) => Math.round(v * k);
    if (popped) return `\\fscx${pc(72)}\\fscy${pc(72)}\\t(0,90,\\fscx${pc(106)}\\fscy${pc(106)})\\t(90,170,\\fscx${pc(100)}\\fscy${pc(100)})`;
    return k < 1 ? `\\fscx${pc(100)}\\fscy${pc(100)}` : '';
  };
  const dlg = (start, end, text, first, k) =>
    out.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Main,,0,0,0,,${pos}${scaleTags(k, first && style.animation === 'pop')}}${text}`);

  for (const g of groups) {
    const texts = g.words.map((w) => assEscape(displayText(w.text, style)));
    const k = fitScale(texts, style, font);
    if (style.mode === 'phrase') {
      dlg(g.start, g.end, texts.join(' '), true, k);
    } else if (style.mode === 'karaoke') {
      // \k : durée (centisecondes) de remplissage de chaque mot ; le dernier va jusqu'à la fin du groupe
      const parts = g.words.map((w, i) => {
        const until = i + 1 < g.words.length ? g.words[i + 1].start : g.end;
        return `{\\k${Math.max(1, Math.round((until - w.start) * 100))}}${texts[i]}`;
      });
      dlg(g.start, g.end, parts.join(' '), true, k);
    } else {
      // mots / un mot : un événement par mot ; le mot actif prend la couleur d'accent
      g.words.forEach((w, i) => {
        const start = i === 0 ? g.start : w.start;
        const end = i + 1 < g.words.length ? g.words[i + 1].start : g.end;
        const text = texts.map((t, k) => (k === i && style.mode === 'words' ? `{\\1c${assTag(style.highlight)}}${t}{\\1c${assTag(style.color)}}` : t)).join(' ');
        dlg(start, Math.max(end, start + 0.04), text, i === 0, k);
      });
    }
  }
  // bandeau de source : en haut, pendant tout le clip
  out.push(`Dialogue: 1,${assTime(0)},${assTime(duration)},Banner,,0,0,0,,{\\an8\\pos(${W / 2},150)}${assEscape(banner)}`);
  return `${out.join('\n')}\n`;
}
