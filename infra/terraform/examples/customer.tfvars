# Cliente en su propia cuenta, etapa 0 con CloudFront y una instancia (ADR-0012).
region      = "<región>"
environment = "production"
stage       = 0
owner       = "<propietario>"
name_suffix = "<sufijo-único>"

enable_kms      = true
enable_compute  = true
enable_cdn      = true
enable_database = false # reutiliza un RDS existente: indique su security group abajo

vpc_id                              = "<vpc-id>"
public_subnet_id                    = "<subnet-pública-id>"
existing_database_security_group_id = "<sg-id-del-rds>"
api_origin_domain                   = "<dns-de-la-instancia-con-certificado-válido>"

cognito_callback_urls = ["https://<dominio>/api/auth/callback"]
cognito_logout_urls   = ["https://<dominio>/"]
cognito_domain_prefix = "<prefijo-único>"
