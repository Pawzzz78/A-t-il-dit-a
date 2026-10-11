CREATE TABLE IF NOT EXISTS videos (
  id            SERIAL PRIMARY KEY,
  youtube_id    TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  channel       TEXT NOT NULL DEFAULT '',
  published_at  DATE,
  thumbnail_url TEXT,
  lang          TEXT,
  source        TEXT NOT NULL DEFAULT 'manual',   -- 'supadata' | 'manual'
  edited        BOOLEAN NOT NULL DEFAULT FALSE,   -- transcription corrigée à la main
  norm_text     TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS segments (
  id          SERIAL PRIMARY KEY,
  video_id    INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  start_ms    INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  text        TEXT NOT NULL,
  norm_start  INTEGER NOT NULL DEFAULT -1,
  UNIQUE (video_id, position)
);

-- Synchronisation automatique des chaînes YouTube ---------------------------------
-- sync_status : NULL = vidéo ajoutée à la main (jamais touchée par la synchro),
--               'pending' = en file d'attente, 'done' = transcrite, 'failed' = abandonnée.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS sync_status   TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS sync_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS sync_next_at  TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS sync_error    TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS channel_id    TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS duration_s    INTEGER;
CREATE INDEX IF NOT EXISTS videos_sync_pending ON videos (sync_next_at) WHERE sync_status = 'pending';

CREATE TABLE IF NOT EXISTS channels (
  id                    SERIAL PRIMARY KEY,
  youtube_channel_id    TEXT UNIQUE NOT NULL,
  title                 TEXT NOT NULL DEFAULT '',
  handle                TEXT,
  uploads_playlist_id   TEXT NOT NULL,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  min_duration_s        INTEGER NOT NULL DEFAULT 0,
  backfilled_at         TIMESTAMPTZ,              -- NULL tant que tout l'historique n'a pas été listé
  discovery_due_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_discovery_at     TIMESTAMPTZ,
  last_discovery_error  TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Vidéos que la synchro ne doit jamais (ré)ajouter : supprimées à la main, trop courtes…
CREATE TABLE IF NOT EXISTS excluded_videos (
  youtube_id TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- Traduction automatique des transcriptions -------------------------------------------
-- videos.lang = langue du texte stocké ; original_lang = langue d'origine quand il a été traduit.
-- segments.text_original = texte d'origine (avant traduction), conservé pour vérification.
ALTER TABLE videos   ADD COLUMN IF NOT EXISTS original_lang TEXT;
ALTER TABLE videos   ADD COLUMN IF NOT EXISTS translated    BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE segments ADD COLUMN IF NOT EXISTS text_original TEXT;

-- Résumés générés par IA (un par vidéo, régénéré si la transcription change) -------------
CREATE TABLE IF NOT EXISTS video_summaries (
  video_id    INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  model       TEXT NOT NULL,
  source_hash TEXT NOT NULL,                 -- md5 du texte indexé au moment de la génération
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shorts : exclus par défaut (durée <= 60 s ou présents dans la liste des Shorts YouTube de la chaîne).
ALTER TABLE channels ADD COLUMN IF NOT EXISTS exclude_shorts BOOLEAN NOT NULL DEFAULT TRUE;

-- Résumés automatiques : empreinte de la transcription (comparée à celle du résumé) et suivi des tentatives -------
ALTER TABLE videos ADD COLUMN IF NOT EXISTS text_hash        TEXT;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS summary_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS summary_next_at  TIMESTAMPTZ;
ALTER TABLE videos ADD COLUMN IF NOT EXISTS summary_error    TEXT;
UPDATE videos SET text_hash = md5(norm_text) WHERE text_hash IS NULL AND norm_text <> '';
