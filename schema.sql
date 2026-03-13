-- Stick Fighter: ELO & Leaderboard schema
-- Run once against a fresh Postgres database.

CREATE TABLE IF NOT EXISTS players (
    user_id   TEXT PRIMARY KEY,
    name      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS elo_ratings (
    user_id   TEXT NOT NULL REFERENCES players(user_id) ON DELETE CASCADE,
    category  TEXT NOT NULL CHECK (category IN ('voice', 'keyboard')),
    rating    REAL NOT NULL DEFAULT 1000,
    wins      INTEGER NOT NULL DEFAULT 0,
    losses    INTEGER NOT NULL DEFAULT 0,
    draws     INTEGER NOT NULL DEFAULT 0,
    matches   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, category)
);

CREATE INDEX IF NOT EXISTS idx_elo_category_rating
    ON elo_ratings (category, rating DESC);

CREATE TABLE IF NOT EXISTS match_history (
    id                    SERIAL PRIMARY KEY,
    winner_id             TEXT REFERENCES players(user_id),
    loser_id              TEXT REFERENCES players(user_id),
    category              TEXT NOT NULL CHECK (category IN ('voice', 'keyboard')),
    winner_rating_before  REAL NOT NULL,
    loser_rating_before   REAL NOT NULL,
    winner_rating_after   REAL NOT NULL,
    loser_rating_after    REAL NOT NULL,
    draw                  BOOLEAN NOT NULL DEFAULT FALSE,
    played_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_match_history_played_at
    ON match_history (played_at DESC);
