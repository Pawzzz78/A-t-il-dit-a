/**
 * Téléchargement d'un fichier sans jamais sortir des hôtes autorisés : chaque redirection est vérifiée avant d'être suivie, et le
 * corps est lu en comptant les octets (coupé au-delà de la taille maximale, même sans en-tête Content-Length).
 */
export class DownloadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // host | network | status | type | size | empty | redirects
  }
}

async function readLimited(res, maxBytes) {
  if (!res.body?.getReader) return Buffer.from(await res.arrayBuffer());
  const chunks = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new DownloadError('size', 'fichier trop lourd');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * `allowed(url)` : l'adresse (objet URL) peut-elle être appelée ? `accept` : types de contenu acceptés. Renvoie le contenu (Buffer).
 */
export async function safeDownload(url, { allowed, accept, maxBytes, fetchImpl = fetch, timeoutMs = 30_000, maxHops = 4 }) {
  let current = url;
  for (let hop = 0; hop < maxHops; hop++) {
    let u;
    try {
      u = new URL(current);
    } catch {
      throw new DownloadError('host', 'adresse invalide');
    }
    if (!allowed(u)) throw new DownloadError('host', 'adresse non autorisée');
    let res;
    try {
      res = await fetchImpl(u, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new DownloadError('network', 'téléchargement impossible');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel?.().catch(() => {});
      current = new URL(res.headers.get('location'), u).href;
      continue;
    }
    const fail = async (code, message) => {
      await res.body?.cancel?.().catch(() => {});
      return new DownloadError(code, message);
    };
    if (!res.ok) throw await fail('status', `erreur ${res.status}`);
    if (!accept.test(res.headers.get('content-type') ?? '')) throw await fail('type', 'fichier inattendu');
    if (Number(res.headers.get('content-length')) > maxBytes) throw await fail('size', 'fichier trop lourd');
    const buf = await readLimited(res, maxBytes);
    if (!buf.length) throw new DownloadError('empty', 'fichier vide');
    return buf;
  }
  throw new DownloadError('redirects', 'trop de redirections');
}
