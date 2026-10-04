CREATE TABLE opslog_harness_records (
  local_id INT NOT NULL PRIMARY KEY,
  value VARCHAR(64) NOT NULL,
  version INT NOT NULL DEFAULT 1
);
