# Runtime de staging controlado (CORE-INTEGRATE)

> **Solo staging. No es producción. AWS diferido (ADR-0002). Sin llamadas reales a la nube.**
> Este documento y `staging.json` no autorizan ningún despliegue a producción ni describen recursos AWS.

## Qué describe

`staging.json` es el descriptor declarativo del primer staging controlado: una réplica de la composición de API
(`apps/api/composition`) y una del worker (`apps/worker/composition`), ambas con adaptadores en memoria o sintéticos
(identidad, tenants, objetos, escáner, outbox, auditoría, verificador OIDC). Todo el estado se pierde al reiniciar y
solo se usan datos sintéticos.

## Guardas (verificadas por `infra/runtime/src/index.test.ts`)

- `environment` es `staging`; `production` es `false`; `awsDeferred` es `true`; `realCloudCalls` es `false`, salvo cuando `objectStorage` es `s3` (enmienda de la ADR-0012 del 2026-10-14): entonces es `true`.
- Cada adaptador es `in-memory` o `synthetic`. Un adaptador real (RDS, Cognito, SES, SQS) hace fallar la validación. La única excepción es `objectStorage: s3` (bucket privado, credenciales de aplicación acotadas al prefijo `tenants/`, no por tenant), que exige `OPSLOG_S3_BUCKET`, `OPSLOG_S3_REGION`, `OPSLOG_S3_ACCESS_KEY_ID` y `OPSLOG_S3_SECRET_ACCESS_KEY` en `requiredEnv`; los valores nunca se versionan y se usan nombres `OPSLOG_S3_*` (no `AWS_*`, que sigue prohibido).
- Los servicios no se exponen públicamente (`internal` o `none`) y corren con una sola réplica, porque el estado es local.
- El descriptor no puede contener ARNs, cuentas, regiones, endpoints, URLs, claves ni secretos.
- `assertStagingOnly` (función de guarda, probada): valida el descriptor, exige `OPSLOG_ENV=staging` y se niega con `NODE_ENV=production` (sin distinguir mayúsculas ni espacios), `OPSLOG_ALLOW_PRODUCTION` o credenciales/identidad AWS (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_CONTAINER_CREDENTIALS_*`). **Hoy no está cableada a ningún proceso de arranque**: no existe entrypoint de API ni de worker; quien lo cree debe llamarla antes de componer la plataforma. El `.env` local no se carga.

## Cómo se usa hoy

No hay un artefacto desplegable ni IaC: este slice entrega la composición ejecutable en pruebas
(`tests/integration/platform`) y el contrato de qué se puede ejecutar como staging. Ejecutar el descriptor contra un
proveedor real requiere una asignación posterior que reactive AWS y autorice el entorno.

## Pendiente (no se declara cumplido)

- Adaptador TypeORM/MySQL persistente de identidad (`IdentityStore`) y de membresías/roles.
- Entrega de correo. (El verificador OIDC real contra Cognito ya existe; ver abajo.)
- BFF HTTP: rutas, cookie de sesión, CSRF, límites de tasa; cliente web generado en lugar del mock.
- S3 real, KMS e IAM (rol de aplicación con prefijo por tenant), cola durable y reconciliador de escaneos.
- Despliegue real a un entorno de pruebas (cómputo, red, secretos, observabilidad) y cualquier uso de producción.

## Inicio de sesión real con Cognito (demo)

El BFF puede verificar identidades contra Amazon Cognito con `createCognitoVerifier` (`packages/platform/auth`):
código de autorización + PKCE S256, cliente confidencial, firma RS256 contra el JWKS del pool, `iss`, `aud`, `token_use=id`,
vigencia y `nonce`. Los tokens nunca llegan al navegador. El navegador solo guarda, en `sessionStorage` y durante el intento,
el verificador PKCE, `state` y `nonce`; se consumen al volver.

Variables de entorno del BFF (ninguna se versiona; el secreto va solo en el entorno de despliegue):

| Variable                    | Valor                                                                      |
| --------------------------- | -------------------------------------------------------------------------- |
| `OPSLOG_OIDC_ISSUER`        | `https://cognito-idp.<región>.amazonaws.com/<id del pool>`                 |
| `OPSLOG_OIDC_DOMAIN`        | dominio del Hosted UI, `https://<prefijo>.auth.<región>.amazoncognito.com` |
| `OPSLOG_OIDC_CLIENT_ID`     | id del cliente confidencial                                                |
| `OPSLOG_OIDC_CLIENT_SECRET` | secreto del cliente                                                        |
| `OPSLOG_OIDC_REDIRECT_URI`  | `https://<dominio de la demo>/auth/callback`                               |

`cognitoConfigFromEnv(process.env)` las lee y valida; la plataforma se compone con `verifier: createCognitoVerifier(config)` y
`issuer: config.issuer`. Para la web, en la compilación de producción: `VITE_OIDC_DOMAIN` (igual que arriba) y `VITE_OIDC_CLIENT_ID`
(públicos). Sin ellos la compilación falla cerrada. La ruta de retorno de la web es `/auth/callback`: esa URL exacta debe estar
registrada como Callback URL del cliente de Cognito (y la de cierre de sesión no se usa todavía).
