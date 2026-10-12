/**
 * Choix des extraits pour le studio de clips : un LLM (OpenRouter) lit la transcription et propose des passages courts
 * (20 à 60 s) qui se comprennent seuls. Il ne choisit que des NUMÉROS DE LIGNES de la transcription : les horaires viennent
 * donc toujours de la transcription, jamais de lui, et il ne peut ni inventer ni modifier un mot.
 *
 * Choix éditorial (le site vérifie des propos, il ne doit pas aider à les détourner) : on demande des extraits clairs et
 * complets, pas les « petites phrases » les plus choquantes, qui commencent et finissent sur une phrase entière sans couper
 * avant une nuance ou une réserve.
 */
import { pool } from './db.js';
import { HttpError } from './http-error.js';
import { LlmError, completeWithOpenRouter } from './openrouter.js';
import { speakerName } from './summarize.js';
import { formatTimestamp } from './transcripts.js';

export const PROMPT_VERSION = 'c1';
// Modèle dédié aux extraits (à vérifier sur https://openrouter.ai/models) : sans raisonnement, qui suit bien des consignes
// éditoriales et rend du JSON fiable, pour peu cher (≈ 0,01 $ par interview). Il ne dépend volontairement pas du modèle des
// résumés / traductions (TRANSLATE_MODEL, SUMMARY_MODEL), qui peut être un modèle « à raisonnement » incapable de répondre ici.
export const DEFAULT_CLIP_MODEL = 'openai/gpt-4.1-mini';
export const clipModel = () => process.env.CLIP_MODEL || DEFAULT_CLIP_MODEL;
export const CLIP_LIMITS = {
  minS: Number(process.env.CLIP_MIN_S) || 20,
  maxS: Number(process.env.CLIP_MAX_S) || 60,
  maxSuggestions: 8,
};
const WINDOW_CHARS = 50_000; // une demande par tranche de transcription de cette taille
const WINDOW_OVERLAP = 12; // lignes reprises d'une tranche à l'autre
const OVERLONG_TOLERANCE_S = 15; // au-delà de maxS + ceci, un extrait est écarté
const FALLBACK_LAST_MS = 4000;
const MAX_GAP_MS = 8000;

const systemPrompt = (perWindow) => `Tu aides à choisir de courts extraits d'une interview de ${speakerName()} pour en faire des vidéos verticales (TikTok, Reels).
Tu reçois la transcription découpée en lignes numérotées « [n] mm:ss texte ». Choisis jusqu'à ${perWindow} extraits.

Règles :
- Un extrait est une suite de lignes consécutives, de la ligne "start" à la ligne "end" incluses, d'une durée de ${CLIP_LIMITS.minS} à ${CLIP_LIMITS.maxS} secondes d'après les repères de temps.
- Il commence au début d'une phrase ou d'une idée et se termine à la fin d'une phrase. Il ne coupe jamais avant un « mais », une nuance, une réserve ou une condition qui change le sens de ce qui est dit.
- Il se comprend seul, sans le reste de l'interview : une idée complète, une position claire, un argument ou une anecdote.
- Choisis pour la clarté et l'intérêt, pas pour le caractère polémique ou choquant : ne cherche pas la « petite phrase ».
- Tu ne fais que choisir des lignes : n'invente rien, ne modifie aucun mot.
- "title" : titre factuel de 70 caractères maximum qui décrit ce que dit ${speakerName()}, sans exagération, sans point d'exclamation, sans question racoleuse.
- "why" : une phrase qui explique l'intérêt de l'extrait.
- "score" : de 1 à 10 (clarté, autonomie, force de l'idée).
- Les extraits ne se chevauchent pas.

Réponds uniquement par un objet JSON, sans texte autour :
{"clips":[{"start":12,"end":31,"title":"…","why":"…","score":8}]}`;

// --- préparation -----------------------------------------------------------------------

/** Segments non vides avec leur fin estimée : { start_ms, end_ms, text }. */
export function prepareSegments(rows) {
  const segs = rows.map((r) => ({ start_ms: Number(r.start_ms) || 0, dur: Number(r.duration_ms) || null, text: String(r.text ?? '').replace(/\s+/g, ' ').trim() })).filter((s) => s.text);
  return segs.map((s, i) => {
    const next = segs[i + 1]?.start_ms;
    let end = s.dur ? s.start_ms + s.dur : next ?? s.start_ms + FALLBACK_LAST_MS;
    if (next != null && end > next) end = next; // pas de chevauchement avec la ligne suivante
    // sans durée connue : une longue pause avant la ligne suivante n'est pas de la parole, on ne l'inclut pas
    if (!s.dur && next != null && end - s.start_ms > MAX_GAP_MS) end = s.start_ms + MAX_GAP_MS;
    return { start_ms: s.start_ms, end_ms: Math.max(end, s.start_ms + 500), text: s.text };
  });
}

/** Tranches de lignes [from, to] (incluses) d'environ WINDOW_CHARS caractères, avec un petit chevauchement. */
export function windowsFor(segs, windowChars = WINDOW_CHARS) {
  const lineLen = (s, i) => `[${i}] 00:00 ${s.text}`.length + 1;
  const windows = [];
  let from = 0;
  while (from < segs.length) {
    let to = from;
    let chars = 0;
    while (to < segs.length && (chars += lineLen(segs[to], to)) <= windowChars) to++;
    to = Math.max(from, to - 1);
    windows.push([from, to]);
    if (to >= segs.length - 1) break;
    from = Math.max(from + 1, to + 1 - WINDOW_OVERLAP);
  }
  return windows;
}

const linesFor = (segs, [from, to]) =>
  segs
    .slice(from, to + 1)
    .map((s, k) => `[${from + k}] ${formatTimestamp(s.start_ms)} ${s.text}`)
    .join('\n');

// --- lecture de la réponse -------------------------------------------------------------

const cleanText = (v, max) => String(v ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Extrait l'objet JSON de la réponse du modèle (tolère les balises ``` et le texte autour). */
export function parseClipJson(raw) {
  const text = String(raw ?? '').replace(/```(?:json)?/gi, '');
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new LlmError('Réponse du modèle illisible (pas de JSON).');
  try {
    const obj = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(obj.clips) ? obj.clips : [];
  } catch {
    throw new LlmError('Réponse du modèle illisible (JSON invalide).');
  }
}

/** Transforme les numéros de lignes du modèle en extrait : horaires issus de la transcription, durée contrôlée. */
export function buildClip(raw, segs, [from, to]) {
  let start = Math.round(Number(raw?.start));
  let end = Math.round(Number(raw?.end));
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start > end) [start, end] = [end, start];
  if (start < from || end > to || start < 0 || end >= segs.length) return null;
  const dur = () => (segs[end].end_ms - segs[start].start_ms) / 1000;
  // trop court : on prolonge jusqu'à la fin de la phrase suivante, sans dépasser la durée maximale
  while (dur() < CLIP_LIMITS.minS && end < Math.min(to, segs.length - 1) && (segs[end + 1].end_ms - segs[start].start_ms) / 1000 <= CLIP_LIMITS.maxS) end++;
  if (dur() < CLIP_LIMITS.minS - 5 || dur() > CLIP_LIMITS.maxS + OVERLONG_TOLERANCE_S) return null;
  const title = cleanText(raw.title, 70).replace(/!+/g, '').trim();
  if (!title) return null;
  const score = Math.min(10, Math.max(1, Math.round(Number(raw.score) || 5)));
  return {
    start_ms: segs[start].start_ms,
    end_ms: segs[end].end_ms,
    duration_s: Math.round(dur() * 10) / 10,
    title,
    why: cleanText(raw.why, 220),
    score,
    text: segs.slice(start, end + 1).map((s) => s.text).join(' ').slice(0, 1800),
  };
}

/** Classe par note, écarte les chevauchements et garde les meilleurs. */
export function mergeClips(clips, max = CLIP_LIMITS.maxSuggestions) {
  const kept = [];
  for (const c of [...clips].sort((a, b) => b.score - a.score || a.start_ms - b.start_ms)) {
    if (kept.some((k) => c.start_ms < k.end_ms && k.start_ms < c.end_ms)) continue;
    kept.push(c);
    if (kept.length >= max) break;
  }
  return kept;
}

// --- génération --------------------------------------------------------------------------

/** Demande des extraits au modèle pour une liste de segments. `complete` est injectable pour les tests. */
export async function suggestClipsFor(rows, { complete = completeWithOpenRouter, model = clipModel() } = {}) {
  const segs = prepareSegments(rows);
  if (segs.length < 3) throw new HttpError(409, 'Transcription trop courte pour proposer des extraits.');
  const windows = windowsFor(segs);
  const perWindow = windows.length === 1 ? CLIP_LIMITS.maxSuggestions : 4;
  const found = [];
  let next = 0;
  const worker = async () => {
    while (next < windows.length) {
      const win = windows[next++];
      const raw = await complete({ model, system: systemPrompt(perWindow), user: linesFor(segs, win), maxTokens: 3000 }, { maxAttempts: 3, timeoutMs: 120_000 });
      for (const c of parseClipJson(raw)) {
        const clip = buildClip(c, segs, win);
        if (clip) found.push(clip);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, windows.length) }, worker));
  return mergeClips(found);
}

/** Génère et mémorise les extraits d'une vidéo. Renvoie { clips, model, created_at }. */
export async function generateClipSuggestions(videoId, deps = {}) {
  const { rows: v } = await pool.query(`SELECT id, text_hash, norm_text <> '' AS has_text FROM videos WHERE id = $1`, [videoId]);
  if (!v[0]) throw new HttpError(404, 'Vidéo introuvable.');
  if (!v[0].has_text) throw new HttpError(409, "Cette vidéo n'a pas de transcription.");
  const { rows } = await pool.query('SELECT start_ms, duration_ms, text FROM segments WHERE video_id = $1 ORDER BY position', [videoId]);
  const model = deps.model ?? clipModel();
  const clips = await suggestClipsFor(rows, { ...deps, model });
  if (!clips.length) throw new LlmError("Le modèle n'a proposé aucun extrait utilisable : réessaie.");
  const content = { prompt_version: PROMPT_VERSION, clips };
  const { rows: saved } = await pool.query(
    `INSERT INTO clip_suggestions (video_id, content, model, text_hash) VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (video_id) DO UPDATE SET content = EXCLUDED.content, model = EXCLUDED.model, text_hash = EXCLUDED.text_hash, created_at = now()
     RETURNING created_at`,
    [videoId, JSON.stringify(content), model, v[0].text_hash],
  );
  return { clips, model, created_at: saved[0].created_at };
}

/** Extraits mémorisés d'une vidéo, avec un drapeau si la transcription a changé depuis. */
export async function getClipSuggestions(videoId) {
  const { rows } = await pool.query(
    `SELECT c.content, c.model, c.created_at, c.text_hash, v.text_hash AS current_hash
     FROM clip_suggestions c JOIN videos v ON v.id = c.video_id WHERE c.video_id = $1`,
    [videoId],
  );
  if (!rows[0]) return null;
  return { clips: rows[0].content.clips ?? [], model: rows[0].model, created_at: rows[0].created_at, outdated: rows[0].text_hash !== rows[0].current_hash };
}
