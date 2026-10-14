resource "aws_db_subnet_group" "main" {
  count = var.enable_database ? 1 : 0

  name       = local.name
  subnet_ids = var.database_subnet_ids
  tags       = local.tags

  lifecycle {
    precondition {
      condition     = length(var.database_subnet_ids) >= 2 && var.vpc_id != null
      error_message = "enable_database requires vpc_id and at least two database_subnet_ids."
    }
  }
}

resource "aws_security_group" "database" {
  count = var.enable_database ? 1 : 0

  name        = "${local.name}-db"
  description = "OPSLOG database: MySQL from the API host only"
  vpc_id      = var.vpc_id
  tags        = local.tags
}

resource "aws_vpc_security_group_ingress_rule" "database_from_app" {
  count = var.enable_database && var.enable_compute ? 1 : 0

  security_group_id            = aws_security_group.database[0].id
  referenced_security_group_id = aws_security_group.app[0].id
  ip_protocol                  = "tcp"
  from_port                    = 3306
  to_port                      = 3306
}

# Stage 0 reuses an existing RDS: open its security group to the instance, nothing else.
resource "aws_vpc_security_group_ingress_rule" "existing_database_from_app" {
  count = var.enable_compute && var.existing_database_security_group_id != null ? 1 : 0

  security_group_id            = var.existing_database_security_group_id
  referenced_security_group_id = aws_security_group.app[0].id
  ip_protocol                  = "tcp"
  from_port                    = 3306
  to_port                      = 3306
}

resource "aws_db_instance" "main" {
  count = var.enable_database ? 1 : 0

  identifier                  = local.name
  engine                      = "mysql"
  engine_version              = var.database_engine_version
  engine_lifecycle_support    = "open-source-rds-extended-support-disabled"
  instance_class              = var.database_instance_class
  allocated_storage           = var.database_allocated_storage
  storage_type                = "gp3"
  storage_encrypted           = true
  kms_key_id                  = var.enable_kms ? aws_kms_key.main[0].arn : null
  db_name                     = replace(var.project, "-", "_")
  username                    = "opslog_admin"
  manage_master_user_password = true # secret lives in Secrets Manager, never in state or git
  db_subnet_group_name        = aws_db_subnet_group.main[0].name
  vpc_security_group_ids      = [aws_security_group.database[0].id]
  publicly_accessible         = false
  multi_az                    = false # Single-AZ until ADR-0012 stage 3
  backup_retention_period     = local.backup_retention_days
  deletion_protection         = true
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${local.name}-final"
  tags                        = local.tags
}
