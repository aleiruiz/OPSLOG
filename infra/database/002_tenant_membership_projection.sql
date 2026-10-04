CREATE TABLE IF NOT EXISTS opslog_tenant_membership_projection (
  tenant_id VARCHAR(128) NOT NULL,
  subject_ref VARCHAR(255) NOT NULL,
  membership_version BIGINT UNSIGNED NOT NULL,
  status ENUM('active', 'revoked') NOT NULL,
  updated_at TIMESTAMP(6) NOT NULL,
  PRIMARY KEY (tenant_id, subject_ref),
  UNIQUE KEY uq_membership_version (tenant_id, membership_version)
) ENGINE=InnoDB;
