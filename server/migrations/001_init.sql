-- Accounts
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  nickname      TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email ON users (lower(email));
CREATE INDEX users_nickname ON users (lower(nickname) text_pattern_ops);

-- Long-lived login tokens (stored hashed). Revoked on logout / password reset.
CREATE TABLE refresh_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX refresh_tokens_user ON refresh_tokens (user_id);

-- Practice history synced between devices (one row per practice session).
CREATE TABLE practice_sessions (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at BIGINT NOT NULL,
  data       JSONB NOT NULL,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, started_at)
);

-- Best daily-challenge result per user and day (server-judged).
CREATE TABLE daily_scores (
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day       DATE NOT NULL,
  score     INT NOT NULL,
  result    JSONB NOT NULL,
  attempts  INT NOT NULL DEFAULT 1,
  best_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
CREATE INDEX daily_scores_day ON daily_scores (day, score DESC);

-- Friends: requests, then a symmetric pair of rows once accepted.
CREATE TABLE friend_requests (
  id         BIGSERIAL PRIMARY KEY,
  from_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id)
);
CREATE TABLE friendships (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id)
);

-- Asynchronous PK: both players play the same chart before it expires.
CREATE TABLE pk_matches (
  id                BIGSERIAL PRIMARY KEY,
  challenger_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opponent_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spec              JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open', -- open | declined | done
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  challenger_result JSONB,
  opponent_result   JSONB
);
CREATE INDEX pk_matches_challenger ON pk_matches (challenger_id, created_at DESC);
CREATE INDEX pk_matches_opponent ON pk_matches (opponent_id, created_at DESC);
