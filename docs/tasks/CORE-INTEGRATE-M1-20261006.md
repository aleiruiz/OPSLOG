# CORE-INTEGRATE-M1-20261006 — composición auth + tenancy + archivos + audit/outbox y staging controlado

```yaml
id: CORE-INTEGRATE-M1-20261006
baseline:
  [
    SPEC-1.4,
    ORCH-1.4,
    inherited: SPEC-1.0/ORCH-1.0,
    SPEC-1.1/ORCH-1.1,
    SPEC-1.2/ORCH-1.2,
    SPEC-1.3/ORCH-1.3,
  ]
milestone: M1
kind: implementation
slice: first
baseSHA: 084644d5df409b3d456f6bd916451f86a3b535ea
depends_on: [CORE-AUTH, CORE-TENANCY, CORE-FILES, CORE-AUDIT, CORE-WEB]
write_paths:
  [
    apps/api/composition/**,
    apps/worker/composition/**,
    tests/integration/platform/**,
    infra/runtime/**,
    docs/tasks/CORE-INTEGRATE-M1-20261006.md,
  ]
```

Primer slice de CORE-INTEGRATE (Orchestrator, sección CORE-INTEGRATE). Une identidad, contexto de tenant, archivos privados, audit y outbox con adaptadores en memoria, prueba el flujo tenant → usuario → objeto → audit con dos tenants y una suite negativa, y deja un descriptor de staging con guardas explícitas. No cierra CORE-INTEGRATE: los pendientes están al final. Solo datos sintéticos; sin AWS, sin red, sin dependencias nuevas.

## Alcance entregado

1. **Cableado raíz** (`package.json`, `tsconfig.json`; fuera de `write_paths`, mínimo): `test:unit` ejecuta ahora `domain/files`, `platform/files`, `api/files` (vía `pnpm --filter`, 90/90/90/85), `infra/storage` e `infra/runtime` (`vitest run <ruta>` con los mismos umbrales, porque `infra/*` no es workspace). `format:check` cubre `infra/storage`, `infra/runtime`, `tests/integration`, ambas composiciones y los documentos de tarea. `tsc -b` referencia `domain/files`, `platform/files`, `api/files`, `infra/storage`, `infra/runtime`, ambas composiciones y `tests/integration/platform`. Los paquetes `platform/{audit,outbox,auth}`, `domain/{identity,tenants}`, `persistence/tenancy`, `apps/api/{auth,tenants}`, `apps/worker/base` e `infra/queues` ya estaban en `test:unit`, `format:check` y referencias; se comprobó que corren y que cumplen 90/85. `pnpm-lock.yaml` solo gana las entradas de importador vacías de las dos composiciones nuevas (sin dependencias).
2. **Mock web** (`apps/web/app/mockApi.ts`, `mockApi.test.ts`; tras los comentarios de CodeRabbit en el PR #28): `login` y `getSession` rechazan usuarios cuyo estado no es `active`; `acceptInvitation` guarda la contraseña enviada en el almacén de credenciales del mock, de modo que la persona invitada puede iniciar sesión tras cerrar sesión (y aceptar dos veces la misma invitación no duplica la cuenta; vale la última contraseña). Se añade el control `setUserStatus` para simular cambios de estado del lado servidor. 3 pruebas nuevas.
3. **Composición** (`apps/api/composition`, `apps/worker/composition`):
   - `Platform` (`createPlatform`): `IdentityService` + `AuthApi`, directorio de roles/membresías (`AccessDirectory`), control plane de tenants (`InMemoryTenantStore` sobre el puerto `TenantStore` y el `TenantContextResolver` real), `FilesApi`/`FilePipeline`, `AuditStore`, `OutboxStore` y el worker. Tenant, actor y permisos salen siempre de la sesión del servidor.
   - `TenantGate`/`GatedIdentityService`: cada `authenticate` de cualquier API vuelve a pasar por el resolvedor del control plane (tenant activo, membresía activa con la misma versión de proyección, ubicación verificada). Una sesión no reflejada en el control plane o un tenant suspendido fallan cerrado con el mismo error 401.
   - Operaciones: `bootstrapTenant`, `signIn`/`signOut`, `inviteUser`/`acceptInvitation`, `changeRole`, `removeMember` (serializadas por tenant, regla de último administrador), `suspendTenant`/`reactivateTenant` (operador), `listAudit` (`view_audit`, solo el tenant de la sesión), `publish` (transacción outbox con tenant/actor/correlación de la sesión).
   - Worker: `TenantAwareScanQueue` aplaza (no descarta) los escaneos de tenants no activos; `createWorkerRuntime` une `Worker` (rechaza tenant ausente/suspendido antes del handler), scan runner y drenaje.
4. **Suite de integración** (`tests/integration/platform`, 37 pruebas, `pnpm test:platform`, parte de `pnpm test:integration`; no necesita MySQL): flujo A/B, aislamiento, sesiones, jobs y suite negativa (ver trazabilidad). Cobertura de las composiciones 98,5 % líneas / 88,3 % ramas.
5. **`infra/runtime`**: `staging.json` (descriptor declarativo), `src/index.ts` (`validateDescriptor`, `assertStagingOnly`), `STAGING.md` y 18 pruebas de las guardas (staging explícito, `production: false`, `awsDeferred: true`, `realCloudCalls: false`, solo adaptadores en memoria/sintéticos, una réplica, sin exposición pública, sin ARNs/URLs/claves, arranque que se niega con `NODE_ENV=production`, `OPSLOG_ALLOW_PRODUCTION` o credenciales AWS, y ausencia de código de red/SDK). No es un artefacto desplegable ni IaC.

## Trazabilidad requisito → prueba

| Aceptación (Orchestrator)                            | Implementación                                                        | Pruebas (`tests/integration/platform`)                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Flujo tenant → usuario → objeto → audit con A/B      | `bootstrapTenant`, `inviteUser`, `files.*`, `listAudit`               | `flow.test.ts` (flujo completo en A y B, trails separados, actor opaco)                                                     |
| Usuario de A denegado en objetos/archivos/audit de B | tenant desde la sesión; claves tenant+id; grants ligados              | `isolation.test.ts` (status, grant, descarga, derivado, mismo id local, audit, administración con ids de B)                 |
| Sesión revocada bloquea operaciones y descargas      | `GatedIdentityService`, `signOut`, `removeMember`                     | `sessions.test.ts` (cierre de sesión, baja de miembro, grant previo inútil, sesión sin espejo, expiración 8 h)              |
| Rol cambiado a mitad de sesión                       | bump de versión de proyección + permisos por llamada                  | `sessions.test.ts` (la sesión vieja da 401; el nuevo login solo tiene el rol nuevo)                                         |
| Jobs de tenant suspendido/ausente rechazados         | `Worker` + `InMemoryTenantStore.status`; `TenantAwareScanQueue`       | `jobs.test.ts` (outbox suspendido y ausente sin handler; escaneos retenidos y liberados al reactivar)                       |
| Rollback no publica; retry no duplica                | `Platform.publish` sobre `OutboxStore.transaction`; `eventId` estable | `jobs.test.ts` (rollback y cuerpo async; deduplicación por tenant+eventId; reintento con backoff sin doble efecto)          |
| Audit sin PII                                        | `createAuditEvent` allowlist; DLQ y `lastError` sin payload           | `flow.test.ts` (nombre de archivo, hash, tokens, grant, correo, teléfono, sujeto externo ausentes), `jobs.test.ts`          |
| Grants falsificados/vencidos; ids cruzados           | `DownloadGrants`, `requireOpaqueId`                                   | `negative.test.ts` (firma alterada, secreto ajeno, truncado, tipos erróneos, expirado, otro actor, ids hostiles)            |
| Principales/invitaciones falsificadas                | `verifyExternalPrincipal`, invitaciones de un solo uso                | `negative.test.ts` (principal sin sellar, código reutilizado/issuer/nonce, replay, expirada, sin rol, tenant fallido)       |
| Último administrador con concurrencia                | `Platform.removeMember`/`changeRole` serializados por tenant          | `negative.test.ts` (único admin; dos admins que se eliminan mutuamente x5; baja contra degradación; admin revocado en cola) |

Comprobaciones de mutación hechas a mano (no versionadas): quitar la llamada a `assertActive` rompe 3 pruebas (rol cambiado, sesión sin espejo, tenant suspendido); quitar el bloqueo por tenant rompe 6 (todas las de concurrencia de administradores); quitar el filtro de tenant de `TenantAwareScanQueue` rompe 1.

## Hallazgos de integración (costuras que los slices no resuelven por sí solos)

- **Dos modelos paralelos de sesión y membresía.** `domain/identity` (sesión opaca, `authorizationVersion` por identidad) y `domain/tenants` + `persistence/tenancy` (sesión del control plane, versión por membresía) no se hablan. La composición refleja la sesión en el control plane al iniciar sesión y sube la versión de la proyección al cambiar rol o revocar. Un adaptador persistente debe decidir una fuente única de verdad; hoy el `TenantContext` de identidad y el de tenants son tipos distintos.
- **El puerto de identidad no expone "cambio de rol".** El bump de `authorizationVersion` solo ocurre en `revokeMembership` y `consumeRecovery`; la invalidación por cambio de rol se apoya en la proyección del control plane. Además `revokeMembership` sube la versión de la identidad completa (cierra también sesiones de otros tenants).
- **Último administrador.** Ni `IdentityService` ni `AuthApi` lo exponen (el contrato dice que lo debe imponer el llamador o el adaptador persistente). Aquí lo impone la composición con un bloqueo en memoria por tenant; esa garantía no se traslada a varios procesos: el adaptador persistente necesita bloqueo de fila o restricción.
- **Roles y permisos sintéticos.** `ROLE_PERMISSIONS` es una plantilla de la composición, no el catálogo de roles de SPECS; la persistencia de roles/membresías no existe.
- **Payload del outbox sin redactar.** Audit, DLQ y `lastError` quedan sin PII (probado), pero el payload del evento se guarda tal cual; los productores no deben incluir datos sensibles hasta que haya política de payload.
- **Reloj del worker.** `Worker` y `InMemoryOutboxStore` capturan `Date.now` como valor por defecto al construirse; la composición inyecta un reloj explícito (necesario para pruebas con `Date` simulado).
- **Provisionamiento.** `InMemoryTenantStore.provisionVerified` imita el resultado de un aprovisionamiento correcto (tenant activo con ubicación verificada); el aprovisionamiento real (bases, credenciales, migraciones) solo está probado en `persistence/tenancy` contra MySQL.

## Límites y pendientes (no se declaran cumplidos)

- **MySQL real: no ejecutado en este entorno.** No hay `mysqld` ni daemon de Docker, y `OPSLOG_TEST_MYSQL_ADMIN_URL` no está definido; `pnpm test:integration` completo (harness MySQL y `persistence/tenancy`) no pudo correr aquí. Solo se ejecutó `pnpm test:platform` (en memoria). No se añadió código MySQL sin poder probarlo: el uso de `TypeOrmTenantStore` detrás de la composición queda pendiente.
- Adaptador **TypeORM persistente de autenticación** (`IdentityStore`: identidad+vínculo único, invitación atómica, activación serializada, recuperación, revocación, membresías/roles) bajo `packages/persistence`.
- **OIDC real** (código de autorización + PKCE, firma, audiencia, nonce/state) y entrega de recuperación/invitación por correo; la invitación se devuelve hoy al administrador que la emite. `FakeOidcVerifier` es sintético.
- **BFF HTTP**: rutas, cookie de sesión `httpOnly`, protección CSRF, límites de tasa, `lastSeenAt`/inactividad (SPECS §5.4), MFA/TOTP y reautenticación para cambios de seguridad.
- **Cliente web generado** (contratos de usuarios, roles, empresa y borradores en `packages/contracts`); `apps/web` sigue usando el mock en memoria.
- **S3/KMS/IAM reales** (rol con prefijo por tenant/sesión), cola de escaneo durable, reconciliador de registros `pending_scan` sin trabajo, grants de un solo uso/rotación de clave.
- **Outbox/audit durables** (checkpoint de handler y lease persistidos; reconciliación durable) y migraciones MySQL de ambos.
- **Staging real**: no hay artefacto desplegable, IaC, cómputo, red ni secretos; `infra/runtime` solo fija el contrato y las guardas. AWS sigue diferido (ADR-0002) y producción no autorizada.
- No se ejecutó Playwright (`test:e2e`) en este entorno; el mock web tiene solo pruebas unitarias.
- Esta tarea no declara ningún gate (G1 incluido) ni la auditoría independiente como aprobados.

## Verificación

Node `22.22.0`, pnpm `11.25.0`. Resultados del SHA publicado en el informe del PR; comandos: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`, `pnpm baseline:check`, `pnpm test:unit` (umbrales 90/90/90/85 por paquete), `pnpm test:platform` (umbrales 90/90/90/85 sobre las composiciones) y 15 repeticiones de `tests/integration/platform`, `infra/runtime` y `mockApi.test.ts` (más 3 con orden aleatorio) sin fallos.
