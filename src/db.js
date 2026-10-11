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

export async function initDb() {
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await pool.query(
      'CREATE INDEX IF NOT EXISTS videos_norm_text_trgm ON videos USING gin (norm_text gin_trgm_ops)',
    );
  } catch (e) {
    console.warn(`pg_trgm indisponible, la recherche sera plus lente : ${e.message}`);
  }
}

/**
 * Remplace tous les segments d'une vidéo et recalcule l'index de recherche.
 * `segments` : [{ start_ms, duration_ms?, text }]
 */
export async function replaceSegments(client, videoId, segments, { edited, source } = {}) {
  const clean = segments
    .map((s) => ({
      start_ms: Math.max(0, Math.round(Number(s.start_ms) || 0)),
      duration_ms: s.duration_ms == null ? null : Math.max(0, Math.round(Number(s.duration_ms) || 0)),
      text: String(s.text ?? '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((s) => s.text);
  const { normText, offsets } = buildIndex(clean);

  await client.query('DELETE FROM segments WHERE video_id = $1', [videoId]);
  if (clean.length) {
    await client.query(
      `INSERT INTO segments (video_id, position, start_ms, duration_ms, text, norm_start)
       SELECT $1, t.pos - 1, t.start_ms, t.duration_ms, t.text, t.norm_start
       FROM unnest($2::int[], $3::int[], $4::int[], $5::text[], $6::int[])
         AS t(pos, start_ms, duration_ms, text, norm_start)`,
      [
        videoId,
        clean.map((_, i) => i + 1),
        clean.map((s) => s.start_ms),
        clean.map((s) => s.duration_ms),
        clean.map((s) => s.text),
        offsets,
      ],
    );
  }
  await client.query(
    `UPDATE videos SET norm_text = $2, updated_at = now(),
       edited = COALESCE($3, edited), source = COALESCE($4, source)
     WHERE id = $1`,
    [videoId, normText, edited ?? null, source ?? null],
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
