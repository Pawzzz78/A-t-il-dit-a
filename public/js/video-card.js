// Carte d'une vidéo (miniature, titre, date, durée) pour la grille, et fenêtre du résumé IA.
import { fmtDate, fmtDuration, h, langName } from './ui.js';
import { parseSummary } from './summary-render.js';

function renderSummary(markdown, video) {
  const box = h('div', { class: 'summary-body' });
  let afterBrief = false;
  for (const block of parseSummary(markdown)) {
    if (block.type === 'heading') {
      afterBrief = /^en bref$/i.test(block.text.trim());
      const title = h('h4', {});
      if (block.ts) {
        title.append(
          h(
            'a',
            { class: 'ts-link', href: `https://www.youtube.com/watch?v=${video.youtube_id}&t=${block.seconds}s`, target: '_blank', rel: 'noopener noreferrer', title: 'Écouter ce passage' },
            `▶ ${block.ts}`,
          ),
        );
      }
      title.append(block.text);
      box.append(title);
    } else if (block.type === 'list') {
      afterBrief = false;
      const ul = h('ul', {});
      for (const item of block.items) {
        const li = h('li', {});
        for (const n of item) li.append(n.bold ? h('strong', {}, n.text) : n.text);
        ul.append(li);
      }
      box.append(ul);
    } else {
      const p = h('p', { class: afterBrief ? 'brief' : '' });
      for (const n of block.inline) p.append(n.bold ? h('strong', {}, n.text) : n.text);
      box.append(p);
    }
  }
  return box;
}

// --- fenêtre du résumé ------------------------------------------------------------

const summaryCache = new Map(); // youtube_id -> { markdown, edited, translated, original_lang }
let modal = null;

/** Fenêtre unique, créée à la première ouverture : <dialog> natif (Échap, focus piégé, rendu au-dessus de tout). */
function getModal() {
  if (modal) return modal;
  const title = h('h3', { id: 'summary-modal-title' });
  const meta = h('p', { class: 'meta' });
  const close = h('button', { class: 'modal-close', type: 'button', 'aria-label': 'Fermer le résumé' }, '×');
  const body = h('div', { class: 'modal-body', 'aria-live': 'polite' });
  const watch = h('a', { class: 'watch', target: '_blank', rel: 'noopener noreferrer' }, 'Voir la vidéo ↗');
  const foot = h('div', { class: 'modal-foot' }, watch);
  const box = h('div', { class: 'modal-box' }, h('div', { class: 'modal-head' }, h('div', { class: 'modal-title' }, title, meta), close), body, foot);
  const dialog = h('dialog', { class: 'summary-modal', 'aria-labelledby': 'summary-modal-title' }, box);
  document.body.append(dialog);

  const shut = () => dialog.close();
  close.addEventListener('click', shut);
  // un clic hors de la fenêtre atteint le <dialog> lui-même (la boîte remplit tout son intérieur)
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) shut();
  });
  dialog.addEventListener('close', () => document.body.classList.remove('modal-open'));
  modal = { dialog, title, meta, body, watch };
  return modal;
}

async function loadSummary(youtubeId) {
  if (summaryCache.has(youtubeId)) return summaryCache.get(youtubeId);
  const res = await fetch(`/api/summary/${encodeURIComponent(youtubeId)}`, { signal: AbortSignal.timeout(30_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Le résumé est indisponible.');
  summaryCache.set(youtubeId, data);
  return data;
}

async function openSummary(v, url) {
  const m = getModal();
  m.title.textContent = v.title;
  m.meta.textContent = [v.channel, v.published_at ? `Publiée le ${fmtDate(v.published_at)}` : ''].filter(Boolean).join(' · ');
  m.watch.href = url;
  m.body.replaceChildren(h('p', { class: 'hint' }, 'Chargement du résumé…'));
  m.body.scrollTop = 0;
  document.body.classList.add('modal-open');
  if (!m.dialog.open) m.dialog.showModal();
  try {
    const data = await loadSummary(v.youtube_id);
    const note = [
      data.edited
        ? 'Résumé généré par IA puis corrigé à la main. Il peut contenir des erreurs : écoute la vidéo pour vérifier.'
        : 'Résumé généré par IA à partir de la transcription automatique : il peut contenir des erreurs. Écoute la vidéo pour vérifier.',
      data.translated ? `Il s’appuie sur une traduction automatique${data.original_lang ? ` depuis le ${langName(data.original_lang)}` : ''}.` : '',
    ].filter(Boolean).join(' ');
    // la fenêtre a pu être rouverte sur une autre vidéo pendant le chargement
    if (m.watch.href !== url) return;
    m.body.replaceChildren(renderSummary(data.markdown, v), h('p', { class: 'summary-note' }, note));
  } catch (e) {
    if (m.watch.href !== url) return;
    m.body.replaceChildren(h('p', { class: 'error' }, e.name === 'TimeoutError' ? 'Le chargement du résumé a été trop long, réessaie.' : e.message));
  }
}

// --- carte -----------------------------------------------------------------------

export function renderVideoCard(v, summariesEnabled) {
  const url = `https://www.youtube.com/watch?v=${v.youtube_id}`;
  const date = fmtDate(v.published_at);

  // Les résumés sont générés automatiquement : le visiteur ne fait que les afficher.
  //  - résumé prêt            -> « Afficher le résumé » (ouvre la fenêtre)
  //  - pas encore prêt (auto) -> bouton inactif « Résumé en préparation… » (aucune génération n'est déclenchée)
  //  - résumés désactivés     -> rien
  let button = null;
  if (v.has_summary) {
    button = h('button', { class: 'btn small', type: 'button' }, 'Afficher le résumé');
    button.addEventListener('click', () => openSummary(v, url));
  } else if (summariesEnabled) {
    button = h('button', { class: 'btn small', type: 'button', disabled: true, title: 'Le résumé sera disponible dans quelques minutes' }, 'Résumé en préparation…');
  }

  const placeholder = () => h('span', { class: 'thumb-empty', 'aria-hidden': 'true' }, '▶');
  const img = v.thumbnail_url ? h('img', { src: v.thumbnail_url, alt: '', loading: 'lazy' }) : null;
  const thumb = h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'thumb', 'aria-label': `Voir la vidéo : ${v.title}` }, img ?? placeholder());
  img?.addEventListener('error', () => thumb.replaceChildren(placeholder())); // miniature indisponible
  return h(
    'article',
    { class: 'video-card card' },
    thumb,
    h(
      'div',
      { class: 'video-info' },
      h('h3', {}, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, v.title)),
      h('p', { class: 'meta' }, [v.channel, date ? `Publiée le ${date}` : '', fmtDuration(v.duration_s)].filter(Boolean).join(' · ')),
      h('div', { class: 'video-actions' }, button, h('a', { class: 'watch', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Voir la vidéo ↗')),
    ),
  );
}
