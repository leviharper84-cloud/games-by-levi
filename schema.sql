-- Games by Levi database. Safe to run more than once.

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT    NOT NULL,
  username_lc TEXT    NOT NULL UNIQUE,
  pass_hash   TEXT    NOT NULL,
  salt        TEXT    NOT NULL,
  iterations  INTEGER NOT NULL,
  avatar_i    INTEGER NOT NULL DEFAULT 0,
  avatar_c    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS scores (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game    TEXT    NOT NULL,
  score   INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, game)
);
CREATE INDEX IF NOT EXISTS scores_by_game ON scores(game, score DESC, at ASC);

CREATE TABLE IF NOT EXISTS submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT    NOT NULL,
  creator     TEXT    NOT NULL,
  genre       TEXT    NOT NULL,
  blurb       TEXT    NOT NULL DEFAULT '',
  code        TEXT    NOT NULL,
  size        INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  approved_at INTEGER
);
CREATE INDEX IF NOT EXISTS submissions_by_status ON submissions(status, created_at);

-- Rate limits for logins, sign-ups, scores and submissions.
CREATE TABLE IF NOT EXISTS rate (
  key   TEXT    PRIMARY KEY,
  count INTEGER NOT NULL,
  since INTEGER NOT NULL
);
