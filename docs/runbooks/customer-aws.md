# Plan de cuenta AWS del cliente

Cómo llevar OPSLOG a la cuenta AWS de un cliente, por etapas (ADR-0012), con el módulo `infra/terraform` (ADR-0015). **Este documento no autoriza aprovisionar nada**: AWS sigue diferido (ADR-0002) y producción no está autorizada. Nada aquí se ha ejecutado contra una cuenta real. Todas las cifras de costo y de capacidad son **estimaciones de memoria, sin verificar**; se recalculan con la calculadora de precios vigente antes de pedir aprobación.

Hoy la etapa operativa es la de ADR-0016 §3: Docker Compose en un VPS con Coolify (`docs/operations/DEPLOY_COOLIFY.md`). La cuenta del cliente es el siguiente paso, tras las decisiones del propietario.

## 1. Región y residencia

- **El cliente elige la región** según su requisito de residencia de datos. El repositorio no fija ninguna: la variable `region` del módulo no tiene valor por defecto y el estado remoto se configura con `-backend-config`.
- Antes de decidir, **verificar en la región elegida** la disponibilidad y las cuotas de: S3, KMS, Cognito (incluido el nivel de usuarios y MFA elegido), RDS MySQL con la versión del módulo, EC2 con la familia `t4g`, CloudFront (servicio global; certificado ACM de CloudFront en `us-east-1`), SES, SQS, EventBridge y CloudWatch. No dar por hecho que un servicio o una clase de instancia existe en todas.
- Datos personales, copias y logs permanecen en la región elegida. Una **copia en otra región** solo se activa tras confirmar con el cliente que la residencia lo permite y tras revisar su costo (sección 5).
- No escribir regiones, identificadores de cuenta, ARN ni endpoints en el repositorio; viven en el archivo `*.tfvars` del cliente (ignorado por git) y en el inventario de `infra/plan/AWS.md`.

## 2. Etapas de ADR-0012 y variables del módulo

`stage` solo acepta 0, 1 y 2 en el módulo (las etapas 3 y 4 no están implementadas). `stage` ajusta la retención de logs (14, 14, 30 días) y la de copias de RDS (1, 1, 7 días), y se etiqueta como `etapa`.

| Etapa ADR-0012                | Qué incluye                                                                                                      | Variables del módulo                                                                                                                                                                                                                                                                     | Estado en el módulo                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 0. Mínima                     | S3 privado, Cognito, KMS, una instancia `t4g` con API y worker, CloudFront con el SPA, RDS existente reutilizado | `stage = 0`, `enable_kms = true`, `enable_compute = true`, `enable_cdn = true`, `enable_database = false`, `existing_database_security_group_id`, `vpc_id`, `public_subnet_id`, `instance_type`, `ingress_cidrs`, `api_origin_domain`, `cdn_aliases`, `acm_certificate_arn`, `cognito_*` | cubierta (ver `infra/terraform/examples/customer.tfvars`)                                               |
| 1. Austera                    | etapa 0 con forma A (tarea Fargate pequeña o `t4g.nano`), SES, SQS diferido, SSM                                 | `stage = 1` más lo anterior                                                                                                                                                                                                                                                              | solo la parte de instancia; Fargate, SES, SQS y SSM no están en el módulo                               |
| 2. Piloto con datos reales    | RDS propio Single-AZ con copias, alarmas, logs 30 días                                                           | `stage = 2`, `enable_database = true`, `database_subnet_ids`, `database_instance_class`, `database_allocated_storage`, `database_engine_version`, `cognito_deletion_protection = true`                                                                                                   | RDS Single-AZ con retención de copias de 7 días en etapa 2; alarmas y Budgets **no** están en el módulo |
| 3. Producción con resiliencia | Multi-AZ, Fargate con ALB, WAF, logs 90 días                                                                     | (sin variables)                                                                                                                                                                                                                                                                          | **no implementada**                                                                                     |
| 4. Plan completo de SPECS §3  | Fargate, ALB, NAT o endpoints, Multi-AZ, Secrets Manager, OpenTelemetry                                          | (sin variables)                                                                                                                                                                                                                                                                          | **no implementada**                                                                                     |

Otras variables útiles: `project`, `environment`, `owner`, `name_suffix`, `extra_tags`, `create_app_user` (cómputo fuera de AWS), `quarantine_expiry_days`, `noncurrent_version_expiry_days`, `allow_object_tagging`.

Disparadores para pasar de etapa y estimaciones por etapa: tabla de ADR-0012 (0: aprox. 8–12 USD/mes con RDS reutilizado; 1: 15–30; 2: 40–100; 3: 200–350; 4: 350–600 en producción; todas sin verificar). Cada salto requiere aprobación del propietario.

Orden de trabajo sugerido por cliente:

1. Inventario de la cuenta (`infra/plan/AWS.md` §5) y decisión de región (sección 1).
2. `terraform init` con estado remoto cifrado, `plan` revisado por dos personas, `apply` por una persona. Sin recursos manuales fuera de IaC.
3. Rellenar los secretos del despliegue sin versionarlos: las claves de acceso del usuario de aplicación, si se usa `create_app_user`, se crean con la CLI para que no queden en el estado.
4. Pasar la validación de la sección 6 antes de cargar datos reales.

## 3. Presupuesto: AWS Budgets

El módulo **no** crea Budgets. Se configuran a mano, o en un cambio de Terraform aprobado aparte, antes de crear otros recursos:

- Un presupuesto mensual de costo por cuenta, filtrado por la etiqueta `proyecto=opslog` y, si procede, por `entorno`.
- Alertas de correo al propietario al **50 %, 80 % y 100 %** del gasto real, y al 100 % del pronosticado.
- Cifra mensual inicial propuesta por ADR-0012: 15 USD para la etapa 0 y 30 USD para la etapa 1; **no se escribe en el repositorio una cifra aprobada** hasta que el propietario la confirme.
- Activar las etiquetas de asignación de costos (sección 4) en la consola de facturación.
- Revisión mensual del gasto real contra la estimación; si difiere, se actualiza ADR-0012 por sucesión.
- Sin servicios de costo fijo no listados en la etapa vigente (NAT, endpoints de interfaz, ALB, Multi-AZ).

## 4. Etiquetas obligatorias

Todo recurso lleva, vía `local.tags` del módulo: `proyecto`, `entorno`, `etapa` y `propietario`. `extra_tags` añade otras sin quitar estas. Los recursos creados fuera del módulo (por ejemplo Budgets) llevan las mismas. Una etiqueta que falte se corrige en el código, no en la consola.

## 5. Pendientes de lanzamiento

Nada de esta lista está hecho ni probado. Hasta cerrarse cada punto, el sistema no se declara listo para datos reales en la cuenta del cliente. El comando de aceptación de cada uno se anota en el paquete correspondiente cuando se ejecute.

| #   | Pendiente                                               | Detalle y criterio                                                                                                                                                                       | Requisitos              |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 1   | RDS con copias automáticas, PITR y retención de 35 días | hoy el módulo da 1, 1 o 7 días según la etapa; 35 exige subir `backup_retention_period` (máximo del servicio a verificar) y probar una restauración a un instante en una instancia nueva | NFR-B1 a B4, SPECS §9.3 |
| 2   | Copia en otra región                                    | solo tras confirmar residencia con el cliente y aceptar el costo (almacenamiento más transferencia entre regiones, estimación sin verificar)                                             | NFR-B                   |
| 3   | Multi-AZ                                                | etapa 3; hoy `multi_az = false` en el módulo                                                                                                                                             | NFR-A1                  |
| 4   | SES                                                     | correo saliente con dominio verificado, salida de sandbox y manejo de rebotes; hoy el correo es sintético                                                                                |                         |
| 5   | SQS y EventBridge                                       | entrega externa y trabajos largos; hoy el worker vacía el outbox desde la base                                                                                                           | SPECS §3                |
| 6   | Alarmas de CloudWatch                                   | CPU, memoria, disco, errores 5xx, estado de la instancia, salud de RDS y gasto; hoy solo el grupo de logs con retención                                                                  | NFR-M, NFR-A            |
| 7   | Despliegue sin caída                                    | requiere más de una réplica de `api`; hoy las sesiones y el worker viven en el proceso (una réplica) y cada despliegue reinicia                                                          | NFR-A4                  |
| 8   | SLO de 99,5 %                                           | medir disponibilidad real durante un periodo, definir exclusiones (ventanas anunciadas) y publicar el informe; hoy no hay medición                                                       | NFR-A1, NFR-A2          |
| 9   | KMS real                                                | escribir el adaptador de `KmsPort` y validarlo con `describeKmsPortContract` antes de cargar datos personales reales; `LocalDevKms` rechaza producción                                   | ADR-0012                |
| 10  | Pruebas de penetración y ASVS nivel 2                   | previas a la disponibilidad general                                                                                                                                                      | seguridad               |
| 11  | Copia fuera del host del VPS                            | decisión del propietario si la etapa 0 se queda en el VPS                                                                                                                                | NFR-B                   |
| 12  | Guardia y comunicación                                  | nombres y medios de contacto reales de los roles de `incident-response.md`                                                                                                               | NFR-B6                  |

## 6. Verificación antes de datos reales

1. `terraform fmt -check`, `validate` y `plan` limpios; nada «must be replaced» en el pool de Cognito, el bucket o la clave (todos con `prevent_destroy`).
2. Etiquetas presentes en todos los recursos y Budgets activos y probados.
3. Restauración de RDS a un instante en una instancia nueva, medida (RPO/RTO) y registrada.
4. Pendiente 9 cerrado (KMS real). Sin él no se cargan datos personales reales.
5. Exportación completa de empresa (`backup-restore.md` §4) ejecutada y verificada sobre datos sintéticos en la nueva cuenta.
6. Prueba de carga repetida en la cuenta del cliente: las 20 empresas y 500 sesiones totales de SPECS §9.3 son un paso de esa cuenta, no de este repositorio (`tests/performance/k6/README.md`).
7. Autorización de producción del propietario, por escrito y por separado.
