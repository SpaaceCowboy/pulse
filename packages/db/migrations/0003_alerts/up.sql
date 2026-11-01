-- Phase 4: alert delivery bookkeeping, mutes, heartbeat state.
CREATE TABLE alert_messages (
  id bigserial PRIMARY KEY,
  incident_id bigint NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('telegram', 'email')),
  chat_id text,
  message_id bigint,
  sent_at timestamptz NOT NULL DEFAULT now(),
  resolved_sent_at timestamptz,
  UNIQUE (incident_id, user_id)
);

CREATE TABLE mutes (
  target_id text PRIMARY KEY,
  until timestamptz NOT NULL,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- a chat can be linked to at most one account
CREATE UNIQUE INDEX users_telegram_chat_id_key ON users (telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;

-- heartbeats.token now holds the SHA-256 of the push token (the token itself is shown once)
ALTER TABLE heartbeats
  ADD COLUMN last_status text,
  ADD COLUMN last_message text,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX heartbeats_check_id_key ON heartbeats (check_id);
