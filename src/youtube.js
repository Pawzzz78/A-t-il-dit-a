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

// --- API YouTube Data v3 (liste des vidéos d'une chaîne) -----------------------------
// Quota gratuit : 10 000 unités/jour ; chaque page de 50 vidéos coûte ~2 unités.

const API = 'https://www.googleapis.com/youtube/v3';

export class YouTubeApiError extends Error {}

export const youtubeApiConfigured = () => Boolean(process.env.YOUTUBE_API_KEY);

async function api(resource, params) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new YouTubeApiError("YOUTUBE_API_KEY n'est pas configurée.");
  const url = new URL(`${API}/${resource}`);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  url.searchParams.set('key', key);
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new YouTubeApiError(`API YouTube injoignable : ${e.message}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body.error?.errors?.[0]?.reason ?? res.status;
    const msg = reason === 'quotaExceeded' ? 'quota de l’API YouTube dépassé pour aujourd’hui'
      : /keyInvalid|API_KEY_INVALID/.test(String(reason) + JSON.stringify(body)) ? 'clé API YouTube invalide'
      : (body.error?.message ?? res.statusText);
    const err = new YouTubeApiError(`API YouTube : ${msg}`);
    err.status = res.status;
    err.reason = reason;
    throw err;
  }
  return body;
}

/** "PT1H2M3S" -> secondes */
function parseIsoDuration(iso) {
  const m = String(iso ?? '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, d = 0, h = 0, mi = 0, s = 0] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(mi) * 60 + Number(s);
}

/**
 * Retrouve une chaîne à partir d'une URL (/@nom, /channel/UC…, /user/nom), d'un @handle ou d'un id UC….
 * Renvoie { youtube_channel_id, title, handle, uploads_playlist_id }.
 */
export async function resolveChannel(input) {
  const raw = String(input ?? '').trim();
  let params;
  let m;
  if (/^UC[\w-]{22}$/.test(raw)) params = { id: raw };
  else if (/^@[\w.-]+$/.test(raw)) params = { forHandle: raw };
  else {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      url = null;
    }
    const path = url?.hostname.endsWith('youtube.com') ? decodeURIComponent(url.pathname) : '';
    if ((m = path.match(/^\/channel\/(UC[\w-]{22})/))) params = { id: m[1] };
    else if ((m = path.match(/^\/(@[\w.-]+)/))) params = { forHandle: m[1] };
    else if ((m = path.match(/^\/user\/([\w.-]+)/))) params = { forUsername: m[1] };
  }
  if (!params) {
    throw new YouTubeApiError('Utilise une adresse de la forme youtube.com/@nom ou youtube.com/channel/UC…');
  }
  const body = await api('channels', { part: 'snippet,contentDetails', ...params });
  const ch = body.items?.[0];
  if (!ch) throw new YouTubeApiError('Chaîne introuvable.');
  return {
    youtube_channel_id: ch.id,
    title: ch.snippet?.title ?? '',
    handle: ch.snippet?.customUrl ?? null,
    uploads_playlist_id: ch.contentDetails.relatedPlaylists.uploads,
  };
}

async function videoDetails(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const body = await api('videos', { part: 'snippet,contentDetails', id: ids.slice(i, i + 50).join(',') });
    for (const v of body.items ?? []) {
      out.push({
        youtube_id: v.id,
        title: v.snippet?.title ?? '',
        channel: v.snippet?.channelTitle ?? '',
        channel_id: v.snippet?.channelId ?? null,
        published_at: (v.snippet?.publishedAt ?? '').slice(0, 10) || null,
        thumbnail_url: v.snippet?.thumbnails?.high?.url ?? v.snippet?.thumbnails?.medium?.url ?? null,
        duration_s: parseIsoDuration(v.contentDetails?.duration) || null, // P0D (live just ended): unknown, not 0 s
        // 'live' / 'upcoming' : direct en cours ou à venir, pas encore de sous-titres exploitables.
        live: ['live', 'upcoming'].includes(v.snippet?.liveBroadcastContent),
      });
    }
  }
  return out;
}

/**
 * Parcourt la playlist des uploads, de la plus récente à la plus ancienne, page par page.
 * `unknownIds(ids)` renvoie ceux qu'on ne connaît pas encore ; on ne demande les détails que pour eux.
 * Le consommateur peut s'arrêter quand il veut (break).
 */
export async function* iterateUploads({ playlistId, unknownIds }) {
  let pageToken;
  do {
    const page = await api('playlistItems', {
      part: 'contentDetails,snippet',
      playlistId,
      maxResults: 50,
      pageToken,
    });
    const ids = (page.items ?? [])
      .filter((it) => !/^(Private|Deleted) video$/.test(it.snippet?.title ?? ''))
      .map((it) => it.contentDetails.videoId);
    const fresh = ids.length ? await unknownIds(ids) : [];
    yield { details: fresh.length ? await videoDetails(fresh) : [] };
    pageToken = page.nextPageToken;
  } while (pageToken);
}

/** Détails d'une vidéo via l'API YouTube (titre, chaîne, date de publication, durée), ou null. */
export async function fetchVideoMeta(youtubeId) {
  if (!youtubeApiConfigured()) return null;
  return (await videoDetails([youtubeId]))[0] ?? null;
}

/**
 * Identifiants des Shorts d'une chaîne, via la playlist interne YouTube « UUSH… » (même identifiant que la
 * chaîne, préfixe UC -> UUSH). Fonctionnement non documenté officiellement : si la playlist est introuvable
 * (chaîne sans Shorts, ou astuce indisponible), on renvoie { ids: vide, found: false } et l'appelant se rabat
 * sur la durée seule.
 */
export async function listShortIds(youtubeChannelId) {
  const playlistId = `UUSH${String(youtubeChannelId).slice(2)}`;
  const ids = new Set();
  let pageToken;
  try {
    do {
      const page = await api('playlistItems', { part: 'contentDetails', playlistId, maxResults: 50, pageToken });
      for (const it of page.items ?? []) if (it.contentDetails?.videoId) ids.add(it.contentDetails.videoId);
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (e) {
    if (e instanceof YouTubeApiError && (e.reason === 'playlistNotFound' || e.status === 404)) return { ids, found: false };
    throw e;
  }
  return { ids, found: true };
}
