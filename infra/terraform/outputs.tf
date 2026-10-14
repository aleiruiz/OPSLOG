output "files_bucket" {
  description = "Name of the private files bucket (STORAGE bucket setting for the S3 adapter)."
  value       = aws_s3_bucket.files.bucket
}

output "app_policy_arn" {
  description = "IAM policy to attach to any principal that runs the app."
  value       = aws_iam_policy.app.arn
}

output "app_user_name" {
  description = "IAM user for off-AWS compute, when created. Create its access key with the CLI."
  value       = one(aws_iam_user.app[*].name)
}

output "kms_key_arn" {
  description = "Customer-managed key, when enabled."
  value       = one(aws_kms_key.main[*].arn)
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_issuer_url" {
  description = "OIDC issuer for the BFF verifier."
  value       = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.bff.id
}

output "cognito_client_secret" {
  description = "Confidential client secret. Sensitive: read it with `terraform output -raw`, never commit it."
  value       = aws_cognito_user_pool_client.bff.client_secret
  sensitive   = true
}

output "cognito_hosted_domain" {
  value = one(aws_cognito_user_pool_domain.main[*].domain)
}

output "app_instance_id" {
  value = one(aws_instance.app[*].id)
}

output "app_public_ip" {
  value = one(aws_eip.app[*].public_ip)
}

output "web_bucket" {
  description = "SPA bucket to upload the web build to."
  value       = one(aws_s3_bucket.web[*].bucket)
}

output "cdn_domain_name" {
  value = one(aws_cloudfront_distribution.main[*].domain_name)
}

output "database_endpoint" {
  value = one(aws_db_instance.main[*].address)
}

output "database_master_secret_arn" {
  description = "Secrets Manager secret holding the master credentials."
  value       = one(aws_db_instance.main[*].master_user_secret[0].secret_arn)
}
