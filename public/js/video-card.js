// Carte d'une vidéo (miniature, titre, date, durée) avec le bouton « Résumer » et le résumé IA.
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

export function renderVideoCard(v, summariesEnabled) {
  const url = `https://www.youtube.com/watch?v=${v.youtube_id}`;
  const date = fmtDate(v.published_at);
  const panel = h('div', { class: 'summary', hidden: true, 'aria-live': 'polite' });
  let loaded = false;

  const button = summariesEnabled
    ? h('button', { class: 'btn small', type: 'button' }, 'Résumer')
    : null;

  if (button) {
    button.addEventListener('click', async () => {
      if (loaded) {
        panel.hidden = !panel.hidden;
        button.textContent = panel.hidden ? 'Voir le résumé' : 'Masquer le résumé';
        return;
      }
      button.disabled = true;
      button.textContent = 'Résumé en cours…';
      panel.hidden = false;
      panel.replaceChildren(h('p', { class: 'hint' }, 'Le résumé est en cours de rédaction… cela peut prendre jusqu’à une minute pour une longue vidéo.'));
      try {
        const res = await fetch(`/api/summary/${encodeURIComponent(v.youtube_id)}`, { method: 'POST', signal: AbortSignal.timeout(180_000) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Le résumé est indisponible.');
        const note = [
          'Résumé généré par IA à partir de la transcription automatique : il peut contenir des erreurs. Écoute la vidéo pour vérifier.',
          data.translated ? `Il s’appuie sur une traduction automatique${data.original_lang ? ` depuis le ${langName(data.original_lang)}` : ''}.` : '',
        ].filter(Boolean).join(' ');
        panel.replaceChildren(renderSummary(data.markdown, v), h('p', { class: 'summary-note' }, note));
        loaded = true;
        button.textContent = 'Masquer le résumé';
      } catch (e) {
        panel.replaceChildren(h('p', { class: 'error' }, e.name === 'TimeoutError' ? 'Le résumé met trop de temps, réessaie dans un instant.' : e.message));
        button.textContent = 'Résumer';
      } finally {
        button.disabled = false;
      }
    });
  }

  return h(
    'article',
    { class: 'video-card card' },
    h(
      'div',
      { class: 'video-row' },
      v.thumbnail_url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'thumb' }, h('img', { src: v.thumbnail_url, alt: '', loading: 'lazy' })) : null,
      h(
        'div',
        { class: 'video-info' },
        h('h3', {}, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, v.title)),
        h('p', { class: 'meta' }, [v.channel, date ? `Publiée le ${date}` : '', fmtDuration(v.duration_s)].filter(Boolean).join(' · ')),
        h('div', { class: 'video-actions' }, button, h('a', { class: 'watch', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Voir la vidéo ↗')),
      ),
    ),
    panel,
  );
}
