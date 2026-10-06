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
    packages/persistence/identity/**,
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

- **Operaciones de operador sin autorización propia.** `bootstrapTenant`, `suspendTenant` y `reactivateTenant` no autorizan por sí mismas: restringirlas a operadores es tarea del BFF. `reactivateTenant` puede reactivar un tenant cuyo bootstrap falló y que no tiene administrador.
- **`publish` deja elegir el permiso comprobado** al llamador (parámetro `permission`); el BFF debe fijarlo por ruta.
- **Relojes distintos.** `TenantContextResolver` usa `Date.now()` mientras identidad usa el reloj inyectado; solo coinciden con `Date` simulado global o reloj real.
- **Último administrador solo dentro de un proceso.** El bloqueo por tenant es en memoria; con varios procesos exige bloqueo de fila o restricción en el adaptador persistente. (El Slice 2 entrega ese adaptador con bloqueo de fila; la composición todavía no sincroniza los roles hacia él, ver abajo.)
- La guarda `assertStagingOnly` existe y está probada pero no está cableada a ningún entrypoint (no hay proceso de API/worker).
- **MySQL real: no ejecutado en este entorno.** No hay `mysqld` ni daemon de Docker, y `OPSLOG_TEST_MYSQL_ADMIN_URL` no está definido; `pnpm test:integration` completo (harness MySQL y `persistence/tenancy`) no pudo correr aquí. Solo se ejecutó `pnpm test:platform` (en memoria). No se añadió código MySQL sin poder probarlo: el uso de `TypeOrmTenantStore` detrás de la composición queda pendiente.
- Adaptador **TypeORM persistente de autenticación** (`IdentityStore`: identidad+vínculo único, invitación atómica, activación serializada, recuperación, revocación, membresías/roles) bajo `packages/persistence`. Entregado en el Slice 2 (abajo); su ejecución contra MySQL real queda a cargo de CI y el cableado por defecto sigue pendiente.
- **OIDC real** (código de autorización + PKCE, firma, audiencia, nonce/state) y entrega de recuperación/invitación por correo; la invitación se devuelve hoy al administrador que la emite. `FakeOidcVerifier` es sintético.
- **BFF HTTP**: rutas, cookie de sesión `httpOnly`, protección CSRF, límites de tasa, `lastSeenAt`/inactividad (SPECS §5.4), MFA/TOTP y reautenticación para cambios de seguridad.
- **Cliente web generado** (contratos de usuarios, roles, empresa y borradores en `packages/contracts`); `apps/web` sigue usando el mock en memoria.
- **S3/KMS/IAM reales** (rol con prefijo por tenant/sesión), cola de escaneo durable, reconciliador de registros `pending_scan` sin trabajo, grants de un solo uso/rotación de clave.
- **Outbox/audit durables** (checkpoint de handler y lease persistidos; reconciliación durable) y migraciones MySQL de ambos.
- **Staging real**: no hay artefacto desplegable, IaC, cómputo, red ni secretos; `infra/runtime` solo fija el contrato y las guardas. AWS sigue diferido (ADR-0002) y producción no autorizada.
- No se ejecutó Playwright (`test:e2e`) en este entorno; el mock web tiene solo pruebas unitarias.
- Esta tarea no declara ningún gate (G1 incluido) ni la auditoría independiente como aprobados.

## Slice 2 — adaptador persistente TypeORM/MySQL de identidad (`packages/persistence/identity`)

Base: `main` en `1bc6abd`; rama `claude/core-integrate-persistent-auth`. No toca `tools/orchestrator` ni FND-ORCH. Solo datos sintéticos.

### Entregado

1. **Paquete nuevo `@opslog/persistence-identity`**: workspace, importador en `pnpm-lock.yaml`, referencia en `tsconfig.json` raíz, `test:unit` y `test:integration` en los scripts raíz (`format:check` ya lo cubre por glob). Implementa el puerto `IdentityStore` de `domain/identity` sin modificarlo (importa su fuente por ruta relativa, como `apps/api/auth`).
2. **Esquema y migración** (`CreateIdentityStore2026100600010`, tabla de migraciones propia `opslog_identity_migrations`, `transaction: 'all'`, sin `synchronize` ni migraciones en arranque): `identities`, `external_identities`, `memberships`, `invitations`, `recoveries`, `sessions`, `tenant_locks`.
   - PK compuesta `(tenant_id, identity_id)` en membresías; UNIQUE `(provider, subject)` y UNIQUE `identity_id` en el vínculo externo; UNIQUE por hash de token en invitaciones, recuperaciones y sesiones.
   - Invitaciones y sesiones referencian la clave de membresía `(tenant_id, identity_id)`, no la identidad suelta (llaves con alcance de tenant).
   - CHECK de estados, rol (`^[a-z][a-z0-9_]{0,31}$`), versión >= 1, ventanas de expiración y `active => activated_at` (MySQL >= 8.0.16; TypeORM no emite CHECK en MySQL, van como DDL en la migración).
   - Todas las columnas clave usan `utf8mb4_0900_bin` (NO PAD): con la collation por defecto, dos `sub` que difieren por mayúsculas o por un espacio final colisionarían en el UNIQUE.
3. **Adaptador `TypeOrmIdentityStore`**:
   - Las operaciones multi-sentencia corren en una transacción `READ COMMITTED` con orden de bloqueo fijo (tenant, identidad, membresía, filas dependientes). Solo se reintenta (3 intentos) ante deadlock o lock-wait (1213/1205).
   - `createExternalIdentity`: identidad y vínculo atómicos; ante carrera devuelve al ganador sin identidades huérfanas. `createInvitation`/`createInvitationWithRole`: identidad pendiente, membresía pendiente e invitación en una transacción; reemitir consume los enlaces anteriores. `activateInvitation`: bloqueo de fila de la identidad, revalidación bajo bloqueo y consumo condicional (`consumed_at IS NULL AND expires_at > :now`, filas afectadas = 1) como última escritura; otra identidad o subject falla cerrado. `consumeRecovery` y `revokeMembership`: efecto e incremento `authorization_version = authorization_version + 1` atómicos; `revokeMembership` además marca revocadas las sesiones de ese tenant. `revokeSession` es condicional (`revoked_at IS NULL`). Los 72 h de invitación y las 8 h de sesión los fija `IdentityService`; el adaptador los respeta.
   - **Último administrador**: el rol vive en la membresía; `revokeMembership` y `setRole` toman la fila `tenant_locks` del tenant (`SELECT ... FOR UPDATE`) y cuentan administradores activos bajo bloqueo. Dos bajas o degradaciones concurrentes, incluso de procesos distintos, se serializan y la segunda recibe `LastAdministratorError` (`AuthError` con `code: 'conflict'` y `reason: 'last_admin'`). El bloqueo es por tenant: otro tenant no espera. Métodos fuera del puerto: `createInvitationWithRole`, `setRole`, `findRole`, `countActiveAdmins` y `purgeExpired` (retención de sesiones, invitaciones y recuperaciones vencidas). Una membresía creada por el puerto simple recibe el rol de mínimo privilegio `viewer`.
   - **Sin PII en logs ni errores**: el adaptador no registra nada. Los mensajes y parámetros de `QueryFailedError` incluyen `sub`, hashes e ids, así que se descartan y se mapean a `AuthError('conflict')` o `IdentityStoreError` (mensaje fijo, código grueso y errno). El hook opcional `onError` recibe solo `{operation, code, errno}`. `logging: false`.
   - `createIdentityDataSource` exige cuenta de runtime restringida (`opslog_identity_*` u `opslog_control_*`, nunca root/admin), pool acotado (`connectionLimit` 10, `queueLimit` 100), `timezone: 'Z'` y `utf8mb4`. `createIdentityMigrationDataSource` es para CI y despliegue con una cuenta dueña del esquema.
4. **Pruebas**:
   - **Unitarias** (`pnpm --filter @opslog/persistence-identity test:unit`, 86 pruebas, umbral 95/95/95/90; resultado 100 % líneas y sentencias, 98,2 % ramas, 98,5 % funciones). Un doble del `DataSource` de TypeORM (`src/test-support/fake-database.ts`) deriva PK y UNIQUE de los `EntitySchema` reales y modela FKs compuestas, bloqueos exclusivos de fila hasta commit o rollback, lecturas READ COMMITTED, rollback y detección de deadlock. Sobre él corren el `IdentityService` real, la concurrencia de último administrador (25 rondas de dos bajas, tres administradores, baja contra degradación), aislamiento A/B, sesión revocada, expiraciones de 72 h y 8 h, activación concurrente, recuperación y reintentos. `sql.test.ts` ejecuta los constructores de consultas y el generador SQL reales de TypeORM contra una conexión simulada y fija las sentencias (orden de `FOR UPDATE`, UPDATE condicionales, incremento atómico, isolation level, parámetros ligados). `schema.test.ts` compara migración y entidades (tipos, longitudes, collations, nulabilidad, UNIQUE e índices), el DDL del generador MySQL real y las fábricas de DataSource. Mutación hecha a mano (no versionada): quitar el bloqueo de tenant y el de las filas de administradores rompe las pruebas de concurrencia.
   - **Integración MySQL** (`src/mysql.integration.test.ts`, 21 pruebas): migración arriba, abajo y arriba; esquema (collations, UNIQUE, FKs, CHECK en `information_schema`); cuenta de runtime sin DDL; CHECK aplicados; creación concurrente del mismo `(provider, subject)` desde dos pools; activación de un solo uso y de subjects distintos en carrera; 72 h y reemisión; sesiones de 8 h; sesión revocada vista desde otro proceso; baja de miembro; recuperación concurrente; último administrador concurrente (dos bajas x10 rondas, tres administradores, baja contra degradación, administrador único); el bloqueo de fila hace esperar al otro proceso (espera comprobada en `INNODB_TRX`, sin sleeps fijos); aislamiento entre tenants; errores sin PII. Se guarda con `OPSLOG_TEST_MYSQL_ADMIN_URL` como la de tenancy, pero **sin la variable se omite en local** (la de tenancy falla); si `CI` está definido y falta, **falla**, para que CI no pueda omitirla en silencio.
   - **Plataforma** (`tests/integration/platform/persistent-identity.test.ts`, 4 pruebas): la composición se construye con `adapters.identityStore = new TypeOrmIdentityStore(...)` (mismo puerto, doble de driver en proceso) y repite flujo A/B, cierre de sesión, baja de miembro y último administrador. La suite de plataforma pasa de 39 a 43 pruebas; `apps/api/composition` no cambia.

### No entregado / límites del Slice 2

- **MySQL real no ejecutado aquí**: no hay `mysqld` ni Docker y `OPSLOG_TEST_MYSQL_ADMIN_URL` no está definido, así que ni `src/mysql.integration.test.ts` ni `pnpm test:integration` corrieron. Lo que depende del motor (collation NO PAD, CHECK, FK, orden y espera de bloqueos, `affectedRows`, `INNODB_TRX`) queda sin verificar hasta que CI corra sobre `mysql:8.0.45`. `sql.test.ts` fija el SQL que TypeORM genera, pero no sustituye esa ejecución.
- **Composición sin cableado por defecto**: `Platform` ya acepta `adapters.identityStore`, pero `AccessDirectory` (roles y permisos), `TenantGate` e `InMemoryTenantStore` siguen en memoria. Por eso la composición no llama a `setRole` ni a `createInvitationWithRole`, los roles en base quedan en `viewer` y su regla de último administrador sigue siendo el bloqueo en proceso. Falta un directorio de roles persistente, su sincronización transaccional con `setRole` (con compensación si falla una de las dos escrituras) y usar `TypeOrmTenantStore` en lugar del control plane en memoria.
- Decisión abierta: base de datos y cuenta compartidas con el control plane o propias. No hay FK hacia `opslog_control_tenants` (las migraciones son independientes) y los ids de tenant son `varchar(64)`.
- `lastSeenAt` no se actualiza (el límite de 8 h sigue siendo absoluto); `purgeExpired` existe, pero nada lo programa; el `sub` externo se guarda en claro (hace falta para buscar por él), con política de cifrado en reposo y retención pendiente; los hashes de token se buscan por índice (SHA-256 de 256 bits aleatorios, sin comparación en tiempo constante en la base).
- La revocación de una membresía sigue subiendo la versión de la identidad completa (cierra también sesiones de otros tenants), como dice el puerto; un cambio de rol de una membresía activa también la sube.
- OIDC real, correo, BFF HTTP, MFA, outbox y audit durables, S3/KMS y staging real siguen pendientes como en la lista anterior. Esta entrega no declara ningún gate ni la auditoría independiente como aprobados.

## Verificación

Node `22.22.0`, pnpm `11.25.0`. Resultados del SHA publicado en el informe del PR; comandos: `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`, `pnpm baseline:check`, `pnpm test:unit` (umbrales 90/90/90/85 por paquete), `pnpm test:platform` (umbrales 90/90/90/85 sobre las composiciones) y 15 repeticiones de `tests/integration/platform`, `infra/runtime` y `mockApi.test.ts` (más 3 con orden aleatorio) sin fallos.
