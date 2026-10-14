# Plans against a mocked AWS provider: no credentials, no network, nothing is created.
mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_data "aws_ssm_parameter" {
    defaults = {
      value = "ami-00000000000000000"
    }
  }

  mock_data "aws_ec2_managed_prefix_list" {
    defaults = {
      id = "pl-00000000"
    }
  }
}

variables {
  region                = "us-test-1"
  environment           = "test"
  owner                 = "tests"
  name_suffix           = "unit"
  cognito_callback_urls = ["https://app.example.test/auth/callback"]
}

run "minimal_matches_hand_built_demo" {
  command = plan

  assert {
    condition     = aws_s3_bucket.files.bucket == "opslog-files-test-unit"
    error_message = "bucket name must come from project/environment/suffix"
  }

  assert {
    condition = alltrue([
      aws_s3_bucket_public_access_block.files.block_public_acls,
      aws_s3_bucket_public_access_block.files.ignore_public_acls,
      aws_s3_bucket_public_access_block.files.block_public_policy,
      aws_s3_bucket_public_access_block.files.restrict_public_buckets,
    ])
    error_message = "all four public access blocks must be on"
  }

  assert {
    condition     = one(aws_s3_bucket_versioning.files.versioning_configuration).status == "Enabled"
    error_message = "versioning must be enabled"
  }

  assert {
    condition     = length(aws_kms_key.main) == 1
    error_message = "KMS is on by default"
  }

  assert {
    condition     = aws_cognito_user_pool.main.admin_create_user_config[0].allow_admin_create_user_only
    error_message = "pool must be invite-only"
  }

  assert {
    condition     = aws_cognito_user_pool.main.password_policy[0].minimum_length == 12
    error_message = "password minimum must be 12"
  }

  assert {
    condition     = aws_cognito_user_pool_client.bff.generate_secret && aws_cognito_user_pool_client.bff.allowed_oauth_flows == toset(["code"])
    error_message = "client must be confidential, authorization code only"
  }

  assert {
    condition     = length(aws_instance.app) + length(aws_db_instance.main) + length(aws_cloudfront_distribution.main) + length(aws_iam_user.app) == 0
    error_message = "optional components are off by default"
  }
}

run "demo_shape_without_kms" {
  command = plan

  variables {
    enable_kms      = false
    create_app_user = true
  }

  assert {
    condition     = length(aws_kms_key.main) == 0
    error_message = "no KMS key when disabled"
  }

  assert {
    condition     = one(aws_s3_bucket_server_side_encryption_configuration.files.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "AES256"
    error_message = "SSE-S3 without KMS"
  }

  assert {
    condition     = length(aws_iam_user.app) == 1
    error_message = "app user requested"
  }
}

run "full_stack" {
  command = plan

  variables {
    enable_compute      = true
    enable_cdn          = true
    enable_database     = true
    vpc_id              = "vpc-00000000"
    public_subnet_id    = "subnet-00000000"
    database_subnet_ids = ["subnet-00000001", "subnet-00000002"]
    api_origin_domain   = "api.example.test"
    stage               = 2
  }

  assert {
    condition     = aws_instance.app[0].metadata_options[0].http_tokens == "required"
    error_message = "IMDSv2 only"
  }

  assert {
    condition     = aws_db_instance.main[0].publicly_accessible == false && aws_db_instance.main[0].backup_retention_period == 7
    error_message = "private database with stage-2 backups"
  }
}

run "compute_requires_network" {
  command = plan

  variables {
    enable_compute = true
  }

  expect_failures = [aws_security_group.app]
}

run "rejects_stage_without_implementation" {
  command = plan

  variables {
    stage = 3
  }

  expect_failures = [var.stage]
}
