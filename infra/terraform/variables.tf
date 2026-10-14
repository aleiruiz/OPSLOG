# ---- Identity of the deployment -------------------------------------------------------------

variable "region" {
  description = "AWS region for every resource. No default: the operator chooses it."
  type        = string
}

variable "project" {
  description = "Project tag and name prefix."
  type        = string
  default     = "opslog"
}

variable "environment" {
  description = "Environment name, used in names and tags (for example demo, staging, production)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.environment))
    error_message = "environment must be 2-21 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "stage" {
  description = "ADR-0012 stage (0-2 are implemented here; 3-4 need Fargate/ALB and are out of scope). Drives retention and availability defaults."
  type        = number
  default     = 0

  validation {
    condition     = contains([0, 1, 2], var.stage)
    error_message = "stage must be 0, 1 or 2."
  }
}

variable "owner" {
  description = "Value of the mandatory `propietario` cost-allocation tag."
  type        = string
}

variable "name_suffix" {
  description = "Globally unique suffix for the S3 bucket name (for example the AWS account id, passed in by the operator)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,30}$", var.name_suffix))
    error_message = "name_suffix must be lowercase letters, digits or hyphens."
  }
}

variable "extra_tags" {
  description = "Additional tags merged into the mandatory ones."
  type        = map(string)
  default     = {}
}

# ---- Component toggles ----------------------------------------------------------------------

variable "enable_kms" {
  description = "Create one customer-managed KMS key (SSE-KMS on the bucket, personal-data encryption). When false the bucket uses SSE-S3."
  type        = bool
  default     = true
}

variable "enable_compute" {
  description = "Create one small EC2 instance (stage 0 shape) for the API/BFF and worker."
  type        = bool
  default     = false
}

variable "enable_cdn" {
  description = "Create a private SPA bucket plus a CloudFront distribution in front of it. Only meaningful with enable_compute."
  type        = bool
  default     = false
}

variable "enable_database" {
  description = "Create a Single-AZ MySQL RDS instance. Leave false to reuse an existing database (ADR-0012 stage 0)."
  type        = bool
  default     = false
}

variable "create_app_user" {
  description = "Create an IAM user carrying the app policy, for compute outside AWS. Terraform does not create access keys (they would land in state); create them with the CLI."
  type        = bool
  default     = false
}

# ---- Storage --------------------------------------------------------------------------------

variable "quarantine_expiry_days" {
  description = "Days after which objects tagged opslog-area=quarantine expire (matches infra/storage)."
  type        = number
  default     = 7

  validation {
    condition     = var.quarantine_expiry_days >= 1
    error_message = "quarantine objects need an expiry of at least one day."
  }
}

variable "noncurrent_version_expiry_days" {
  description = "Days after which non-current object versions are deleted."
  type        = number
  default     = 90
}

variable "allow_object_tagging" {
  description = "Add s3:PutObjectTagging to the app policy so the S3 adapter can tag quarantine uploads (needed for the quarantine lifecycle rule)."
  type        = bool
  default     = true
}

variable "cors_allowed_origins" {
  description = "Origins allowed to use presigned URLs from a browser. Empty means no CORS configuration."
  type        = list(string)
  default     = []
}

# ---- Cognito --------------------------------------------------------------------------------

variable "cognito_callback_urls" {
  description = "OIDC redirect URIs of the BFF (authorization code + PKCE)."
  type        = list(string)
}

variable "cognito_logout_urls" {
  description = "Allowed sign-out URLs."
  type        = list(string)
  default     = []
}

variable "cognito_domain_prefix" {
  description = "Prefix of the hosted Cognito domain (globally unique per region). Empty skips the domain."
  type        = string
  default     = ""
}

variable "cognito_user_pool_tier" {
  description = "Cognito feature plan: LITE, ESSENTIALS or PLUS."
  type        = string
  default     = "LITE"

  validation {
    condition     = contains(["LITE", "ESSENTIALS", "PLUS"], var.cognito_user_pool_tier)
    error_message = "tier must be LITE, ESSENTIALS or PLUS."
  }
}

variable "cognito_mfa" {
  description = "TOTP MFA mode: OFF, OPTIONAL or ON. Per-tenant enforcement is done by OPSLOG, not by the pool."
  type        = string
  default     = "OPTIONAL"

  validation {
    condition     = contains(["OFF", "OPTIONAL", "ON"], var.cognito_mfa)
    error_message = "cognito_mfa must be OFF, OPTIONAL or ON."
  }
}

variable "cognito_deletion_protection" {
  description = "Protect the user pool from deletion."
  type        = bool
  default     = true
}

# ---- Compute / network (only used when the matching toggle is on) ---------------------------

variable "vpc_id" {
  description = "VPC for compute and database. Required with enable_compute or enable_database."
  type        = string
  default     = null
}

variable "public_subnet_id" {
  description = "Public subnet for the instance (stage 0 has no NAT). Required with enable_compute."
  type        = string
  default     = null
}

variable "instance_type" {
  description = "Instance type for the API host (ADR-0012: t4g.nano or t4g.micro)."
  type        = string
  default     = "t4g.micro"
}

variable "ingress_cidrs" {
  description = "CIDRs allowed to reach HTTPS on the instance when there is no CloudFront. Empty means no inbound rule."
  type        = list(string)
  default     = []
}

variable "database_subnet_ids" {
  description = "At least two private subnets in different AZs for the DB subnet group. Required with enable_database."
  type        = list(string)
  default     = []
}

variable "database_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "database_allocated_storage" {
  description = "RDS storage in GiB."
  type        = number
  default     = 20
}

variable "existing_database_security_group_id" {
  description = "Security group of an existing RDS to open to the instance on 3306 (stage 0 reuse). Rule is added only when set together with enable_compute."
  type        = string
  default     = null
}

variable "cdn_aliases" {
  description = "Custom domain names for CloudFront. Requires acm_certificate_arn (in us-east-1)."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ACM certificate (us-east-1) for cdn_aliases. Null uses the default CloudFront certificate."
  type        = string
  default     = null
}

variable "api_origin_domain" {
  description = "DNS name (with a valid TLS certificate) CloudFront uses to reach the instance. Null falls back to the Elastic IP public DNS, whose certificate will not match: set this for a working deployment."
  type        = string
  default     = null
}

variable "api_path_pattern" {
  description = "CloudFront path pattern routed to the instance; everything else is the SPA."
  type        = string
  default     = "/api/*"
}
