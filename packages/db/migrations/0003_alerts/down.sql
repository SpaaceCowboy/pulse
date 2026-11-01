DROP INDEX heartbeats_check_id_key;
ALTER TABLE heartbeats
  DROP COLUMN last_status,
  DROP COLUMN last_message,
  DROP COLUMN created_at;
DROP INDEX users_telegram_chat_id_key;
DROP TABLE mutes;
DROP TABLE alert_messages;
