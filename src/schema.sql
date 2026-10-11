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
