# Forma de la cuenta de demostración creada a mano (ADR-0012 etapa 0, excepción ADR-0015):
# bucket privado SSE-S3 sin KMS, usuario IAM para cómputo fuera de AWS, pool Cognito Lite.
# Copie a un archivo propio (*.tfvars está ignorado por git) y complete los valores.
region      = "<región>"
environment = "staging"
stage       = 0
owner       = "<propietario>"
name_suffix = "<id-de-cuenta-o-sufijo-único>"

enable_kms      = false
create_app_user = true

cognito_callback_urls = ["http://localhost:5173/auth/callback"]
