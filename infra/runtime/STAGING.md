# Runtime de staging controlado (CORE-INTEGRATE)

> **Solo staging. No es producción. AWS diferido (ADR-0002). Sin llamadas reales a la nube.**
> Este documento y `staging.json` no autorizan ningún despliegue a producción ni describen recursos AWS.

## Qué describe

`staging.json` es el descriptor declarativo del primer staging controlado: una réplica de la composición de API
(`apps/api/composition`) y una del worker (`apps/worker/composition`), ambas con adaptadores en memoria o sintéticos
(identidad, tenants, objetos, escáner, outbox, auditoría, verificador OIDC). Todo el estado se pierde al reiniciar y
solo se usan datos sintéticos.

## Guardas (verificadas por `infra/runtime/src/index.test.ts`)

- `environment` es `staging`; `production` es `false`; `awsDeferred` es `true`; `realCloudCalls` es `false`.
- Cada adaptador es `in-memory` o `synthetic`. Un adaptador real (S3, RDS, Cognito, SES, SQS) hace fallar la validación.
- Los servicios no se exponen públicamente (`internal` o `none`) y corren con una sola réplica, porque el estado es local.
- El descriptor no puede contener ARNs, cuentas, regiones, endpoints, URLs, claves ni secretos.
- Arranque (`assertStagingOnly`): exige `OPSLOG_ENV=staging` y se niega a iniciar con `NODE_ENV=production`,
  `OPSLOG_ALLOW_PRODUCTION` o credenciales AWS (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`,
  `AWS_PROFILE`). El `.env` local con referencias reales no se carga.

## Cómo se usa hoy

No hay un artefacto desplegable ni IaC: este slice entrega la composición ejecutable en pruebas
(`tests/integration/platform`) y el contrato de qué se puede ejecutar como staging. Ejecutar el descriptor contra un
proveedor real requiere una asignación posterior que reactive AWS y autorice el entorno.

## Pendiente (no se declara cumplido)

- Adaptador TypeORM/MySQL persistente de identidad (`IdentityStore`) y de membresías/roles.
- Verificador OIDC real (código de autorización + PKCE, firma, audiencia) y entrega de correo.
- BFF HTTP: rutas, cookie de sesión, CSRF, límites de tasa; cliente web generado en lugar del mock.
- S3 real, KMS e IAM (rol de aplicación con prefijo por tenant), cola durable y reconciliador de escaneos.
- Despliegue real a un entorno de pruebas (cómputo, red, secretos, observabilidad) y cualquier uso de producción.
