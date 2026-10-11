// Petits utilitaires d'affichage partagés (accueil, liste des vidéos).

/** Crée un élément DOM (jamais d'innerHTML : les textes viennent de la base). */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

export const fmtDuration = (sec) => {
  if (!sec) return '';
  if (sec < 60) return `${sec} s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
};

export const fmtDate = (d) => {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('fr-FR', { dateStyle: 'long' });
};

export const langName = (code) => {
  try {
    return new Intl.DisplayNames(['fr'], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
};
