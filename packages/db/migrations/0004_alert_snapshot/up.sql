-- An alert message remembers what it was about, so it can still be edited ("removed from monitoring") after its
-- check has left targets.yaml and the incident no longer joins to a target. Additive, nullable: old rows keep NULL.
ALTER TABLE alert_messages
  ADD COLUMN target_name text,
  ADD COLUMN check_kind text;
