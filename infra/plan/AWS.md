# OPSLOG — Plan de configuración AWS diferida

Estado: documentado; conexión, configuración y aprovisionamiento diferidos por instrucción del usuario.
Fecha: 2026-10-03. Baselines: SPEC-1.0 / ORCH-1.0.
Tarea relacionada: FND-AWS. Este plan no acredita pruebas sobre AWS ni autoriza publicación a producción.

## 1. Información conocida

| Elemento | Información / certeza |
|---|---|
| Base de datos | Amazon RDS, confirmado por el usuario. |
| Motor de destino | MySQL 8.0.45; consulta ejecutada por el usuario en Workbench. |
| Base lógica inicial | OPSLOG en configuración local; existencia y permisos aún sin verificar. |
| Entornos existentes | Producción y pruebas, confirmados por el usuario. |
| Conexión inicial seleccionada | RDS de pruebas en .env local ignorado; sin conexión ejecutada por este proyecto. |
| Ubicación de RDS | Endpoint suministrado identifica us-west-2; no se hizo inventario en AWS. |
| AppSync existente | Configuración suministrada indica us-east-1; sin uso verificado. |
| Sudamérica | Supuesto de planificación del usuario, no ubicación confirmada de recursos existentes. |
| Buckets existentes | Se proporcionaron referencias en .env; entorno, propiedad, políticas, región y uso compartido pendientes de inventario. |

No reproducir credenciales en este plan, paquetes, PRs, logs ni prompts. El .env inicial es configuración local; no es el mecanismo definitivo de secretos del runtime.

## 2. Qué se difiere

- Conexiones a RDS, inspección remota de permisos y creación de bases/usuarios.
- Configuración de IAM, red, secretos, cifrado, buckets, identidad, correo, colas y cómputo.
- Creación o modificación de recursos mediante infraestructura como código.
- Despliegue, pruebas de servicios/IAM reales y simulacros de restauración en AWS.

No ejecutar estas acciones hasta que el usuario reactive esta parte del trabajo. Mantener su evidencia pendiente; no marcarlas completadas por disponer de credenciales.

## 3. Trabajo que puede prepararse localmente

- Contratos/adaptadores desacoplados para identidad, almacenamiento, correo, colas y base de datos.
- Integración contra MySQL 8.0.45 efímero con datos sintéticos y al menos dos bases/tenants.
- Receptor local de webhooks, email sink y almacenamiento de prueba; pruebas de fallos/reintentos.
- Plantillas de infraestructura y configuración por entorno sin ejecutar plan remoto ni apply.
- Runbooks, threat model, matriz de permisos, checklist de inventario y presupuesto con variables pendientes explícitas.

No cargar automáticamente las credenciales reales del .env en tests/CI. La futura configuración local de pruebas debe usar valores de test aislados y selección explícita de adaptadores. Los emuladores no prueban políticas IAM ni disponibilidad de servicios AWS.

## 4. Arquitectura AWS objetivo

Arquitectura seleccionada en SPECS §3; reutilizar recursos existentes solo tras inventario:

| Componente | Uso previsto | Control a verificar |
|---|---|---|
| RDS MySQL | Control y datos operativos por tenant | Bases/usuarios separados; TLS validado; red privada; pools acotados. |
| S3 | Documentos, originales, derivados y cuarentena | Objetos privados, límites por tenant, KMS, versionado, policies y descargas autorizadas. |
| Cognito | Identidad OIDC/MFA | BFF y sesión OPSLOG; configuración de autenticación y revocación. |
| SES | Correo transaccional | Destinos de pruebas controlados, dominios/verificación y límites. |
| SQS / EventBridge | Jobs, entregas y activación periódica | DLQ, reintentos, contexto de tenant e idempotencia. |
| ECS Fargate / ALB | API y worker | Roles por servicio, red, health checks, logs y presupuesto. |
| S3 / CloudFront | Distribución de SPA React | Origen restringido, HTTPS y configuración pública sin secretos. |
| Secrets Manager / KMS | Secretos y claves | Runtime sin usuario master y sin claves estáticas en repositorio. |
| CloudWatch / OpenTelemetry | Observabilidad | Logs sanitizados, métricas, alertas y retención. |
| GitHub OIDC | Despliegue autorizado a pruebas | Rol limitado a repo/ref/environment; PRs sin credenciales cloud. |

AppSync y buckets suministrados son recursos existentes por evaluar. No se añaden como dependencias del producto automáticamente: la API OPSLOG continúa siendo REST según SPECS; no adaptar el dominio a una integración MOWI sin una tarea explícita.

## 5. Inventario pendiente al reactivar AWS

1. Identificar cuenta, región real de cada recurso, entorno, propietario, aplicaciones que lo comparten y presupuesto permitido.
2. Verificar RDS: versión, almacenamiento/capacidad, TLS, red, security groups, backups/PITR y permisos para bases y usuarios por tenant.
3. Confirmar que OPSLOG puede usar su base de control y bases operativas sin modificar datos o permisos de otra aplicación. DB_NAME=OPSLOG no sustituye la estrategia multitenant.
4. Revisar buckets: región/entorno, acceso público, KMS, versionado, CORS, prefijos, legal hold/retención y scanner. No asumir que un bucket existente es exclusivo o desechable.
5. Definir roles de runtime, migración/aprovisionamiento y CI; separar credenciales/secretos de producción y pruebas.
6. Comprobar coste estimado, residencia, disponibilidad de servicios y necesidad de mover o crear recursos en Sudamérica. No migrar automáticamente recursos de EE. UU.
7. Revisar configuración de identidad, colas y correo; documentar qué se reutiliza y qué se crea.

## 6. Secuencia futura de configuración

1. Aprobar el inventario y la lista concreta de recursos a utilizar para pruebas.
2. Preparar IaC y revisar cambios/costos antes de ejecutar; proteger recursos compartidos.
3. Configurar secretos/roles/red del entorno de pruebas y credenciales mínimas del backend.
4. Aprovisionar control/tenants sintéticos mediante migraciones; no resetear bases existentes.
5. Desplegar candidato a pruebas y validar identidad, RDS, IAM/S3/KMS, colas y correo con fixtures sintéticos.
6. Ejecutar auditoría cerrada y simulacros de recuperación; conservar logs sanitizados y digests.
7. Preparar producción como trabajo posterior con autorización independiente.

## 7. Impacto sobre hitos y auditorías

La documentación AWS puede trabajarse en M0 mientras la configuración real espera. FND-AWS conserva separados entregables documentales y verificaciones externas pendientes.

Los gates G0–G5 no se eliminan ni se declaran pasados mediante este plan. Deben distinguir validación local/documental de validación AWS real. Si un gate requiere una comprobación real todavía diferida, sigue pendiente en ese punto; el orquestador no falsifica evidencia ni inicia etapas posteriores para evadir la barrera.

Cambiar un gate para permitir aceptación exclusivamente local requeriría una instrucción explícita y una versión sucesora de la baseline afectada. El diferimiento actual no cambia la seguridad, alcance ni criterios de aceptación del producto.
