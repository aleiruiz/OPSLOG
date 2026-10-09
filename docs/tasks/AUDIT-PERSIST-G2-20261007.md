# AUDIT-PERSIST-G2 — persistencia tenant-scoped del AuditStore global

```yaml
id: AUDIT-PERSIST-G2-20261007
baseline: [SPEC-1.3, ORCH-1.3, inherited: SPEC-1.0/ORCH-1.0, SPEC-1.1/ORCH-1.1, SPEC-1.2/ORCH-1.2]
active_provider: openai
model: gpt-6-luna
milestone: M2
kind: implementation
base_sha: 2e47b023c7812e4cf90304269d03cd14d5db1fcf
status: implementation wired; final local checks pass serially; CI, independent audit, and orchestrator acceptance pending
depends_on: [CORE-AUDIT-M1-20261004, CORE-INTEGRATE-M1-20261006]
blocked_consumers: [FLT-INTEGRATE-G2-20261007 (blocked until durable audit remediation is accepted)]
requirements:
  [FR-170, FR-171 (tenant-scoped backend prerequisite only), NFR-SC2, SPECS-4, SPECS-4.4, SPECS-5.2]
source_decisions: [ADR-0004, ADR-0005, ADR-0006, ADR-0001, ADR-0002]
write_paths:
  [
    packages/platform/audit/**,
    packages/platform/outbox/**,
    packages/persistence/audit/**,
    packages/persistence/areas/**,
    packages/persistence/assignments/**,
    packages/persistence/documents/**,
    packages/persistence/employees/**,
    packages/persistence/files/**,
    packages/persistence/identity/**,
    packages/persistence/imports/**,
    packages/persistence/insurance/**,
    packages/persistence/settings/**,
    packages/persistence/tenancy/**,
    packages/persistence/vehicles/**,
    packages/domain/areas/**,
    packages/domain/assignments/**,
    packages/domain/documents/**,
    packages/domain/employees/**,
    packages/domain/files/**,
    packages/domain/identity/**,
    packages/domain/imports/**,
    packages/domain/insurance/**,
    packages/domain/settings/**,
    packages/domain/tenants/**,
    packages/domain/vehicles/**,
    packages/domain/alerts/**,
    apps/api/composition/**,
    apps/api/files/**,
    packages/platform/files/**,
    apps/worker/base/**,
    apps/worker/composition/**,
    infra/runtime/**,
    tests/integration/platform/**,
    tests/e2e/fleet/**,
    tests/harness/**,
    packages/domain/*/src/*.test.ts,
    packages/domain/identity/src/branches/**,
    packages/persistence/*/src/store/**,
    packages/persistence/*/src/schema/**,
    packages/persistence/*/src/errors/**,
    packages/persistence/*/src/store.test.ts,
    packages/persistence/*/src/schema.test.ts,
    packages/persistence/*/src/errors.test.ts,
    packages/persistence/*/src/mysql.integration.test.ts,
    packages/persistence/identity/src/sql/**,
    packages/persistence/tenancy/src/index.test.ts,
    packages/platform/outbox/src/**,
    packages/platform/files/src/**,
    apps/api/files/src/**,
    apps/worker/base/src/**,
    tests/integration/platform/flow.test.ts,
    tests/integration/platform/isolation.test.ts,
    tests/integration/platform/bff.test.ts,
    package.json,
    pnpm-lock.yaml,
    tsconfig*.json,
    docs/tasks/AUDIT-PERSIST-G2-20261007.md,
  ]
read_paths:
  [
    AGENTS.md,
    SPECS.md,
    Orchestrator.md,
    docs/baselines/ACTIVE.md,
    docs/baselines/1.3/SPECS.md,
    docs/baselines/1.3/Orchestrator.md,
    docs/baselines/BASELINE-1.3.json,
    docs/operations/SESSION_HANDSHAKE.md,
    docs/operations/AUTONOMOUS_ORCHESTRATOR.md,
    docs/adr/0001-environment-assumptions.md,
    docs/adr/0002-defer-aws-configuration.md,
    docs/adr/0004-provider-model-policy.md,
    docs/adr/0005-single-active-provider.md,
    docs/adr/0006-luna6-model-policy.md,
    docs/tasks/CORE-AUDIT-M1-20261004.md,
    docs/tasks/CORE-INTEGRATE-M1-20261006.md,
    docs/tasks/FLT-INTEGRATE-G2-20261007.md,
    docs/sources/BRD_SRD_OPSLOG_Bitacoras_Operativas_v0.2.md,
    packages/platform/audit/**,
    packages/platform/outbox/**,
    packages/domain/{areas,assignments,documents,employees,files,identity,imports,insurance,settings,tenants,vehicles,alerts}/**,
    packages/persistence/{areas,assignments,documents,employees,files,identity,imports,insurance,settings,tenancy,vehicles}/**,
    packages/platform/files/**,
    apps/api/composition/**,
    apps/api/files/**,
    apps/worker/base/**,
    apps/worker/composition/**,
    infra/runtime/**,
    tests/integration/platform/**,
    tests/e2e/fleet/**,
  ]
forbidden_paths:
  [
    SPECS.md,
    Orchestrator.md,
    docs/baselines/**,
    Tasks.md,
    .orchestrator/**,
    .env*,
    packages/contracts/**,
    infra/aws/**,
  ]
acceptance:
  - 'Given a business mutation in tenant A, When its module transaction commits, Then history, a sanitized immutable local audit row, and a separate durable relay-outbox/delivery row commit together in A’s `opslog_t_<opaqueId>` database; the command may acknowledge after this commit while the per-tenant global audit view may lag until relay.'
  - 'Given the audit relay resolves tenant A, When it reads A’s pending outbox item, Then it writes idempotently to A’s date-partitioned audit log and per-tenant registry, advances only the separate delivery state after commit, and leaves A’s local immutable audit row unchanged and present.'
  - 'Given tenant A and B with a repeated eventId, When each appends and reads its event, Then uniqueness is scoped to (tenantId,eventId), both tenants retain their own event, and no query path can enumerate or return another tenant’s events.'
  - 'Given runtime and relay credentials for tenant A, When they attempt to connect to or query tenant B’s database, Then the resolver supplies only A’s connection and MySQL credentials for A cannot read B.'
  - 'Given a duplicate (tenantId,eventId), When identical content is retried, Then append is idempotent; When immutable identity is reused with different content, Then the adapter returns a deterministic conflict and never overwrites the original.'
  - 'Given raw audit input containing unknown fields, PII or credentials, When it reaches the persistence boundary, Then only the allowlisted sanitized representation is stored and returned.'
  - 'Given API/runtime, relay and migrator accounts scoped to tenant A, When tested against MySQL, Then API/runtime retains only the business-table DML each module requires and can INSERT tenant-local audit/outbox plus the initial pending delivery/checkpoint row in the same command transaction, and read only its authorized projection; it cannot UPDATE/DELETE that state or local audit/log/registry, and cannot run DDL. Relay can SELECT local audit/outbox and delivery/checkpoint, SELECT/INSERT tenant-local log and registry, and UPDATE only separate delivery/checkpoint state; it cannot INSERT delivery state, write business tables or UPDATE/DELETE local audit/log/registry, and cannot run DDL. Only the migrator can perform DDL.'
  - 'Given separate synthetic MySQL 8 databases and credentials for A/B with concurrent writers/readers, When restart, transient DB failure, retries and tenant A/B races are exercised, Then committed local audit rows remain immutable, deduplicated and tenant-isolated, failed relays remain retryable, and CI executes every scenario.'
  - 'Given NFR-SC2, When the schema is applied to MySQL 8, Then the audit event log is partitioned by date and queries constrain tenant plus the relevant time range; partition rollover is tested without deleting retained audit data.'
  - 'Given the same (tenantId,eventId) is retried with a different event date/partition, When MySQL persists the retry, Then global idempotency still holds and the original event is never duplicated or overwritten.'
  - 'Given a file operation spans records, object storage, scanner/queue and audit relay for one tenant, When any external step fails, Then the tenant-local DB transaction keeps its immutable audit row and saga intent durable; retry/compensation is idempotent, delivery state is separate, no partial object is exposed, and no cross-DataSource transaction is claimed.'
commands:
  [
    pnpm baseline:check,
    pnpm lint,
    pnpm format:check,
    pnpm typecheck,
    pnpm test:unit,
    pnpm test:platform,
    pnpm test:integration,
    pnpm test:e2e,
    pnpm build,
    pnpm quality,
  ]
unit_cases:
  [
    sanitization at adapter boundary,
    tenant/event composite idempotency,
    mismatched-content conflict,
    immutable row,
    invalid identity rejection,
    in-memory adapter contract parity,
    module-local append-only audit row and separate relay delivery state share the business EntityManager transaction with mutation/history,
    rollback removes business mutation, history, local audit row and delivery state together,
    failed initial pending delivery/checkpoint INSERT rolls back the command transaction,
    file saga state transitions and compensation remain idempotent,
  ]
integration_cases:
  [
    MySQL 8 migration/grants,
    runtime DDL denial,
    restart durability,
    two-connection concurrent append,
    retry after transient failure,
    local command mutation/history/append-only audit/delivery-state atomic commit per tenant module DataSource,
    relay append/ack ordering across tenant-local DataSources,
    failed local audit or initial pending delivery-state insert rolls back the module business mutation and history,
    no cross-DataSource transaction is assumed,
    A/B same eventId isolation in distinct tenant databases,
    date partition creation/rollover and partition-pruned tenant/time reads,
    duplicate eventId across dates remains globally idempotent,
    permission-gated tenant-scoped read using tenant resolver and exclusive database credentials,
    credential A cannot connect to/read tenant B database,
    positive initial pending delivery/checkpoint INSERT by runtime and SELECT/UPDATE by relay, negative runtime UPDATE/DELETE and relay INSERT-on-delivery grants,
    positive business DML and negative protected-audit MySQL grant matrix for API/runtime, relay and migrator (including UPDATE/DELETE/DDL denials),
    relay success/retry preserves local immutable audit row while delivery state changes separately,
    worker checkpoint/retry without handler replay,
    file pipeline saga failure/restart/retry/compensation across record, object, queue and audit,
    local mutation/history/audit-outbox failure rolls back together,
  ]
e2e_cases:
  [
    BFF listAudit requires view_audit,
    derives tenant from authenticated context,
    and cannot return tenant B rows to tenant A; no cross-tenant operator/API path,
  ]
fixtures:
  [
    synthetic tenant A and B,
    opaque repeated event IDs,
    synthetic PII/credential strings,
    disposable MySQL 8 tenant databases and separate synthetic migrator/API-runtime/relay accounts,
    synthetic module databases/DataSources matching existing integration harnesses,
    deterministic object-store/scanner/queue failure injection for file saga,
    distinct synthetic tenant database credentials and resolver entries for A/B,
  ]
non_goals:
  [
    cross-tenant query,
    UI/S26 export,
    public contract changes,
    unapproved retention policy,
    AWS,
    production,
    M3,
    real data,
  ]
max_repair_cycles: 3
lockfile_scope: 'Coordinator-authorized only for the new packages/persistence/audit and packages/persistence/files importers plus dependencies strictly required by those packages; add the minimal importer/dependency delta, with no broad lockfile regeneration or unrelated importer changes.'
completion_evidence:
  [
    exact base/head SHA,
    MySQL 8 version and synthetic fixture details,
    schema/grant verification,
    traceability matrix,
    CI run links,
    one independent audit per PR SHA,
  ]
rollback: 'Revert application/adapter code and the additive versioned migration; retain append-only audit rows. Destructive down-migration or data deletion is prohibited; schema rollback must preserve rows or stop for explicit owner decision.'
```

## Objetivo y frontera

Reemplazar el adaptador de auditoría en memoria por una implementación TypeORM/MySQL durable que conserve el contrato de auditoría y la idempotencia por tenant. “Global” es un alcance lógico: consultar el registro de toda la empresa/tenant autorizado conforme a FR-171 y S26. Físicamente, cada tenant tiene su base exclusiva `opslog_t_<opaqueId>`, incluidas su DataSource de auditoría, log particionado por fecha y registry de idempotencia; no hay una base compartida de auditoría ni consulta multi-tenant. El tenant se deriva del contexto de sesión confiable para APIs y de un resolver confiable para el relay. Ninguna credencial runtime o relay de A puede conectarse a o leer B. No añadir endpoint cross-tenant, filtro de tenant del cliente, impersonación ni acceso global de operador.

`FLT-INTEGRATE-G2-20261007` es un consumidor bloqueado por la ausencia de audit durable y el contexto de remediación que este paquete busca desbloquear; no es dependencia previa para iniciar esta tarea.

El estado actual en `packages/platform/audit/src/index.ts` es `append(event): void` y `list(tenantId): readonly PersistedAuditEvent[]`; `Platform.listAudit` autentica y exige `view_audit`, y entrega `context.tenantId` al store. El valor predeterminado de composición continúa siendo `InMemoryAuditStore`. Los registros de historial de cada dominio no sustituyen el AuditStore global persistente.

La baseline de esta tarea es SPEC/ORCH-1.3 por instrucción directa vigente del usuario, con ADR-0006. `docs/baselines/ACTIVE.md` declara 1.4; se registra aquí únicamente como discrepancia del checkout, sin adoptar 1.4 ni modificar baselines/manifests. Las fuentes inspeccionadas son SPECS §4/§4.4 (aislamiento y matriz A/B), §5.2 (mutación, historial, audit local y outbox atómicos), §8 (design system primero) y §10 (gates acumulativos), además de Orchestrator §3/§6/§7. El prompt de preparación mencionó SPECS §13/§15, pero la SPECS heredada en este checkout no tiene esos encabezados; la trazabilidad funcional aplicable está en BRD §16, FR-170/171, NFR-SC2 y S26. Esta discrepancia no altera el baseline.

AWS y staging real siguen diferidos por ADR-0002. Usar únicamente datos sintéticos y MySQL 8 efímero local/CI; no conectar ni aprovisionar AWS, producción o una base existente.

## Decisiones aprobadas y límites de consistencia

El propietario registró la decisión de usar un `AuditStore` interno asíncrono y un outbox de auditoría local transaccional con relay idempotente. La implementación debe respetar estas semánticas; no requiere una nueva decisión previa. El port asíncrono es interno y no amplía el contrato público BFF/HTTP.

| Decisión                       | Evidencia/contexto                                                                                                                                              | Semántica aprobada y exigible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interfaz async                 | El port actual es sync, pero los adaptadores TypeORM requieren I/O async.                                                                                       | `append(event): Promise<void>` y `list(tenantId, filters?): Promise<readonly PersistedAuditEvent[]>` o equivalente interno. Propagar y esperar errores; `list` deriva tenant del contexto autenticado. `append` confirma el commit de log/registry dentro de la base exclusiva del tenant resuelto; `list` consulta solo la base del tenant autorizado.                                                                                                                                                                                                                                                                                                              |
| Atomicidad local y visibilidad | Los módulos tienen transacciones TypeORM independientes con DataSource/EntityManager propios; APIs hoy emiten audit después de que el servicio retorna.         | En cada módulo, guardar en la misma base y transacción/EntityManager la mutación, su historia, una fila local append-only de audit ya sanitizada y el INSERT inicial `pending` del registro separado de entrega. Runtime solo inserta ese estado inicial; nunca lo actualiza ni borra. La respuesta puede confirmar tras ese commit local; la vista lógica de auditoría puede tener lag hasta el relay. La fila local de audit nunca se borra, avanza ni sobrescribe.                                                                                                                                                                                                |
| Límites entre DataSources      | No existe transacción distribuida entre las bases de los módulos y la base de auditoría exclusiva de cada tenant.                                               | No afirmar atomicidad cross-DataSource. Un resolver confiable selecciona la base y credenciales del mismo tenant para relay. Fallos de relay conservan la fila audit local y el estado pendiente; relay solo lee el estado y lo actualiza después del commit tenant-local de log/registry. Log particionado y registry se escriben idempotentemente con `SELECT`/`INSERT` en una transacción de la base de ese tenant; ningún recurso compartido entre tenants.                                                                                                                                                                                                      |
| Files y efectos externos       | El pipeline separa MySQL de registros, object storage, scanner/queue y audit; esos efectos no comparten una transacción.                                        | Tratarlo como saga con intención/estado durable, fila audit local append-only y estado/outbox de relay separado, ambos dentro de la transacción local disponible; cada paso externo es reintentable/compensable e idempotente. No exponer un archivo antes de completar checks/registro. `packages/persistence/files/**` se incluye porque hoy no existe y se requiere para estado durable de la saga. Antes de iniciar este sub-slice, mapear cada efecto externo a transición durable/retry/compensación; si queda un seam sin resolver, detener solo el sub-slice de files y reportar el bloqueo concreto antes de escribirlo. Nunca alegar atomicidad imposible. |
| Conflicto idempotente          | El store en memoria conserva silenciosamente el primer evento para la misma clave.                                                                              | Igual retry canónico para `(tenantId,eventId)` es éxito idempotente; la misma clave con contenido distinto produce conflicto determinista. Nunca actualizar una fila existente. La registry de cada base tenant-local, separada del log particionado por fecha, mantiene unicidad a través de fechas; identidad y transacción permanecen dentro de esa base.                                                                                                                                                                                                                                                                                                         |
| Consulta y FR-171              | El endpoint actual entrega la lista del tenant autorizado; BRD pide filtros/exportación y UI S26.                                                               | Esta tarea cubre persistencia y lectura tenant-scoped para G2. No crear UI, exportación ni contrato público nuevo; mantener paginación/orden/límite seguros. FR-171 queda parcialmente abierto hasta el paquete de UI/API correspondiente.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| NFR-SC2 / retención            | NFR-SC2 exige particionar audit log y notificaciones por fecha; aquí aplica el audit log. BRD §16.3 etiqueta cinco años como `[DECISION REQUIRED — normativa]`. | Implementar particiones de audit por fecha y probar creación/rotación y lecturas tenant+tiempo. Cinco años permanece pendiente de decisión normativa; no borrar filas ni inventar política. Índices/query plans comienzan por tenant y acotan fecha cuando aplique.                                                                                                                                                                                                                                                                                                                                                                                                  |

La lista actual de call sites que debe migrar/probar incluye: `PlatformKernel.auditNow` y sus usos en `apps/api/composition/src/platform/{apis,invitations,members,sessions,settings}.ts`; la lectura `listAudit` en `apps/api/composition/src/platform/events.ts`; `packages/platform/files/src/pipeline.ts`; `apps/api/files/src/index.ts` (escrituras y rutas de error); y `apps/worker/base/src/index.ts` (checkpoint y append posterior). Hoy varias APIs registran audit después de que retorna el servicio: mover la creación del evento a la transacción local del módulo para que el insert de la fila audit local append-only y el estado durable de relay use la misma base y `EntityManager` transaccional que mutación e historia, nunca un manager global o una conexión independiente. Composición/inyección está en `apps/api/composition/src/platform.ts`, `platform/types.ts` y `apps/worker/composition/src/index.ts`. El writer transaccional local persiste la fila inmutable junto con el registro mutable separado de entrega. `AuditStore.append` asíncrono representa la escritura idempotente del relay en la base exclusiva del tenant resuelta confiablemente; el relay cambia solo el estado separado de entrega después de commit. `AuditStore.list` es async y sirve solo filas entregadas del tenant autenticado. Actualizar pruebas/mocks que consumen esos ports; buscar todos los usos antes de editar y no asumir que esta lista sustituye al grep del implementador.

## Requisitos de persistencia y seguridad

- Tabla append-only con identidad compuesta `(tenant_id,event_id)` (o mapeo `company_id` equivalente), `tenant_id` presente en claves/índices, timestamps UTC, campos tipados y datos allowlisted. Mismo `eventId` en tenants diferentes es válido.
- NFR-SC2 es requisito explícito: particionar el audit log por fecha. La política de retención de cinco años está separadamente marcada como `[DECISION REQUIRED — normativa]` en BRD §16.3 y permanece pendiente; particionar no autoriza a eliminar datos. MySQL 8 exige que toda columna de la expresión de partición esté en cada clave única de una tabla particionada ([MySQL 8.0 Reference Manual, §26.6.1](https://dev.mysql.com/doc/refman/8.0/en/partitioning-limitations-partitioning-keys-unique-keys.html)). Como el requisito de idempotencia `(tenant_id,event_id)` debe aplicar entre fechas/particiones, implementar una tabla-registro no particionada con esa clave compuesta y huella del evento, escrita atómicamente con la fila append-only en la partición temporal; comparar duplicados con la huella y rechazar contenido distinto sin actualizar. Si se propone otra estructura, demostrar la misma unicidad global en MySQL real antes de aceptarla.
- Sanitizar de nuevo en el límite del adaptador, incluso si quien llama entrega un evento raw. Persistir solo los campos tipados actuales y `AuditData` allowlisted; no guardar cuerpos HTTP, secretos, credenciales, PII libre, valores previos/nuevos sin política aprobada, ni campos extra. Verificar actor/correlation/entity IDs y manejo de entrada inválida con las reglas actuales de `packages/platform/audit`.
- Consultas parametrizadas siempre restringidas por tenant y filtros permitidos. `view_audit` se exige antes de ejecutar la lectura; se deriva tenant desde `TenantContext`, sin aceptar tenant de body/query/header. No debe existir API de store para `listAllTenants`.
- Cada principal tiene credenciales limitadas a la base exclusiva de su tenant; una cuenta A nunca puede conectar a ni consultar B. En cada tenant DB: (a) API/runtime conserva solo el DML de tablas de negocio que requiere su módulo; puede insertar registros audit locales/outbox y exactamente una fila/checkpoint de entrega inicial en estado `pending` dentro de la misma transacción, y leer solo la proyección autorizada; carece de `UPDATE`/`DELETE` sobre delivery/checkpoint y audit local/log/registry, además de `GRANT`/DDL; (b) relay puede leer audit local/outbox y delivery state, hacer `SELECT`/`INSERT` en log y registry, y actualizar solo la tabla/checkpoint mutable de entrega; no inserta delivery state, no escribe tablas de negocio ni actualiza/borra audit local, log o registry, y carece de `GRANT`/DDL; (c) solo migrator puede hacer DDL y no procesa solicitudes de aplicación. Probar contra MySQL DML de negocio autorizado que cada módulo requiere, INSERT inicial y rollback por fallo, cada grant y denegación efectiva, incluidos intentos A→B; no basta inspeccionar configuración.
- Fallo al insertar audit local, INSERT inicial de delivery/checkpoint, history o mutación aborta juntos la transacción local; el comando no confirma. Runtime nunca actualiza ni borra ese estado. Tras commit local, un fallo del relay no revierte ni repite el comando: conserva la fila audit local inmutable y reintenta desde el estado pendiente. Éxito del relay persiste el log/registry idempotentes en la misma DB tenant-local y luego el relay actualiza el registro/checkpoint separado de entrega; nunca reconoce borrando, avanzando o sobrescribiendo la fila audit. `list` ante error de lectura rechaza, no responde con lista vacía. El worker conserva la semántica de no reejecutar handler después de `handlerCompleted`. No hay transacción distribuida entre DataSources. No filtrar error/PII en respuesta o log.
- Cambios de esquema mediante migraciones TypeORM versionadas y reversibles sin pérdida; no usar `synchronize:true`. Aplicar migración con rol migrador y probar que la cuenta runtime no puede aplicarla. Ningún cambio destructivo a esquemas ya aplicados.

## Aceptación reproducible Given / When / Then

1. **Persistencia/reinicio.** Given MySQL 8 efímero y tenant sintético A, When una transacción en `opslog_t_<opaqueId>` confirma mutación, history, fila audit local append-only y estado pendiente de relay, y se destruye/recrea el proceso antes del relay, Then la operación confirmada se recupera con ambos registros; tras relay, `list(A)` devuelve el evento allowlisted una sola vez, la fila audit local sigue presente e idéntica y solo el estado separado de entrega cambia. Si falla cualquier insert local, se revierten juntos mutación, historia, fila audit y estado de relay; si falla relay, la fila inmutable permanece y la vista tenant-scoped puede retrasarse sin mentir sobre entrega.
2. **Idempotencia y carrera.** Given dos instancias de adapter y escrituras simultáneas para el mismo `(A,eventId)`, When ambas envían el mismo evento canónico, Then existe una fila y ambas terminan de forma determinista; si payloads difieren, una fila original permanece intacta y la otra recibe conflicto. Para `(B,eventId)` igual, existe otra fila independiente. Repetir tras reinicio produce el mismo resultado.
3. **Aislamiento de lectura.** Given A/B con IDs iguales y un actor de A autorizado `view_audit`, When consulta su audit store/BFF, Then solo obtiene filas de A; actor sin permiso recibe el error uniforme y la consulta no se ejecuta. Intentos con tenant B suministrado por cliente no alteran el tenant de contexto. Comprobar respuesta, SQL/resultados y ausencia de filtración en errores.
4. **Sanitización persistente.** Given un evento raw con email/teléfono, token, texto libre, claves desconocidas, actor no opaco o campo extra, When append pasa por el adapter, Then esos valores no aparecen en fila audit local, log particionado, registry, respuesta de list, logs ni artefactos de prueba; los campos inválidos de identidad son rechazados, no convertidos a una clave que pueda colisionar.
5. **Grants/immutability.** Given usuarios MySQL sintéticos y tenant-scoped separados para API/runtime, relay y migrator en A/B, When migrator ejecuta DDL de migración, Then funciona; When runtime realiza el DML autorizado sobre tablas de negocio definido por cada módulo, inserta audit local/outbox y el estado inicial `pending` de delivery/checkpoint dentro de la transacción, y consulta la proyección autorizada, Then funciona; sus intentos de `UPDATE`/`DELETE` sobre estado inicial, audit local/log/registry o DDL fallan. Si falla el INSERT inicial pending, la transacción revierte negocio, history y fila audit local. When relay lee audit local/outbox y delivery/checkpoint, hace `SELECT`/`INSERT` al log/registry y actualiza solo delivery/checkpoint, Then esas operaciones funcionan; su intento de INSERT en delivery/checkpoint, escribir tablas de negocio o hacer `UPDATE`/`DELETE` en audit local/log/registry o DDL falla. Cuando credencial A intenta conectar a B, falla. Append duplicate no actualiza ni reemplaza ninguna fila; la fila local permanece idéntica tras delivery y retry. No utilizar credenciales administrativas para solicitudes de aplicación.
6. **Crash/retry y atomicidad.** Given un comando de negocio y evento audit, When el proceso falla después del commit local y antes del relay, Then el comando no se repite y el relay recupera evento y estado durable; When falla después de commit del log/registry tenant-local pero antes de actualizar entrega, Then retry no duplica ni cambia log, registry o fila audit local y finalmente actualiza solo entrega. Tras relay exitoso y tras retry, comprobar por SQL que la fila audit local permanece idéntica. Para worker, `handlerCompleted` persistido hace que retry solo vuelva a intentar relay/append sin invocar handler. Simular cada ventana, reinicio y concurrencia con MySQL real, sin transacción cross-DataSource.
7. **Cobertura efectiva.** Given el CI candidato, When corren comandos del paquete, Then la suite MySQL nueva se descubre y ejecuta (sin `skip`), junto con unitarias, plataforma, typecheck, lint, format, build y calidad; la evidencia reporta SHA exacto, versión de Node/pnpm/MySQL, fixture sintética, resultado y cualquier check faltante. Una prueba de archivo presente no cuenta como ejecución.

## Trazabilidad requisito → port → implementación propuesta → prueba

| Requisito/fuente                   | Contrato actual / brecha                                                                                                                             | Implementación y estado                                                                                                                                                                                                                                                                                                                                                       | Prueba/evidencia requerida                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-170; BRD §16.1–16.3; SPECS §5.2 | `AuditStore` sync e in-memory; `PersistedAuditEvent` allowlisted; APIs hoy auditan tras retorno de algunos servicios.                                | `packages/platform/audit/**` (port async), `packages/platform/outbox/**`, nuevo `packages/persistence/audit/**` (tenant-local relay, fecha-particionado log y registry), y cada dominio/persistencia listado en `write_paths` (fila audit local append-only + estado de entrega separado en la transacción del comando).                                                      | Unitarias sanitizer/canonical hash; rollback conjunto; MySQL local-audit/outbox→relay→tenant registry/log/restart/concurrencia/grants; fila local persiste tras éxito/retry. |
| Atomicidad por módulo              | Cada módulo TypeORM usa su propio DataSource/EntityManager; no hay transacción global compartida.                                                    | `packages/domain/{areas,assignments,documents,employees,files,identity,imports,insurance,settings,tenants,vehicles,alerts}/**` y `packages/persistence/{areas,assignments,documents,employees,files,identity,imports,insurance,settings,tenancy,vehicles}/**`; insertar fila audit y estado de relay separados en la transacción de negocio/historia de la base tenant-local. | Unitarias y MySQL por módulo: rollback de ambos registros locales y commit conjunto de mutation/history/audit/delivery-state; ejecutar suites enumeradas.                    |
| SPECS §4.1/§4.2/§4.4; NFR-SC2      | `listAudit` requiere `view_audit` y tenant de sesión; un `WHERE tenant_id` dentro de DB compartida no satisface aislamiento físico.                  | `apps/api/composition/**`, `apps/api/files/**`, `packages/platform/files/**`, `apps/worker/base/**`, `apps/worker/composition/**`, `infra/runtime/**`: resolver tenant→base exclusiva `opslog_t_<opaqueId>`/credenciales, inyección, awaits, fallo/retry y query tenant-scoped.                                                                                               | A/B con IDs iguales; credencial A denegada al conectar/leer B; role deny/allow; inspección de DB seleccionada, filas/resultados SQL y ausencia de datos ajenos.              |
| FR-171 / S26 (parcial)             | BRD pide consulta global filtrable/exportable; el endpoint actual lista audit del tenant sin filtros y sin UI completa.                              | Mantener endpoint actual tenant-scoped y límites de lectura; filtros/export/UI quedan fuera hasta paquete propio.                                                                                                                                                                                                                                                             | Contrato HTTP autorizado y prueba de tenant/permisos; documentar gap restante sin atribuir cumplimiento total de FR-171.                                                     |
| Outbox M1 / worker                 | Worker guarda `handlerCompleted` antes del relay audit y ya evita reejecutar el handler tras fallo de append.                                        | Mantener checkpoint; fila audit local inmutable se conserva y relay actualiza solo el estado/checkpoint de entrega tras commit del log/registry de la DB del tenant. `apps/worker/base/**`, `apps/worker/composition/**` y stores locales.                                                                                                                                    | MySQL crash/restart en ambas ventanas; fila local igual antes/después de éxito/retry; append tenant-local idempotente y handler no repetido.                                 |
| Files y efectos externos           | `pipeline.ts` coordina registros, object storage, scanner/queue y audit, que no comparten transacción.                                               | Nuevo `packages/persistence/files/**` para intent/state/outbox durable; `packages/domain/files/**` y `packages/platform/files/**` implementan saga y pasos compensables/retry. No transacción distribuida.                                                                                                                                                                    | Fallar cada efecto por separado, reiniciar/reintentar, validar que no se exponga registro parcial y no se pierda audit intent.                                               |
| SPECS §5.2/§5.3 vs BRD §16.3       | BRD describe audit central; owner decidió una vista lógica global, DB física exclusiva por tenant y relay asíncrono desde audit local transaccional. | Aplicar mutation+history+fila audit append-only+estado relay separado en un mismo EntityManager tenant-local; relay eventual a log/registry particionado dentro de la DB exclusiva de ese tenant. La vista puede tener lag; no afirmar atomicidad cross-DataSource ni una DB compartida.                                                                                      | Crash tests 1/6; comprobar aislamiento de credenciales A/B y fila local inmutable en ambas DBs/estados de relay tras éxito y retry.                                          |

## Paths, dependencias y límites de implementación

Los paths incluidos son los `write_paths` del frontmatter. Los paquetes `packages/persistence/audit/**` y `packages/persistence/files/**` son nuevos; su registro en workspace y referencias TypeScript ya está integrado en el main usado como base. `pnpm-lock.yaml` se mantiene sujeto al límite coordinado: únicamente los importers/dependencias indispensables autorizados, sin regeneración amplia ni cambios ajenos. Si configuración compartida adicional, workflow, `packages/contracts/**`, manifests, migración fuera del slice o código consumidor no enumerado resulta necesario, detenerse y pedir paquete/lease ampliado antes de tocarlo.

No cambiar baselines, contratos públicos BFF/HTTP, modelo de permisos, UI, exportación S26, formato de reportes, política de retención de cinco años, flujos M3, AWS, producción ni datos reales. La partición temporal del audit log es requisito de NFR-SC2 y sí forma parte del alcance. El propietario ya aprobó el port asíncrono y la arquitectura local-outbox/relay descrita; no queda pendiente esa decisión. Cualquier seam de archivos que no alcance la saga durable debe registrarse con repro y bloquear la aceptación del trabajo de archivos, sin declarar atomicidad inexistente. La aprobación de este paquete no equivale a aceptación de implementación o G2.

## Comandos y evidencia

Usar runtime fijado Node `24.19.0` y pnpm `11.25.0`. Ejecutar las pruebas focales audit/platform/API files/worker, después `pnpm test:integration` contra MySQL 8 real efímero, y todos los comandos del frontmatter en el SHA candidato. `pnpm quality` debe incluir las pruebas nuevas y el harness; verificar los logs para confirmar que suites MySQL y fleet se ejecutaron. `pnpm test:e2e` valida el BFF disponible; no sustituye integración MySQL. `pnpm test:visual` solo si el cambio modifica UI o los gates del repo lo exigen; snapshots no se regeneran sin inspección visual. `baseline:check`, format, lint, typecheck, unit, platform, integration, build y quality no se reportan PASS salvo ejecución observable sobre el SHA señalado. La CI requerida y única auditoría independiente por PR/headSHA siguen siendo necesarias bajo SPEC/ORCH-1.3.

### Evidencia R3 de implementación (worktree sin commit)

La revalidación R3 parte de `2e47b023c7812e4cf90304269d03cd14d5db1fcf` y corre sobre HEAD `fac295d9e0dc887b2a86c6bd0e16eaba017bc3a2` más los cambios locales aún sin commit. El paquete conserva la baseline SPEC/ORCH-1.3; el manifiesto ACTIVE del checkout reporta 1.4, discrepancia que queda registrada para coordinación y no se adopta en este paquete. `apps/api/composition/src/fleet-persistence.ts` expone `audit` y `auditRelay` como adapters obligatorios del runtime Fleet; `tests/e2e/fleet/world.ts` inyecta el par correspondiente a cada base física de tenant. `apps/api/composition/src/platform.ts` rechaza una composición con stores de negocio persistentes si falta el AuditStore durable o el relay tenant-aware. La prueba de composición cubre ausencia de ambos, ausencia del relay y el caso configurado.

La lectura `listAudit` existente conserva permiso `view_audit` y resolución confiable del tenant. La cobertura Fleet MySQL confirma proyección desde filas locales al log tenant-local y rechazo del resolver con identidad de otro tenant. No se añadió un endpoint ni se cambió el contrato público. La aceptación API después de reiniciar conserva comportamiento fail-closed: la invitación persistida no se consume ni se audita si no hay un tenant confiable para enrutarla; aceptar invitaciones tras reinicio sigue pendiente de un contrato/lookup de tenant seguro y no se resuelve consultando todas las bases.

Checks ejecutados con Node `24.19.0`, pnpm `11.25.0` y MySQL sintético `8.0.45` en loopback: `pnpm typecheck`, `pnpm lint`, `pnpm format:check` y `pnpm test:unit` finalizaron con exit code 0. El harness MySQL pasó 1/1; las suites de persistence tenancy/audit/identity/areas/vehicles/employees/documents/insurance/assignments/settings/imports/files pasaron respectivamente 5/10/30/23/20/24/16/16/17/12/15/2 pruebas, sin skips. `pnpm test:integration` en concurrencia por defecto falló porque cinco fixtures Fleet expiraron en `beforeAll` a los 120 s mientras varias bases se provisionaban a la vez; los archivos de integración de plataforma que sí acabaron pasaron. Este patrón fue consistente con contención durante provisionamiento concurrente: al repetir `tests/e2e/fleet` serial, los cinco archivos y 9/9 pruebas pasaron. La repetición final `pnpm test:platform --maxWorkers=2 --minWorkers=2` pasó 39/39 archivos y 451/451 pruebas sin skips, con cobertura de líneas/funciones/sentencias de 99.34% y ramas de 96.53% (umbrales 95/95/95/90). La primera expiración se conserva como evidencia; no se aumentaron timeouts.

`pnpm build` y `pnpm baseline:check` también finalizaron con exit code 0. CI y la única auditoría independiente del SHA publicable aún están pendientes. No se declara cumplimiento del criterio de invitación tras reinicio, aceptación de la tarea ni G2; el orquestador valida CI, auditoría, merge y evidencia acumulativa del gate conforme a ORCH §6–§7. AWS continúa diferido por ADR-0002.

### Remediación PR74 sobre `40eb23c`

El CI de `40eb23c` reportó TS2307 porque `@opslog/platform-audit` exponía tipos desde `dist/index.d.ts`, artefacto que no existe en un checkout limpio antes del build. `packages/platform/audit/package.json` ahora dirige el condition `types` a `src/index.ts`, que está versionado; una regresión comprueba el destino y existencia de la fuente antes de generar `dist`, y `pnpm typecheck` pasó con el runtime fijado.

La auditoría de ese SHA observó que aceptar cualquier objeto con `audit` y `auditRelay` permitía adapters vacíos/no-op junto a stores persistentes. `Platform` reconoce las clases TypeORM que usa la composición productiva (y la identidad persistente) y exige `MySqlAuditApiStore` y `MySqlAuditRelay` concretos cuando están presentes. Los adapters port-fakes de BFF quedan explícitamente etiquetados como dobles de prueba en `apps/api/bff/src/test-support.ts`; no se usan para representar producción. Las regresiones rechazan TypeORM + audit no-op/en memoria o relay no-op, y aceptan el par MySQL; `tests/integration/platform/composition-units.test.ts` pasó 16/16 y las pruebas BFF/composición pasaron 224/224. Estos son cambios locales del nuevo candidato; no alteran ni reescriben la evidencia auditada del SHA `40eb23c`, y el nuevo SHA requiere los checks/CI y la única auditoría independiente coordinados por el propietario.

### Revalidación R4 antes de commit

Los ocho escenarios BFF que usan stores de módulo MySQL ahora inyectan `createMySqlAuditRuntime` y su relay; la persistencia y la lectura de auditoría usan la conexión MySQL sintética del fixture. Los cuatro escenarios de driver fake ya no combinan un store TypeORM con `InMemoryAuditStore` y un relay no-op: usan las clases MySQL de audit/relay sobre `FakeDatabase`, y el caso de carreras ejecuta relay y lee sus filas de proyección comprometidas porque el fake no implementa QueryBuilder. Esos cuatro casos siguen identificados como fake-driver y no se presentan como evidencia de MySQL real. La evidencia de routing entre bases físicas A/B proviene de Fleet.

Como antecedente de la corrección, la primera corrida de plataforma tras endurecer la guarda falló en la preparación de 12 suites: 30 pruebas con driver fake y ocho fixtures MySQL que aún no inyectaban runtime de audit; 64 subcasos quedaron sin ejecutar como consecuencia de los fallos de setup. Se conservaron los fallos y no se relajó la guarda. Tras alinear los fixtures, las 12 suites focales pasaron 102/102; `pnpm test:platform --maxWorkers=2 --minWorkers=2` pasó 39/39 archivos y 452/452 pruebas, sin skips, con 99.44% de líneas/sentencias, 95.87% de ramas y 99.07% de funciones en composición (umbrales 95/95/95/90). Las suites MySQL usaron únicamente el contenedor efímero `8.0.45` en `127.0.0.1:3306`.

Los checks finales sobre este árbol, con Node `24.19.0` y pnpm `11.25.0` observados en el proceso raíz, finalizaron con exit code 0: `pnpm typecheck`, `pnpm test:unit`, `pnpm build`, `pnpm format:check`, `pnpm lint` y `pnpm baseline:check`. Una corrida parcial de unitarias se abortó al detectar que sus subprocesos heredaban Node 20/pnpm 9; esa corrida no cuenta como evidencia. En la corrida completa válida, el `PATH` del proceso se antepuso con los binarios fijados para que el entorno se heredara; los subprocesos internos no imprimieron versiones individuales. No se ejecutó `pnpm quality` ni se vuelve a atribuir PASS a `pnpm test:integration` por defecto: el antecedente R3 conserva sus cinco expiraciones concurrentes en fixtures Fleet; la cobertura de plataforma/Fleet final se ejecutó con dos workers y terminó sin skips.

La condición de invitaciones tras reinicio permanece explícitamente fail-closed: una invitación persistida no se consume ni audita si no hay un tenant confiable para enrutarla. Aceptar invitaciones tras reinicio sigue pendiente de un contrato/lookup de tenant seguro; no se resuelve explorando bases. Latencia continúa diferida. La CI del nuevo SHA y su única auditoría independiente siguen pendientes; no se declara aceptación de G2.

### Wiring durable de Files en Fleet

El slice de Files conecta la composición Fleet al almacenamiento persistente existente: cada tenant abre su propio DataSource de Files con la credencial runtime tenant-local, aplica `CreateFilesMigration2026100700010` con una credencial migradora dedicada y crea un único `TypeOrmFileSagaStore` compartido por `records`, `scanQueue` y `fileSagaJournal`. `Platform` inyecta el journal en `FilePipeline`/`FilesApi` y rechaza stores durables que no compartan esa instancia, para evitar que el escaneo o el journal se pierdan entre adaptadores. La regresión de composition también confirma que un `roleStore` explícito requiere la pareja de auditoría durable aunque `identityStore` permanezca en memoria.

`file-saga-restart.test.ts` usa solo bases/identidades sintéticas MySQL en loopback. Sube un archivo por el runtime Fleet, cierra el proceso/DataSource y recupera el escaneo desde una composición nueva con la misma base de tenant; comprueba estado limpio y proyección de eventos `file.uploaded`, `file.scan_clean` y `file.released`. También revoca temporalmente el permiso de append de audit a la cuenta runtime Files y verifica rollback conjunto de registro, historial, saga, audit local y entrega. El fixture `migrations.test.ts` comprueba migración/idempotencia, ciclo down/up y denegación efectiva de DDL al runtime. Para ese ciclo, la cuenta migradora sintética dedicada recibe DDL y `DELETE` solo en `opslog_files_migrations`, porque TypeORM elimina la fila de tracking al deshacer una migración; ninguna cuenta runtime recibe DDL o `DELETE`, y el acceso a los registros/historial/saga de negocio sigue limitado a `SELECT`/`INSERT`/`UPDATE` requeridos.

La primera plataforma tras endurecer el guard pasó 39/40 archivos y 454/455 pruebas; falló únicamente `persistent-roles.test.ts`, cuyo fixture conservaba por inercia el AuditStore InMemory y relay no-op de `createWorld`. El fixture fue corregido para usar `createMySqlAuditRuntime` sobre `FakeDatabase` y está identificado como fake-driver, sin relajar el guard ni presentar esa prueba como evidencia de MySQL real. Su foco junto a composition-units pasó 37/37. Después, `pnpm test:platform --maxWorkers=2 --minWorkers=2` pasó 40/40 archivos, 455/455 pruebas, 0 skips/fallos, y cobertura de composición de 99.41% líneas/sentencias, 95.4% ramas y 99.06% funciones. Incluyó los ocho `mysql-*` previamente incompletos y `migrations.test.ts` (3 pruebas); la nueva suite Fleet serial pasó 6/6 archivos y 10/10 pruebas, sin skips. Todo usó MySQL sintético `8.0.45` en `127.0.0.1:3306`.

Con Node `24.19.0` y pnpm `11.25.0`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test:unit`, `pnpm build` y `pnpm baseline:check` finalizaron con exit code 0; `git diff --check` también pasó. Las pruebas de accesibilidad del UI imprimieron los avisos ya conocidos de jsdom por Canvas no implementado; no causaron fallos. La primera verificación de formato identificó tres archivos editados; se aplicó Prettier únicamente a esos paths y la verificación posterior pasó. Los artefactos `.js`/`.d.ts` generados anteriormente por TypeScript fueron eliminados; el único archivo nuevo sin rastrear es el fuente intencional `file-saga-restart.test.ts`. Todos los archivos modificados están dentro de los paths autorizados. No se ejecutaron cambios en contrato, AWS o producción, ni se creó auditoría ni se declara G2 aceptado.

## Revalidación local: outbox durable y checkpoint de worker (2026-10-09)

### Remediación y trazabilidad

| Requisito                                                        | Contrato e implementación                                                                                                                                                                                                                                                | Evidencia                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbox tenant-local duradero y transaccional                     | packages/platform/outbox/src/index.ts admite I/O asíncrono; packages/persistence/audit/src/entities.ts, migrations.ts, outbox-store.ts y outbox-worker-store.ts persisten enqueue, estado, lease, intentos, errores, checkpoint y fencing en la DB exclusiva del tenant. | packages/persistence/audit/src/mysql.integration.test.ts: 12/12 en MySQL 8 sintético; cubre rollback, restart, idempotencia, A/B, grants, backoff y fencing. Unitarias audit: 8/8.                                   |
| No repetir handler tras checkpoint confirmado; fencing por lease | apps/worker/base/src/index.ts espera operaciones async; outbox-worker-store.ts persiste handler_completed y fencing monotónico, y actualiza delivery con guardas de estado/fence.                                                                                        | tests/integration/platform/outbox-restart.test.ts: 2/2 en MySQL; handler no se repite tras reinicio y un fence obsoleto no puede completar.                                                                          |
| Transacción de API y wiring durable                              | apps/api/composition/src/platform/events.ts, fleet-persistence.ts y platform/durable-audit.ts conectan el outbox MySQL al API/Fleet y exigen adapter durable en composición persistente.                                                                                 | composition-units.test.ts: 19/19; pnpm test:platform --maxWorkers=1 --minWorkers=1: 41/41 archivos, 458/458 pruebas, 0 skips/fallos. MySQL y Fleet fueron sintéticos.                                                |
| Registro/versionado e integridad                                 | Migración TypeORM aditiva CreateTenantOutbox2026100900010; sin edición de baseline.                                                                                                                                                                                      | pnpm baseline:check: PASS, 12 archivos en 5 manifests. SPEC-1.4 SHA 3B4DD6FFDA5A63448F0FD1CA14D08ADA275269D4510590D3C8CCA5531AFE4C9A; ORCH-1.4 SHA D670D4B24C7596E7871346A33726141F5535ADD516085A23FE51623CDD35A762. |

### Evidencia del candidato local

- Base verificada: 17ab1231287657ffd718f55b65bd13dce5daf9e2. El commit de implementación inicial fue 4e4247156dc070c545a5e69c4289101b871dfc75 y se publicó en PR #75. El SHA autoritativo para CI y auditoría es el head actual del PR; no se fija aquí porque este registro puede cambiar el head.
- Entorno: Node 24.19.0, pnpm 11.25.0 y MySQL 8.0.45 efímero en loopback (127.0.0.1:13306), únicamente datos sintéticos. No se usó AWS ni una base existente.
- En ejecución serial, pnpm test:platform --maxWorkers=1 --minWorkers=1 terminó con 41/41 archivos, 458/458 pruebas y cero skips; composición: 99.41% líneas/sentencias, 95.4% ramas y 99.07% funciones (umbrales satisfechos). El outbox restart ejecutó 2/2 y Fleet migrations 3/3.
- La suite de integración MySQL audit ejecutó 12/12 y las unitarias audit 8/8. Una primera repetición del test de backoff encontró una expectativa vieja que pedía handlerCompleted: undefined; como el DTO omite ese campo cuando es falso, se eliminó solo esa expectativa y la repetición pasó 12/12.
- pnpm lint, pnpm typecheck, pnpm build, pnpm baseline:check, git diff --check y Prettier dirigido a todos los archivos cambiados: PASS. pnpm format:check global falla solo en los cinco archivos preexistentes indicados abajo.
- Una ejecución de la suite de plataforma con dos workers agotó el hook de 120 s de tests/e2e/fleet/migrations.test.ts; la suite pasó 3/3 al aislarla y luego en la ejecución completa serial de 1 worker. Se registra la diferencia para reproducibilidad.
- pnpm format:check global sigue bloqueado por cinco archivos preexistentes fuera de este diff: pnpm-workspace.yaml, e2e/browser-app/index.html, e2e/browser-app/stories.html, e2e/browser-app/web.html y apps/web/app/index.html. No se modificaron para esta tarea.
- pnpm-lock.yaml no tiene diff. El status del worktree no incluye artefactos de build o reportes generados; solo fuentes, pruebas y este registro de tarea.

El checkpoint reduce la repetición del handler después de que handler_completed queda confirmado. Un crash entre el efecto externo del handler y el commit de ese checkpoint aún puede volver a invocar el handler; cada handler con efectos externos debe ser idempotente usando (tenantId,eventId). No se declara G2 pasado: CI del SHA candidato, una auditoría independiente única por SHA y aceptación del orquestador permanecen pendientes.
