# Least privilege (infra/storage validateAppPolicy): object CRUD under tenants/* only, no bucket-wide
# or "*/*" resources, no list/delete-bucket.
data "aws_iam_policy_document" "app" {
  statement {
    sid       = "TenantObjects"
    effect    = "Allow"
    actions   = concat(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], var.allow_object_tagging ? ["s3:PutObjectTagging"] : [])
    resources = ["${aws_s3_bucket.files.arn}/tenants/*"]
  }

  dynamic "statement" {
    for_each = var.enable_kms ? [1] : []

    content {
      sid       = "DataKey"
      effect    = "Allow"
      actions   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt"]
      resources = [aws_kms_key.main[0].arn]
    }
  }
}

resource "aws_iam_policy" "app" {
  name   = "${var.project}-app-${var.environment}"
  policy = data.aws_iam_policy_document.app.json
  tags   = local.tags
}

resource "aws_iam_user" "app" {
  count = var.create_app_user ? 1 : 0

  name = "${var.project}-app-${var.environment}"
  tags = local.tags
}

resource "aws_iam_user_policy_attachment" "app" {
  count = var.create_app_user ? 1 : 0

  user       = aws_iam_user.app[0].name
  policy_arn = aws_iam_policy.app.arn
}
