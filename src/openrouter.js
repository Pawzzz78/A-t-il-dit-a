/**
 * Client minimal pour OpenRouter (API compatible OpenAI) : une seule fonction, sans SDK.
 * Utilisé pour la traduction des transcriptions et la compréhension des questions de recherche.
 */

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// Modèle par défaut : à vérifier sur https://openrouter.ai/models ; se change avec TRANSLATE_MODEL.
export const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite';

export const llmConfigured = () => Boolean(process.env.OPENROUTER_API_KEY);

/** code : 'config' | 'auth' | 'quota' | 'upstream' (mêmes valeurs que TranscriptError, pour la synchro) */
export class LlmError extends Error {
  constructor(message, code = 'upstream') {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Une requête de complétion vers OpenRouter. Renvoie le texte de la réponse.
 * Réessaie (1 s, 2 s, 4 s, jusqu'à `maxAttempts`) sur 429 et 5xx ; les autres erreurs sont classées pour la synchro.
 */
export async function completeWithOpenRouter(
  { model, system, user, maxTokens = 8000 },
  { fetchImpl = fetch, retryDelayMs = 1000, timeoutMs = 120_000, maxAttempts = 4 } = {},
) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new LlmError("OPENROUTER_API_KEY n'est pas configurée.", 'config');
  const body = JSON.stringify({
    model,
    temperature: 0, // traduction littérale, résultat reproductible
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt) await sleep(retryDelayMs * 2 ** (attempt - 1));
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'A-t-il dit ça' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      lastError = new LlmError(`OpenRouter injoignable : ${e.message}`);
      continue;
    }
    const json = await res.json().catch(() => ({}));
    // OpenRouter peut aussi répondre 200 avec un objet `error` quand le fournisseur en amont échoue.
    const apiError = json.error ?? (res.ok ? null : { message: res.statusText });
    if (apiError) {
      const detail = apiError.message ?? JSON.stringify(apiError);
      const status = res.ok ? Number(apiError.code) || 502 : res.status;
      if (status === 401 || status === 403) throw new LlmError(`Clé OpenRouter refusée (${detail}).`, 'auth');
      if (status === 402) throw new LlmError(`Crédits OpenRouter insuffisants (${detail}).`, 'quota');
      if (status === 400 || status === 404) {
        const code = /model/i.test(detail) ? 'config' : 'upstream';
        throw new LlmError(code === 'config' ? `Modèle de traduction refusé : vérifie TRANSLATE_MODEL (${detail}).` : `Requête refusée (${detail}).`, code);
      }
      lastError = new LlmError(`OpenRouter : ${detail}`, status === 429 ? 'quota' : 'upstream');
      continue; // 429, 5xx, erreurs en amont : on réessaie
    }
    const choice = json.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      lastError = new LlmError('Réponse OpenRouter vide.');
      continue;
    }
    return text;
  }
  throw lastError ?? new LlmError('Traduction impossible.');
}
