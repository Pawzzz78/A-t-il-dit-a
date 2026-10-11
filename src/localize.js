import { fetchTranscript } from './transcripts.js';
import { baseLang, translateConfigured, translateSegments } from './translate.js';

/**
 * Récupère la transcription dans la langue demandée.
 * Supadata renvoie la 1re langue disponible quand celle demandée n'existe pas : dans ce cas on traduit
 * (si ANTHROPIC_API_KEY est configurée), sinon on garde le texte d'origine en le signalant.
 * Renvoie { segments, lang, translated, originalLang, untranslated }.
 */
export async function fetchLocalized(youtubeId, lang = 'fr', deps = {}) {
  const fetchFn = deps.fetchFn ?? fetchTranscript;
  const translateFn = deps.translateFn ?? translateSegments;
  const configured = deps.translateConfigured ?? translateConfigured;

  const t = await fetchFn(youtubeId, lang);
  const want = baseLang(lang);
  const got = baseLang(t.lang);
  if (!want || !got || want === got) {
    return { segments: t.segments, lang: t.lang, translated: false, originalLang: null, untranslated: false };
  }
  if (!configured()) {
    return { segments: t.segments, lang: t.lang, translated: false, originalLang: null, untranslated: true };
  }
  const segments = await translateFn(t.segments, { from: got, to: want });
  return { segments, lang: want, translated: true, originalLang: got, untranslated: false };
}
