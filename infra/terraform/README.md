# Terraform de OPSLOG

Infraestructura de OPSLOG como código (ADR-0015, que sustituye CDK por Terraform). Un módulo raíz parametrizado por etapa de ADR-0012; cada cliente lo aplica en **su propia cuenta de AWS**. Nada de este directorio contiene identificadores de cuenta, nombres de bucket reales, regiones fijas ni secretos: todo entra por variables.

Este directorio **no autoriza** aprovisionar nada. Aplicar lo decide una persona, tras leer el `plan`.

## Qué crea

| Siempre | Opcional (variable) |
| --- | --- |
| Bucket de archivos: privado, Block Public Access, `BucketOwnerEnforced`, versionado, solo TLS, claves bajo `tenants/*`, cifrado SSE-KMS (si hay KMS) o SSE-S3, ciclo de vida (cuarentena y versiones antiguas) | `enable_kms`: una clave KMS gestionada con rotación (por defecto **sí**) |
| Política IAM de la app: `GetObject`/`PutObject`/`DeleteObject` solo sobre `tenants/*` (+ `PutObjectTagging`, ver abajo; + permisos de la clave KMS si existe) | `create_app_user`: usuario IAM con esa política, para cómputo fuera de AWS (Terraform **no** crea claves de acceso, para que no queden en el estado) |
| Cognito: pool invite-only, correo para recuperación, contraseña mínima 12, TOTP opcional, protección contra borrado; cliente confidencial (authorization code + PKCE, sin flujos de contraseña) | `cognito_domain_prefix`: dominio alojado |
| | `enable_compute`: una instancia `t4g` (IMDSv2, disco cifrado, sin SSH, acceso por SSM), Elastic IP y rol con la política de la app |
| | `enable_cdn`: bucket privado del SPA + CloudFront (OAC); con cómputo, enruta `api_path_pattern` a la instancia |
| | `enable_database`: MySQL Single-AZ privado, credenciales maestras en Secrets Manager |

Las etapas 0–2 de ADR-0012 están cubiertas (`stage` ajusta retención de logs y de copias). Las etapas 3–4 (Fargate, ALB, Multi-AZ) no están implementadas: `stage` solo acepta 0, 1 y 2.

## Uso

```sh
cd infra/terraform
terraform init \
  -backend-config="bucket=<bucket-de-estado>" \
  -backend-config="key=opslog/<entorno>.tfstate" \
  -backend-config="region=<región>" \
  -backend-config="encrypt=true"
cp examples/customer.tfvars mi-cliente.tfvars   # *.tfvars está ignorado por git
terraform plan  -var-file=mi-cliente.tfvars
terraform apply -var-file=mi-cliente.tfvars
```

El estado contiene valores sensibles (secreto del cliente de Cognito): use un backend cifrado con acceso restringido, nunca el repositorio. Para leer el secreto: `terraform output -raw cognito_client_secret`.

## Validación sin cuenta (lo que ejecuta CI)

```sh
terraform fmt -check -recursive
terraform init -backend=false
terraform validate
terraform test        # plan contra un proveedor AWS simulado; no crea nada
```

## Importar la cuenta de demostración (en vez de recrear)

Use `examples/demo.tfvars` con los valores reales, `terraform init` con el backend, y luego importe. Los nombres siguen el patrón de la demo (`opslog-files-<entorno>-<sufijo>`, `opslog-app-<entorno>`, `opslog-<entorno>`, `opslog-bff-<entorno>`). Sustituya `<…>`:

```sh
# Bucket y sus ajustes
terraform import aws_s3_bucket.files                                   <bucket>
terraform import aws_s3_bucket_public_access_block.files               <bucket>
terraform import aws_s3_bucket_ownership_controls.files                <bucket>
terraform import aws_s3_bucket_versioning.files                        <bucket>
terraform import aws_s3_bucket_server_side_encryption_configuration.files <bucket>
terraform import aws_s3_bucket_policy.files                            <bucket>   # solo si ya tiene política (TLS)

# Usuario IAM de la app
terraform import 'aws_iam_user.app[0]' opslog-app-<entorno>

# Cognito
terraform import aws_cognito_user_pool.main <user-pool-id>
terraform import aws_cognito_user_pool_client.bff <user-pool-id>/<client-id>
```

Después, `terraform plan` debe mostrar solo **altas** (ciclo de vida, política administrada de la app y su asociación, protección contra borrado del pool) y ajustes en sitio. Revise antes de aplicar:

- **Cliente de Cognito:** `generate_secret` fuerza reemplazo. Si el plan quiere **reemplazar** el cliente, deténgase: cambiaría `client_id` y secreto. Compruebe con `aws cognito-idp describe-user-pool-client` si el cliente existente tiene secreto y alinee la configuración.
- **Política del usuario IAM:** la demo tiene una política en línea. Terraform crea una administrada con el mismo alcance y la asocia; tras aplicar, borre la en línea a mano (`aws iam delete-user-policy`) para no duplicar.
- **Nivel de Cognito y ajustes finos:** si el plan propone cambios en el pool (nivel, atributos), ajuste las variables a lo existente en vez de aplicar a ciegas; algunos atributos del pool no se pueden cambiar tras la creación.
- La demo no tiene KMS: use `enable_kms = false`, o el bucket pasaría a SSE-KMS.

Una variante declarativa: copie los comandos a bloques `import { to = …, id = … }` en un archivo temporal no versionado y use `terraform plan -generate-config-out` solo como ayuda, nunca versione IDs reales.

## Cuarentena de archivos

Las claves son `tenants/<tenant>/<quarantine|released>/…`; una regla de ciclo de vida por prefijo no puede apuntar a la cuarentena (el área va después del tenant). La regla de expiración filtra por la etiqueta de objeto `opslog-area=quarantine` (`quarantine_expiry_days`, 7 por defecto). **El adaptador S3 real debe etiquetar las cargas en cuarentena con esa etiqueta** (y la copia a `released` no debe heredarla). Por eso la política de la app incluye `s3:PutObjectTagging` (`allow_object_tagging = false` lo quita). Hasta entonces, la limpieza la hace la recuperación de la saga en la propia app.

## Salvedades

- Escrito sin acceso a AWS: validado con `fmt`, `validate` y un plan simulado, **no aplicado** contra una cuenta real. Los atributos del proveedor (p. ej. `user_pool_tier`) y qué funciones ofrece cada nivel de Cognito (TOTP, etc.) deben confirmarse en el primer `plan` real.
- `.terraform.lock.hcl` no se versiona aún: se genera con `terraform init` contra el registro oficial y conviene fijarlo en el primer despliegue real.
- Con CloudFront, el certificado TLS de la instancia debe coincidir con `api_origin_domain`; con el DNS por defecto de la Elastic IP, CloudFront devolverá 502.
- Los importes de ADR-0012 son estimaciones sin verificar; revise `terraform plan` y los guardarraíles de costo antes de aplicar.
