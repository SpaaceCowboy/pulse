ALTER TABLE users
  DROP COLUMN api_token_hash,
  DROP COLUMN totp_last_step,
  DROP COLUMN created_at;
