terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.90, < 7.0"
    }
  }

  # Backend intentionally empty: each operator supplies a remote, encrypted backend at init time
  # (`terraform init -backend-config=...`). State holds sensitive values; it never lives in git.
  backend "s3" {}
}
