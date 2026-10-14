locals {
  name = "${var.project}-${var.environment}"

  tags = merge(var.extra_tags, {
    proyecto    = var.project
    entorno     = var.environment
    etapa       = tostring(var.stage)
    propietario = var.owner
  })

  # Defaults that grow with the ADR-0012 stage.
  log_retention_days    = { 0 = 14, 1 = 14, 2 = 30 }[var.stage]
  backup_retention_days = { 0 = 1, 1 = 1, 2 = 7 }[var.stage]
  bucket_name           = "${var.project}-files-${var.environment}-${var.name_suffix}"
  web_bucket_name       = "${var.project}-web-${var.environment}-${var.name_suffix}"
}
