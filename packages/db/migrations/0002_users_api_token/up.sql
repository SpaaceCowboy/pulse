ALTER TABLE users
  ADD COLUMN api_token_hash text UNIQUE,
  ADD COLUMN totp_last_step bigint,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
