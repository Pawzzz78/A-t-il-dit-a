// End card visuals drawn in the browser (1080 × 1920), in the spirit of the PostLisnard posters; the server only appends the image
export const CARD = { w: 1080, h: 1920, pad: 96, maxPhotoMb: 10 };

export const PALETTES = {
  navy: { label: 'Bleu', bg: '#032F67', fg: '#FFFFFF', accent: '#A0A37E', muted: 'rgba(255,255,255,.78)', logo: '/brand/projet-lisnard-clair.png' },
  white: { label: 'Blanc', bg: '#FFFFFF', fg: '#032F67', accent: '#A0A37E', muted: 'rgba(3,47,103,.72)', logo: '/brand/projet-lisnard.png' },
  khaki: { label: 'Kaki', bg: '#A0A37E', fg: '#032F67', accent: '#FFFFFF', muted: 'rgba(3,47,103,.8)', logo: '/brand/projet-lisnard.png' },
};

const F = (key, label, max, { area = false, placeholder = '', type = 'text' } = {}) => ({ key, label, max, area, placeholder, type });
export const TEMPLATES = {
  headline: { label: 'Une idée forte', hint: 'Un message, quelques mots', fields: [F('title', 'Ton message', 110, { area: true, placeholder: 'Un nouvel élan pour nos territoires' }), F('subtitle', 'Une précision', 100, { placeholder: 'Quelques mots en complément' })] },
  quote: { label: 'Citation', hint: 'Une phrase et son auteur', fields: [F('title', 'La citation', 240, { area: true, placeholder: 'Les mots justes, à partager' }), F('author', 'Auteur', 80, { placeholder: 'David Lisnard' })] },
  stat: { label: 'Un chiffre', hint: 'Une donnée et sa source', fields: [F('number', 'Le chiffre', 18, { placeholder: '42 %' }), F('title', 'Ce qu’il représente', 90, { area: true, placeholder: 'des Français veulent…' }), F('source', 'Sa source', 120, { placeholder: 'Organisme, étude, date' })] },
  event: { label: 'Événement', hint: 'Titre, date, lieu', fields: [F('title', 'Nom de l’événement', 85, { area: true, placeholder: 'Rencontrons-nous' }), F('subtitle', 'Une précision', 85, { placeholder: 'Le thème ou le programme' }), F('date', 'Date', 10, { type: 'date' }), F('time', 'Heure', 5, { type: 'time' }), F('location', 'Lieu', 100, { area: true, placeholder: 'Salle, ville' })] },
  photo: { label: 'Image + message', hint: 'Ta photo en grand', photo: true, fields: [F('title', 'Ton message', 85, { area: true, placeholder: 'Les idées prennent vie' }), F('subtitle', 'Une précision', 100, { placeholder: 'Quelques mots en complément' })] },
  cta: { label: 'Appel à l’action', hint: 'Abonne-toi, partage, rejoins…', fields: [F('title', 'Ton appel', 60, { area: true, placeholder: 'Partage si tu es d’accord' }), F('subtitle', 'Où aller', 80, { placeholder: 'projetlisnard.fr' })] },
};

export function defaultDesign() {
  return { template: 'headline', palette: 'navy', align: 'left', upper: true, logo: true, source: true, photoBg: false, values: {} };
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, '').replace(/[ \t]+/g, ' ').slice(0, max);

// The photo never leaves the browser on its own: only these settings and the final JPEG do
export function sanitizeDesign(input) {
  const d = input && typeof input === 'object' ? input : {};
  const template = Object.hasOwn(TEMPLATES, d.template) ? d.template : 'headline';
  const values = {};
  for (const f of TEMPLATES[template].fields) {
    let v = clean(d.values?.[f.key], f.max);
    if (f.type === 'date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) v = '';
    if (f.type === 'time' && v && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) v = '';
    if (!f.area) v = v.replace(/\n+/g, ' ');
    if (v.trim()) values[f.key] = v;
  }
  return {
    template,
    palette: Object.hasOwn(PALETTES, d.palette) ? d.palette : 'navy',
    align: d.align === 'center' ? 'center' : 'left',
    upper: d.upper !== false,
    logo: d.logo !== false,
    source: d.source !== false,
    photoBg: d.photoBg === true,
    values,
  };
}

export const needsPhoto = (design) => Boolean(TEMPLATES[design.template]?.photo || design.photoBg);

export function eventDateText(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  const day = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  return [day, /^\d{2}:\d{2}$/.test(time ?? '') ? time.replace(':', ' h ') : ''].filter(Boolean).join(' · ');
}

// --- drawing ------------------------------------------------------------------------------------------------------------------------

const FONT = 'Montserrat, Arial, sans-serif';
const font = (ctx, size, weight = 800) => (ctx.font = `${weight} ${size}px ${FONT}`);

export function wrapText(text, width, measure) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (measure(next) <= width || !cur) cur = next;
      else { out.push(cur); cur = w; }
    }
    out.push(cur);
  }
  return out;
}

function fitText(ctx, text, box, { max, min = 34, weight = 800, color, align = 'left', lh = 1.08, valign = 'top' }) {
  if (!text) return { top: box.y, bottom: box.y };
  let lo = min;
  let hi = max;
  let best = { size: min, lines: [] };
  while (lo <= hi) {
    const size = Math.floor((lo + hi) / 2);
    font(ctx, size, weight);
    const lines = wrapText(text, box.w, (s) => ctx.measureText(s).width);
    const fits = lines.length * size * lh <= box.h && lines.every((l) => ctx.measureText(l).width <= box.w + 1);
    if (fits) { best = { size, lines }; lo = size + 1; } else hi = size - 1;
  }
  if (!best.lines.length) {
    font(ctx, min, weight);
    best = { size: min, lines: wrapText(text, box.w, (s) => ctx.measureText(s).width) };
  }
  font(ctx, best.size, weight);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  const used = best.lines.length * best.size * lh;
  const y0 = valign === 'center' ? box.y + Math.max(0, (box.h - used) / 2) : valign === 'bottom' ? box.y + Math.max(0, box.h - used) : box.y;
  const x = align === 'center' ? box.x + box.w / 2 : box.x;
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x - 4, box.y - 4, box.w + 8, box.h + 8);
  ctx.clip();
  best.lines.forEach((l, i) => ctx.fillText(l, x, y0 + i * best.size * lh));
  ctx.restore();
  return { top: y0, bottom: y0 + used };
}

function cover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * s;
  const dh = img.naturalHeight * s;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

const rule = (ctx, x, y, w, color, t = 12) => {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, t);
};

const imageCache = new Map();
export function loadImage(src) {
  if (!imageCache.has(src)) {
    imageCache.set(src, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => {
        imageCache.delete(src);
        reject(new Error('Image indisponible'));
      };
      img.src = src;
    }));
  }
  return imageCache.get(src);
}

// Returns what is still missing (empty when the visual is complete)
export async function drawEndCard(canvas, design, { photo = null, sourceLine = '' } = {}) {
  const d = sanitizeDesign(design);
  const t = TEMPLATES[d.template];
  const p = PALETTES[d.palette];
  const v = (k) => d.values[k] ?? '';
  const missing = [];
  if (document.fonts) await Promise.all([800, 900, 600].map((w) => document.fonts.load(`${w} 64px Montserrat`))).catch(() => {});
  const logo = d.logo ? await loadImage(d.photoBg && !t.photo ? PALETTES.navy.logo : p.logo).catch(() => null) : null;
  canvas.width = CARD.w;
  canvas.height = CARD.h;
  let ctx = canvas.getContext('2d');
  const { w: W, h: H, pad } = CARD;
  const inner = W - 2 * pad;
  const center = d.align === 'center';
  const ax = center ? (W - 200) / 2 : pad;

  // background: palette, or a darkened full-bleed photo
  let fg = p.fg;
  let muted = p.muted;
  ctx.fillStyle = p.bg;
  ctx.fillRect(0, 0, W, H);
  let top = 300;
  if (t.photo) {
    if (photo) cover(ctx, photo, 0, 0, W, 1060);
    else {
      ctx.fillStyle = 'rgba(127,127,127,.18)';
      ctx.fillRect(0, 0, W, 1060);
      missing.push('la photo');
    }
    rule(ctx, 0, 1060, W, p.accent, 14);
    top = 1150;
  } else if (d.photoBg) {
    if (photo) {
      cover(ctx, photo, 0, 0, W, H);
      ctx.fillStyle = 'rgba(3,47,103,.62)';
      ctx.fillRect(0, 0, W, H);
      fg = '#FFFFFF';
      muted = 'rgba(255,255,255,.82)';
    } else missing.push('la photo de fond');
  }

  if (logo && !t.photo) {
    const lh = 190;
    const lw = (logo.naturalWidth / logo.naturalHeight) * lh;
    ctx.drawImage(logo, center ? (W - lw) / 2 : pad, 110, lw, lh);
  }
  const up = (s) => (d.upper ? s.toLocaleUpperCase('fr-FR') : s);
  const bottomLimit = H - (d.source && sourceLine ? 330 : 200);
  const accent = d.photoBg && !t.photo ? PALETTES.navy.accent : p.accent;

  // Text is drawn on its own layer, then centred vertically between the logo and the source line
  const main = ctx;
  const layer = document.createElement('canvas');
  layer.width = W;
  layer.height = H;
  ctx = layer.getContext('2d');
  if (d.template === 'headline' || d.template === 'cta' || d.template === 'photo') {
    if (!v('title')) missing.push('le message');
    if (!t.photo) rule(ctx, ax, top + 120, 200, accent);
    const tb = fitText(ctx, up(v('title') || 'Ton message ici'), { x: pad, y: t.photo ? top : top + 190, w: inner, h: t.photo ? 360 : 760 }, { max: t.photo ? 110 : d.template === 'cta' ? 150 : 132, min: 44, weight: 900, color: v('title') ? fg : muted, align: center ? 'center' : 'left', valign: t.photo ? 'top' : 'center' });
    if (v('subtitle')) {
      const y = tb.bottom + 40;
      if (d.template === 'cta') rule(ctx, ax, y, 200, accent, 8);
      fitText(ctx, v('subtitle'), { x: pad, y: y + (d.template === 'cta' ? 40 : 0), w: inner, h: Math.max(60, bottomLimit - y - 40) }, { max: 56, min: 30, weight: 600, color: muted, align: center ? 'center' : 'left', lh: 1.25 });
    }
  } else if (d.template === 'quote') {
    if (!v('title')) missing.push('la citation');
    font(ctx, 360, 900);
    ctx.fillStyle = accent;
    ctx.textAlign = center ? 'center' : 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('“', center ? W / 2 : pad - 10, top + 40);
    const tb = fitText(ctx, v('title') || 'La citation ici', { x: pad, y: top + 330, w: inner, h: 700 }, { max: 96, min: 40, weight: 800, color: v('title') ? fg : muted, align: center ? 'center' : 'left', lh: 1.18 });
    if (v('author')) {
      rule(ctx, ax, tb.bottom + 50, 120, accent, 8);
      fitText(ctx, up(v('author')), { x: pad, y: tb.bottom + 90, w: inner, h: 80 }, { max: 50, min: 30, weight: 800, color: fg, align: center ? 'center' : 'left' });
    }
  } else if (d.template === 'stat') {
    if (!v('number')) missing.push('le chiffre');
    if (!v('source')) missing.push('la source du chiffre');
    const nb = fitText(ctx, v('number') || '42 %', { x: pad, y: top + 120, w: inner, h: 380 }, { max: 330, min: 120, weight: 900, color: v('number') ? accent : muted, align: center ? 'center' : 'left', lh: 1 });
    const tb = fitText(ctx, up(v('title') || 'Ce que représente ce chiffre'), { x: pad, y: nb.bottom + 40, w: inner, h: 420 }, { max: 92, min: 40, weight: 900, color: v('title') ? fg : muted, align: center ? 'center' : 'left' });
    if (v('source')) fitText(ctx, `Source : ${v('source')}`, { x: pad, y: tb.bottom + 50, w: inner, h: 160 }, { max: 40, min: 26, weight: 600, color: muted, align: center ? 'center' : 'left', lh: 1.3 });
  } else if (d.template === 'event') {
    if (!v('title')) missing.push('le nom de l’événement');
    rule(ctx, ax, top + 120, 200, accent);
    const tb = fitText(ctx, up(v('title') || 'Ton événement'), { x: pad, y: top + 190, w: inner, h: 420 }, { max: 128, min: 48, weight: 900, color: v('title') ? fg : muted, align: center ? 'center' : 'left' });
    let y = tb.bottom + 30;
    if (v('subtitle')) y = fitText(ctx, v('subtitle'), { x: pad, y, w: inner, h: 150 }, { max: 52, min: 30, weight: 600, color: muted, align: center ? 'center' : 'left', lh: 1.25 }).bottom + 50;
    const when = eventDateText(v('date'), v('time'));
    if (when) y = fitText(ctx, up(when), { x: pad, y, w: inner, h: 160 }, { max: 64, min: 34, weight: 900, color: accent, align: center ? 'center' : 'left' }).bottom + 24;
    if (v('location')) fitText(ctx, v('location'), { x: pad, y, w: inner, h: Math.max(60, bottomLimit - y) }, { max: 50, min: 30, weight: 700, color: fg, align: center ? 'center' : 'left', lh: 1.25 });
  }

  ctx = main;
  let shift = 0;
  if (!t.photo) {
    const px = layer.getContext('2d').getImageData(0, 0, W, H).data;
    let y0 = -1;
    let y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 3; x < W * 4; x += 16) {
        if (px[y * W * 4 + x] > 8) {
          if (y0 < 0) y0 = y;
          y1 = y;
          break;
        }
      }
    }
    const zoneTop = logo ? 380 : 160;
    if (y0 >= 0) shift = Math.max(zoneTop - y0, Math.round((zoneTop + bottomLimit - y0 - y1) / 2));
  }
  ctx.drawImage(layer, 0, shift);

  if (d.source && sourceLine) {
    ctx.fillStyle = muted;
    ctx.fillRect(pad, H - 290, inner, 2);
    fitText(ctx, sourceLine, { x: pad, y: H - 250, w: inner, h: 110 }, { max: 38, min: 24, weight: 600, color: muted, align: center ? 'center' : 'left', lh: 1.3 });
  }
  return missing;
}

export const cardBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Image impossible'))), 'image/jpeg', 0.9));
