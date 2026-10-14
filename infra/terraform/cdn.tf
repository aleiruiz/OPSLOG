resource "aws_s3_bucket" "web" {
  count = var.enable_cdn ? 1 : 0

  bucket = local.web_bucket_name
  tags   = local.tags
}

resource "aws_s3_bucket_public_access_block" "web" {
  count = var.enable_cdn ? 1 : 0

  bucket                  = aws_s3_bucket.web[0].id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "web" {
  count = var.enable_cdn ? 1 : 0

  bucket = aws_s3_bucket.web[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "web" {
  count = var.enable_cdn ? 1 : 0

  bucket = aws_s3_bucket.web[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256" # CloudFront OAC reads SSE-S3 without extra key grants
    }
  }
}

resource "aws_cloudfront_origin_access_control" "web" {
  count = var.enable_cdn ? 1 : 0

  name                              = "${local.name}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

data "aws_cloudfront_cache_policy" "optimized" {
  count = var.enable_cdn ? 1 : 0
  name  = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  count = var.enable_cdn ? 1 : 0
  name  = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  count = var.enable_cdn ? 1 : 0
  name  = "Managed-AllViewerExceptHostHeader"
}

# SPA fallback only on the web behaviour: extensionless paths serve the shell. A distribution-wide
# custom_error_response would also turn API 403/404 into 200 HTML, so it is deliberately not used.
resource "aws_cloudfront_function" "spa" {
  count = var.enable_cdn ? 1 : 0

  name    = "${local.name}-spa"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var request = event.request;
      if (request.uri.indexOf('.') === -1) request.uri = '/index.html';
      return request;
    }
  JS
}

resource "aws_cloudfront_distribution" "main" {
  count = var.enable_cdn ? 1 : 0

  enabled             = true
  default_root_object = "index.html"
  aliases             = var.cdn_aliases
  price_class         = "PriceClass_100"
  http_version        = "http2and3"
  tags                = local.tags

  lifecycle {
    precondition {
      condition     = length(var.cdn_aliases) == 0 || var.acm_certificate_arn != null
      error_message = "cdn_aliases requires acm_certificate_arn (certificate in us-east-1)."
    }
  }

  origin {
    origin_id                = "web"
    domain_name              = aws_s3_bucket.web[0].bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web[0].id
  }

  dynamic "origin" {
    for_each = var.enable_compute ? [1] : []

    content {
      origin_id   = "api"
      domain_name = coalesce(var.api_origin_domain, aws_eip.app[0].public_dns)

      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  default_cache_behavior {
    target_origin_id       = "web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized[0].id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa[0].arn
    }
  }

  dynamic "ordered_cache_behavior" {
    for_each = var.enable_compute ? [1] : []

    content {
      path_pattern             = var.api_path_pattern
      target_origin_id         = "api"
      viewer_protocol_policy   = "https-only"
      allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods           = ["GET", "HEAD"]
      cache_policy_id          = data.aws_cloudfront_cache_policy.disabled[0].id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer[0].id
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == null
    acm_certificate_arn            = var.acm_certificate_arn
    ssl_support_method             = var.acm_certificate_arn == null ? null : "sni-only"
    minimum_protocol_version       = var.acm_certificate_arn == null ? null : "TLSv1.2_2021"
  }
}

data "aws_iam_policy_document" "web" {
  count = var.enable_cdn ? 1 : 0

  statement {
    sid       = "CloudFrontRead"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web[0].arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.main[0].arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.web[0].arn, "${aws_s3_bucket.web[0].arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  count = var.enable_cdn ? 1 : 0

  bucket     = aws_s3_bucket.web[0].id
  policy     = data.aws_iam_policy_document.web[0].json
  depends_on = [aws_s3_bucket_public_access_block.web]
}
