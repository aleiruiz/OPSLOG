resource "aws_kms_key" "main" {
  count = var.enable_kms ? 1 : 0

  description             = "${local.name} data key (bucket objects and personal-data encryption)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = local.tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "main" {
  count = var.enable_kms ? 1 : 0

  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.main[0].key_id
}
