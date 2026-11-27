-- EasyRanked :: SQLite schema
-- Persistance : comptes, progression (1-100), classes Gunsmith, statistiques.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash   TEXT    NOT NULL,
    token           TEXT             UNIQUE,
    token_expires   INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);

CREATE TABLE IF NOT EXISTS progression (
    user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    level           INTEGER NOT NULL DEFAULT 1,
    xp              INTEGER NOT NULL DEFAULT 0,       -- XP cumulee dans le niveau courant
    xp_total        INTEGER NOT NULL DEFAULT 0,
    kills           INTEGER NOT NULL DEFAULT 0,
    deaths          INTEGER NOT NULL DEFAULT 0,
    headshots       INTEGER NOT NULL DEFAULT 0,
    damage_dealt    INTEGER NOT NULL DEFAULT 0,
    matches_played  INTEGER NOT NULL DEFAULT 0,
    matches_won     INTEGER NOT NULL DEFAULT 0,
    best_streak     INTEGER NOT NULL DEFAULT 0,
    time_played     INTEGER NOT NULL DEFAULT 0        -- secondes
);

-- Une classe = une arme + 5 slots d'accessoires + camo. 5 classes max par joueur.
CREATE TABLE IF NOT EXISTS loadouts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot            INTEGER NOT NULL,                 -- 0..4
    name            TEXT    NOT NULL DEFAULT 'Classe',
    weapon          TEXT    NOT NULL DEFAULT 'mk18',
    att_optic       TEXT    NOT NULL DEFAULT '',
    att_barrel      TEXT    NOT NULL DEFAULT '',
    att_muzzle      TEXT    NOT NULL DEFAULT '',
    att_stock       TEXT    NOT NULL DEFAULT '',
    att_laser       TEXT    NOT NULL DEFAULT '',
    att_grip        TEXT    NOT NULL DEFAULT '',
    att_mag         TEXT    NOT NULL DEFAULT '',
    camo            TEXT    NOT NULL DEFAULT 'default',
    updated_at      INTEGER NOT NULL DEFAULT 0,
    UNIQUE(user_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_loadouts_user ON loadouts(user_id);

CREATE TABLE IF NOT EXISTS matches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    mode            TEXT    NOT NULL,                 -- 1v1 / 2v2 / 3v3 / 4v4
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER NOT NULL DEFAULT 0,
    score_a         INTEGER NOT NULL DEFAULT 0,
    score_b         INTEGER NOT NULL DEFAULT 0,
    with_bots       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS match_players (
    match_id        INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    user_id         INTEGER          REFERENCES users(id) ON DELETE SET NULL,
    display_name    TEXT    NOT NULL,
    team            INTEGER NOT NULL,
    kills           INTEGER NOT NULL DEFAULT 0,
    deaths          INTEGER NOT NULL DEFAULT 0,
    damage          INTEGER NOT NULL DEFAULT 0,
    xp_earned       INTEGER NOT NULL DEFAULT 0,
    is_bot          INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (match_id, display_name)
);
