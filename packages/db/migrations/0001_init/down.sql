DROP TABLE users;
DROP TABLE error_events;
DROP TABLE host_metrics;
DROP TABLE heartbeats;
DROP TABLE incidents;
DROP TABLE results_hourly;
-- dropping the parent drops every partition, including check_results_default
DROP TABLE check_results;
DROP TABLE checks;
DROP TABLE targets;
DROP TYPE check_status;
DROP TYPE role;
DROP TYPE audience;
