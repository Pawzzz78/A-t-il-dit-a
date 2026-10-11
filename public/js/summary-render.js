// Lecture du Markdown restreint produit par le résumé IA : « ## [12:34] Titre », « - puce », « **gras** ».
// Fonctions pures (pas de DOM) : l'affichage se fait avec des nœuds, jamais avec innerHTML.

/** "mm:ss" ou "h:mm:ss" -> secondes */
export function tsToSeconds(ts) {
  const parts = String(ts).split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** "un **mot** clé" -> [{ text: 'un ', bold: false }, { text: 'mot', bold: true }, { text: ' clé', bold: false }] */
export function parseInline(text) {
  const out = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false });
    out.push({ text: m[1], bold: true });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last).replace(/\*\*/g, ''), bold: false });
  return out.filter((n) => n.text);
}

/** Markdown restreint -> blocs { type: 'heading' | 'list' | 'p', … } */
export function parseSummary(markdown) {
  const blocks = [];
  let list = null;
  let para = null;
  const flush = () => {
    list = null;
    para = null;
  };
  for (const raw of String(markdown ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const h = line.match(/^##\s+(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*)?(.*)$/);
    if (h) {
      flush();
      const ts = h[1] ?? null;
      blocks.push({ type: 'heading', text: h[2].replace(/\*\*/g, ''), ts, seconds: ts ? tsToSeconds(ts) : null });
      continue;
    }
    const b = line.match(/^-\s+(.*)$/);
    if (b) {
      para = null;
      if (!list) {
        list = { type: 'list', items: [] };
        blocks.push(list);
      }
      list.items.push(parseInline(b[1]));
      continue;
    }
    list = null;
    if (para) para.text += ` ${line}`;
    else {
      para = { type: 'p', text: line };
      blocks.push(para);
    }
  }
  return blocks.map((blk) => (blk.type === 'p' ? { type: 'p', inline: parseInline(blk.text) } : blk));
}
