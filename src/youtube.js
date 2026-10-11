const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Accepte une URL YouTube (watch, youtu.be, shorts, embed, live) ou un identifiant brut. */
export function parseYoutubeId(input) {
  const raw = String(input ?? '').trim();
  if (ID_RE.test(raw)) return raw;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/')[1];
    return ID_RE.test(id ?? '') ? id : null;
  }
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    const v = url.searchParams.get('v');
    if (v && ID_RE.test(v)) return v;
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
  }
  return null;
}

export const watchUrl = (id, startMs = 0) =>
  `https://www.youtube.com/watch?v=${id}${startMs > 0 ? `&t=${Math.floor(startMs / 1000)}s` : ''}`;

/** Titre, chaîne et miniature via oEmbed (aucune clé API nécessaire). */
export async function fetchMetadata(youtubeId) {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${youtubeId}`,
  )}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = await res.json();
    return {
      title: j.title ?? '',
      channel: j.author_name ?? '',
      thumbnail_url: j.thumbnail_url ?? `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
    };
  } catch {
    return null;
  }
}
