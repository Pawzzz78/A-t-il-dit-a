import { pool } from './db.js';

export async function getSetting(key, fallback) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : fallback;
}

export async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)],
  );
}

/** Mémorise la dernière erreur d'un appel au modèle (affichée dans l'admin). Ne lève jamais d'erreur. */
export async function recordLlmError(feature, model, message) {
  try {
    await setSetting('llm_last_error', { at: new Date().toISOString(), feature, model, message: String(message).slice(0, 400) });
  } catch {
    // sans importance : le message est aussi dans les journaux
  }
}
