CREATE TABLE IF NOT EXISTS opslog_tenant_metadata (
  tenant_id VARCHAR(128) NOT NULL,
  created_at TIMESTAMP(6) NOT NULL,
  updated_at TIMESTAMP(6) NOT NULL,
  PRIMARY KEY (tenant_id)
) ENGINE=InnoDB;
