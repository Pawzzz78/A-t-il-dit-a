import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { buildIndex } from './normalize.js';

const { Pool } = pg;

// DATE -> 'AAAA-MM-JJ' tel quel (pas de conversion de fuseau côté JS).
pg.types.setTypeParser(1082, (v) => v);

const url = process.env.DATABASE_URL;
const local = !url || /@(localhost|127\.0\.0\.1)[:/]/.test(url);

export const pool = new Pool({
  connectionString: url,
  // Railway : la connexion interne (*.railway.internal) n'utilise pas TLS ; la publique oui.
  ssl: local || /railway\.internal/.test(url) ? false : { rejectUnauthorized: false },
  max: 10,
});

/** Découpe schema.sql en instructions (les commentaires de ligne entière sont ignorés). */
export function splitStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((st) => st.trim())
    .filter(Boolean);
}

/**
 * Exécute une instruction du schéma. Les « ADD COLUMN IF NOT EXISTS » et « CREATE INDEX IF NOT EXISTS » sont
 * ignorés quand l'objet existe déjà : même sans rien changer, ces instructions verrouillent la table, ce qui peut
 * bloquer (ou provoquer un « deadlock » avec) une autre copie du serveur en train d'écrire pendant un déploiement.
 */
async function applyStatement(client, st) {
  const col = st.match(/^ALTER TABLE\s+(\w+)\s+ADD COLUMN IF NOT EXISTS\s+(\w+)/i);
  if (col) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2',
      [col[1], col[2]],
    );
    if (rowCount) return;
  }
  const idx = st.match(/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+(\w+)/i);
  if (idx) {
    const { rowCount } = await client.query('SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = $1', [idx[1]]);
    if (rowCount) return;
  }
  await client.query(st);
}

export async function initDb() {
  const statements = splitStatements(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  // Un seul démarrage à la fois ; chaque instruction est validée séparément (pas de verrous cumulés).
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727002)');
    await client.query("SET lock_timeout = '15s'");
    for (const st of statements) await applyStatement(client, st);
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await applyStatement(
        client,
        'CREATE INDEX IF NOT EXISTS videos_norm_text_trgm ON videos USING gin (norm_text gin_trgm_ops)',
      );
    } catch (e) {
      console.warn(`pg_trgm indisponible, la recherche sera plus lente : ${e.message}`);
    }
  } finally {
    await client.query('RESET lock_timeout').catch(() => {});
    await client.query('SELECT pg_advisory_unlock(727002)').catch(() => {});
    client.release();
  }
}

/**
 * Remplace tous les segments d'une vidéo et recalcule l'index de recherche.
 * `segments` : [{ start_ms, duration_ms?, text }]
 */
export async function replaceSegments(client, videoId, segments, { edited, source, translated, originalLang } = {}) {
  const clean = segments
    .map((s) => ({
      start_ms: Math.max(0, Math.round(Number(s.start_ms) || 0)),
      duration_ms: s.duration_ms == null ? null : Math.max(0, Math.round(Number(s.duration_ms) || 0)),
      text: String(s.text ?? '').replace(/\s+/g, ' ').trim(),
      text_original: s.text_original ? String(s.text_original).replace(/\s+/g, ' ').trim() : null,
    }))
    .filter((s) => s.text);
  const { normText, offsets } = buildIndex(clean);

  await client.query('DELETE FROM segments WHERE video_id = $1', [videoId]);
  if (clean.length) {
    await client.query(
      `INSERT INTO segments (video_id, position, start_ms, duration_ms, text, norm_start, text_original)
       SELECT $1, t.pos - 1, t.start_ms, t.duration_ms, t.text, t.norm_start, t.text_original
       FROM unnest($2::int[], $3::int[], $4::int[], $5::text[], $6::int[], $7::text[])
         AS t(pos, start_ms, duration_ms, text, norm_start, text_original)`,
      [
        videoId,
        clean.map((_, i) => i + 1),
        clean.map((s) => s.start_ms),
        clean.map((s) => s.duration_ms),
        clean.map((s) => s.text),
        offsets,
        clean.map((s) => s.text_original),
      ],
    );
  }
  await client.query(
    `UPDATE videos SET norm_text = $2, updated_at = now(),
       text_hash = CASE WHEN $2 = '' THEN NULL ELSE md5($2) END,
       edited = COALESCE($3, edited), source = COALESCE($4, source),
       -- une vidéo qui a maintenant une transcription n'a plus rien à attendre de la synchro
       sync_status = CASE WHEN $5 AND sync_status IN ('pending', 'failed') THEN 'done' ELSE sync_status END,
       sync_error = CASE WHEN $5 THEN NULL ELSE sync_error END,
       -- transcription nouvelle ou modifiée : le résumé sera (re)généré, on repart de zéro côté tentatives
       summary_attempts = CASE WHEN $5 THEN 0 ELSE summary_attempts END,
       summary_next_at = CASE WHEN $5 THEN NULL ELSE summary_next_at END,
       summary_error = CASE WHEN $5 THEN NULL ELSE summary_error END,
       translated = COALESCE($6::boolean, translated),
       original_lang = CASE WHEN $6::boolean IS NULL THEN original_lang ELSE $7 END
     WHERE id = $1`,
    [videoId, normText, edited ?? null, source ?? null, clean.length > 0, translated ?? null, originalLang ?? null],
  );
  return clean.length;
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
