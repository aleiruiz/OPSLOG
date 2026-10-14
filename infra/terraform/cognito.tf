resource "aws_cognito_user_pool" "main" {
  name                = local.name
  user_pool_tier      = var.cognito_user_pool_tier
  deletion_protection = var.cognito_deletion_protection ? "ACTIVE" : "INACTIVE"
  mfa_configuration   = var.cognito_mfa

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # Invite-only: users are created by OPSLOG (admin-create), never self-registered.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 3 # invitations expire at 72h (SPECS)
  }

  dynamic "software_token_mfa_configuration" {
    for_each = var.cognito_mfa == "OFF" ? [] : [1]

    content {
      enabled = true
    }
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  tags = local.tags
}

resource "aws_cognito_user_pool_client" "bff" {
  name         = "${var.project}-bff-${var.environment}"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret                      = true
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]
  callback_urls                        = var.cognito_callback_urls
  logout_urls                          = var.cognito_logout_urls
  explicit_auth_flows                  = ["ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true
}

resource "aws_cognito_user_pool_domain" "main" {
  count = var.cognito_domain_prefix == "" ? 0 : 1

  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.main.id
}
