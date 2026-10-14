data "aws_ssm_parameter" "al2023_arm64" {
  count = var.enable_compute ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

data "aws_ec2_managed_prefix_list" "cloudfront" {
  count = var.enable_compute && var.enable_cdn ? 1 : 0
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_iam_role" "app" {
  count = var.enable_compute ? 1 : 0

  name = "${local.name}-app-host"
  tags = local.tags

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "app" {
  count = var.enable_compute ? 1 : 0

  role       = aws_iam_role.app[0].name
  policy_arn = aws_iam_policy.app.arn
}

# Shell access goes through SSM Session Manager; no SSH port is opened.
resource "aws_iam_role_policy_attachment" "ssm" {
  count = var.enable_compute ? 1 : 0

  role       = aws_iam_role.app[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "app" {
  count = var.enable_compute ? 1 : 0

  name = "${local.name}-app-host"
  role = aws_iam_role.app[0].name
  tags = local.tags
}

resource "aws_security_group" "app" {
  count = var.enable_compute ? 1 : 0

  name        = "${local.name}-app"
  description = "OPSLOG API host: HTTPS in, anything out"
  vpc_id      = var.vpc_id
  tags        = local.tags

  lifecycle {
    precondition {
      condition     = var.vpc_id != null && var.public_subnet_id != null
      error_message = "enable_compute requires vpc_id and public_subnet_id."
    }
  }
}

resource "aws_vpc_security_group_egress_rule" "app_all" {
  count = var.enable_compute ? 1 : 0

  security_group_id = aws_security_group.app[0].id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "app_https_cidr" {
  for_each = var.enable_compute && !var.enable_cdn ? toset(var.ingress_cidrs) : toset([])

  security_group_id = aws_security_group.app[0].id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.value
}

resource "aws_vpc_security_group_ingress_rule" "app_https_cloudfront" {
  count = var.enable_compute && var.enable_cdn ? 1 : 0

  security_group_id = aws_security_group.app[0].id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = data.aws_ec2_managed_prefix_list.cloudfront[0].id
}

resource "aws_instance" "app" {
  count = var.enable_compute ? 1 : 0

  ami                         = data.aws_ssm_parameter.al2023_arm64[0].value
  instance_type               = var.instance_type
  subnet_id                   = var.public_subnet_id
  vpc_security_group_ids      = [aws_security_group.app[0].id]
  iam_instance_profile        = aws_iam_instance_profile.app[0].name
  associate_public_ip_address = false # the Elastic IP below is the only public address
  monitoring                  = false
  tags                        = merge(local.tags, { Name = "${local.name}-app" })

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only
    http_put_response_hop_limit = 1
  }

  root_block_device {
    encrypted   = true
    kms_key_id  = var.enable_kms ? aws_kms_key.main[0].arn : null
    volume_type = "gp3"
    volume_size = 20
  }

  lifecycle {
    ignore_changes = [ami] # AMI refreshes must not replace a running host silently
  }
}

resource "aws_eip" "app" {
  count = var.enable_compute ? 1 : 0

  domain   = "vpc"
  instance = aws_instance.app[0].id
  tags     = local.tags
}

resource "aws_cloudwatch_log_group" "app" {
  count = var.enable_compute ? 1 : 0

  name              = "/${var.project}/${var.environment}/app"
  retention_in_days = local.log_retention_days
  tags              = local.tags
}
