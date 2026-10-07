# AUDIT-PERSIST-G2 — persistencia tenant-scoped del AuditStore global

```yaml
id: AUDIT-PERSIST-G2-20261007
baseline: [SPEC-1.3, ORCH-1.3, inherited: SPEC-1.0/ORCH-1.0, SPEC-1.1/ORCH-1.1, SPEC-1.2/ORCH-1.2]
active_provider: openai
model: gpt-6-luna
milestone: M2
kind: implementation
base_sha: 4a1e18d97f8d290bd250c1853886df28867bcfb3
status: package-ready; implementation not started
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
  - 'Given a business mutation in a module, When its local transaction commits, Then its history and sanitized durable audit-outbox record commit in the same module DataSource transaction; the command may acknowledge after that durable outbox exists, while global audit visibility may lag until relay.'
  - 'Given the audit relay, When it reads a pending tenant-scoped outbox item, Then it appends idempotently to the global date-partitioned audit log and registry and acknowledges the local outbox only after the global append transaction commits.'
  - 'Given tenant A and B with a repeated eventId, When each appends and reads its event, Then uniqueness is scoped to (tenantId,eventId), both tenants retain their own event, and no query path can enumerate or return another tenant’s events.'
  - 'Given a duplicate (tenantId,eventId), When identical content is retried, Then append is idempotent; When immutable identity is reused with different content, Then the adapter returns a deterministic conflict and never overwrites the original.'
  - 'Given raw audit input containing unknown fields, PII or credentials, When it reaches the persistence boundary, Then only the allowlisted sanitized representation is stored and returned.'
  - 'Given the runtime database account, When it attempts DDL, UPDATE or DELETE on audit rows, Then MySQL denies the operation; the separate migrator can apply/revert versioned schema changes.'
  - 'Given a synthetic MySQL 8 database and concurrent writers/readers, When restart, transient DB failure, retries and tenant A/B races are exercised, Then committed events remain immutable, deduplicated and tenant-isolated, failed relays remain retryable, and CI actually executes every scenario.'
  - 'Given NFR-SC2, When the schema is applied to MySQL 8, Then the audit event log is partitioned by date and queries constrain tenant plus the relevant time range; partition rollover is tested without deleting retained audit data.'
  - 'Given the same (tenantId,eventId) is retried with a different event date/partition, When MySQL persists the retry, Then global idempotency still holds and the original event is never duplicated or overwritten.'
  - 'Given a file operation spans MySQL records, object storage, scanner/queue and audit relay, When any external step fails, Then the durable file saga records its state and retries or compensates idempotently; no partial object is exposed or reported complete, and no cross-DataSource transaction is claimed.'
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
    module-local audit-outbox row and history share the business EntityManager transaction,
    rollback removes business mutation, history and audit-outbox together,
    file saga state transitions and compensation remain idempotent,
  ]
integration_cases:
  [
    MySQL 8 migration/grants,
    runtime DDL denial,
    restart durability,
    two-connection concurrent append,
    retry after transient failure,
    local command mutation/history/audit-outbox atomic commit per module DataSource,
    relay append/ack ordering across independent DataSources,
    failed local audit-outbox insert rolls back the module business mutation and history,
    no cross-DataSource transaction is assumed,
    A/B same eventId isolation,
    date partition creation/rollover and partition-pruned tenant/time reads,
    duplicate eventId across dates remains globally idempotent,
    permission-gated tenant-scoped read,
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
    disposable MySQL 8 database and separate synthetic migrator/runtime accounts,
    synthetic module databases/DataSources matching existing integration harnesses,
    deterministic object-store/scanner/queue failure injection for file saga,
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

Reemplazar el adaptador de auditoría en memoria por una implementación TypeORM/MySQL durable que conserve el contrato de auditoría y la idempotencia por tenant. “Global” significa consultar el registro de auditoría de toda la empresa/tenant autorizado, conforme a FR-171 y S26; no significa una consulta multi-tenant ni una capacidad de soporte que pueda enumerar empresas. El tenant se deriva del contexto de sesión confiable y se valida en toda lectura y escritura. No añadir endpoint de consulta cross-tenant, filtro de tenant proporcionado por el cliente, impersonación ni acceso global de operador.

`FLT-INTEGRATE-G2-20261007` es un consumidor bloqueado por la ausencia de audit durable y el contexto de remediación que este paquete busca desbloquear; no es dependencia previa para iniciar esta tarea.

El estado actual en `packages/platform/audit/src/index.ts` es `append(event): void` y `list(tenantId): readonly PersistedAuditEvent[]`; `Platform.listAudit` autentica y exige `view_audit`, y entrega `context.tenantId` al store. El valor predeterminado de composición continúa siendo `InMemoryAuditStore`. Los registros de historial de cada dominio no sustituyen el AuditStore global persistente.

La baseline de esta tarea es SPEC/ORCH-1.3 por instrucción directa vigente del usuario, con ADR-0006. `docs/baselines/ACTIVE.md` declara 1.4; se registra aquí únicamente como discrepancia del checkout, sin adoptar 1.4 ni modificar baselines/manifests. Las fuentes inspeccionadas son SPECS §4/§4.4 (aislamiento y matriz A/B), §5.2 (mutación, historial, audit local y outbox atómicos), §8 (design system primero) y §10 (gates acumulativos), además de Orchestrator §3/§6/§7. El prompt de preparación mencionó SPECS §13/§15, pero la SPECS heredada en este checkout no tiene esos encabezados; la trazabilidad funcional aplicable está en BRD §16, FR-170/171, NFR-SC2 y S26. Esta discrepancia no altera el baseline.

AWS y staging real siguen diferidos por ADR-0002. Usar únicamente datos sintéticos y MySQL 8 efímero local/CI; no conectar ni aprovisionar AWS, producción o una base existente.

## Decisiones aprobadas y límites de consistencia

El propietario registró la decisión de usar un `AuditStore` interno asíncrono y un outbox de auditoría local transaccional con relay idempotente. La implementación debe respetar estas semánticas; no requiere una nueva decisión previa. El port asíncrono es interno y no amplía el contrato público BFF/HTTP.

| Decisión                       | Evidencia/contexto                                                                                                                                              | Semántica aprobada y exigible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interfaz async                 | El port actual es sync, pero los adaptadores TypeORM requieren I/O async.                                                                                       | `append(event): Promise<void>` y `list(tenantId, filters?): Promise<readonly PersistedAuditEvent[]>` o equivalente interno. Propagar y esperar errores; `list` deriva tenant del contexto autenticado. `append` en el store global confirma el commit del evento/registry, y `list` consulta solo el tenant autorizado.                                                                                                                                                                                                                                                                                       |
| Atomicidad local y visibilidad | Los módulos tienen transacciones TypeORM independientes con DataSource/EntityManager propios; APIs hoy emiten audit después de que el servicio retorna.         | En cada módulo, guardar la mutación de negocio, su historia y el evento sanitizado de audit en el outbox local dentro de la misma transacción/EntityManager. La respuesta de comando puede confirmar tras ese commit durable. Un relay copia idempotentemente al audit log global y confirma el outbox local solo después del commit remoto. La consulta global puede tener lag hasta que el relay procese.                                                                                                                                                                                                   |
| Límites entre DataSources      | No existe transacción distribuida entre las bases de los módulos y el audit store global.                                                                       | No afirmar atomicidad cross-DataSource. Fallos de relay conservan el outbox local y reintentan sin duplicar el evento; global append y registry forman una transacción única en la DataSource global.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Files y efectos externos       | El pipeline separa MySQL de registros, object storage, scanner/queue y audit; esos efectos no comparten una transacción.                                        | Tratarlo como saga con intent/state durables y eventos de audit-outbox en la transacción local disponible; cada paso externo es reintentable/compensable e idempotente. No exponer un archivo antes de completar checks/registro. `packages/persistence/files/**` se incluye porque hoy no existe y se requiere para estado durable de la saga. Antes de iniciar este sub-slice, mapear cada efecto externo a transición durable/retry/compensación; si queda un seam sin resolver, detener solo el sub-slice de files y reportar el bloqueo concreto antes de escribirlo. Nunca alegar atomicidad imposible. |
| Conflicto idempotente          | El store en memoria conserva silenciosamente el primer evento para la misma clave.                                                                              | Igual retry canónico para `(tenantId,eventId)` es éxito idempotente; la misma clave con contenido distinto produce conflicto determinista. Nunca actualizar una fila existente. La registry no particionada mantiene unicidad a través de particiones de fecha.                                                                                                                                                                                                                                                                                                                                               |
| Consulta y FR-171              | El endpoint actual entrega la lista del tenant autorizado; BRD pide filtros/exportación y UI S26.                                                               | Esta tarea cubre persistencia y lectura tenant-scoped para G2. No crear UI, exportación ni contrato público nuevo; mantener paginación/orden/límite seguros. FR-171 queda parcialmente abierto hasta el paquete de UI/API correspondiente.                                                                                                                                                                                                                                                                                                                                                                    |
| NFR-SC2 / retención            | NFR-SC2 exige particionar audit log y notificaciones por fecha; aquí aplica el audit log. BRD §16.3 etiqueta cinco años como `[DECISION REQUIRED — normativa]`. | Implementar particiones de audit por fecha y probar creación/rotación y lecturas tenant+tiempo. Cinco años permanece pendiente de decisión normativa; no borrar filas ni inventar política. Índices/query plans comienzan por tenant y acotan fecha cuando aplique.                                                                                                                                                                                                                                                                                                                                           |

La lista actual de call sites que debe migrar/probar incluye: `PlatformKernel.auditNow` y sus usos en `apps/api/composition/src/platform/{apis,invitations,members,sessions,settings}.ts`; la lectura `listAudit` en `apps/api/composition/src/platform/events.ts`; `packages/platform/files/src/pipeline.ts`; `apps/api/files/src/index.ts` (escrituras y rutas de error); y `apps/worker/base/src/index.ts` (checkpoint y append posterior). Hoy varias APIs registran audit después de que retorna el servicio: mover la creación del evento a la transacción local del módulo para que el insert del audit-outbox use exactamente su `EntityManager`/DataSource transaccional, y no un manager global o una conexión independiente. Composición/inyección está en `apps/api/composition/src/platform.ts`, `platform/types.ts` y `apps/worker/composition/src/index.ts`. `AuditStore.append` asíncrono representa la escritura idempotente a la proyección global desde el relay; una API/servicio escribe primero mediante el writer transaccional local. `AuditStore.list` es async y sirve solo filas globales ya entregadas del tenant autenticado. Actualizar pruebas/mocks que consumen esos ports; buscar todos los usos antes de editar y no asumir que esta lista sustituye al grep del implementador.

## Requisitos de persistencia y seguridad

- Tabla append-only con identidad compuesta `(tenant_id,event_id)` (o mapeo `company_id` equivalente), `tenant_id` presente en claves/índices, timestamps UTC, campos tipados y datos allowlisted. Mismo `eventId` en tenants diferentes es válido.
- NFR-SC2 es requisito explícito: particionar el audit log por fecha. La política de retención de cinco años está separadamente marcada como `[DECISION REQUIRED — normativa]` en BRD §16.3 y permanece pendiente; particionar no autoriza a eliminar datos. MySQL 8 exige que toda columna de la expresión de partición esté en cada clave única de una tabla particionada ([MySQL 8.0 Reference Manual, §26.6.1](https://dev.mysql.com/doc/refman/8.0/en/partitioning-limitations-partitioning-keys-unique-keys.html)). Como el requisito de idempotencia `(tenant_id,event_id)` debe aplicar entre fechas/particiones, implementar una tabla-registro no particionada con esa clave compuesta y huella del evento, escrita atómicamente con la fila append-only en la partición temporal; comparar duplicados con la huella y rechazar contenido distinto sin actualizar. Si se propone otra estructura, demostrar la misma unicidad global en MySQL real antes de aceptarla.
- Sanitizar de nuevo en el límite del adaptador, incluso si quien llama entrega un evento raw. Persistir solo los campos tipados actuales y `AuditData` allowlisted; no guardar cuerpos HTTP, secretos, credenciales, PII libre, valores previos/nuevos sin política aprobada, ni campos extra. Verificar actor/correlation/entity IDs y manejo de entrada inválida con las reglas actuales de `packages/platform/audit`.
- Consultas parametrizadas siempre restringidas por tenant y filtros permitidos. `view_audit` se exige antes de ejecutar la lectura; se deriva tenant desde `TenantContext`, sin aceptar tenant de body/query/header. No debe existir API de store para `listAllTenants`.
- Runtime DB user obtiene solo `SELECT`/`INSERT` (y permisos mínimos expresamente justificados) sobre la tabla de auditoría y la tabla-registro de idempotencia; nunca DDL, `UPDATE`, `DELETE`, `GRANT` o privilegio master. Cuenta/rol de migración independiente, limitado a DDL. Probar grants efectivos contra MySQL, no solo inspeccionar configuración.
- Fallo del insert local de audit-outbox, history o mutación aborta juntos la transacción local; el comando no confirma. Tras commit local, un fallo del relay no revierte ni repite el comando: conserva el evento pendiente y reintenta idempotentemente hasta confirmar la transacción global, antes de reconocer/borrar/avanzar el outbox local. `list` ante error de lectura rechaza, no responde con lista vacía. El worker conserva la semántica de no reejecutar handler después de `handlerCompleted`. No hay transacción distribuida entre DataSources. No filtrar error/PII en respuesta o log.
- Cambios de esquema mediante migraciones TypeORM versionadas y reversibles sin pérdida; no usar `synchronize:true`. Aplicar migración con rol migrador y probar que la cuenta runtime no puede aplicarla. Ningún cambio destructivo a esquemas ya aplicados.

## Aceptación reproducible Given / When / Then

1. **Persistencia/reinicio.** Given MySQL 8 efímero y tenant sintético A, When una transacción local confirma mutación, history y audit-outbox y se destruye/recrea el proceso antes de relay, Then la operación de negocio ya confirmada se recupera con el item pendiente; tras relay, `list(A)` devuelve el evento allowlisted una sola vez. Si falla el insert local, se revierten juntos mutación e historia; si falla el relay, el item sigue pendiente y `list` global puede retrasarse sin mentir sobre entrega.
2. **Idempotencia y carrera.** Given dos instancias de adapter y escrituras simultáneas para el mismo `(A,eventId)`, When ambas envían el mismo evento canónico, Then existe una fila y ambas terminan de forma determinista; si payloads difieren, una fila original permanece intacta y la otra recibe conflicto. Para `(B,eventId)` igual, existe otra fila independiente. Repetir tras reinicio produce el mismo resultado.
3. **Aislamiento de lectura.** Given A/B con IDs iguales y un actor de A autorizado `view_audit`, When consulta su audit store/BFF, Then solo obtiene filas de A; actor sin permiso recibe el error uniforme y la consulta no se ejecuta. Intentos con tenant B suministrado por cliente no alteran el tenant de contexto. Comprobar respuesta, SQL/resultados y ausencia de filtración en errores.
4. **Sanitización persistente.** Given un evento raw con email/teléfono, token, texto libre, claves desconocidas, actor no opaco o campo extra, When append pasa por el adapter, Then esos valores no aparecen en columnas, JSON, respuesta de list, logs ni artefactos de prueba; los campos inválidos de identidad son rechazados, no convertidos a una clave que pueda colisionar.
5. **Grants/immutability.** Given migrador y runtime con usuarios MySQL separados, When migrator ejecuta up/down en esquema sintético, Then migración funciona; When runtime intenta DDL, UPDATE o DELETE sobre la tabla de auditoría o la tabla-registro de idempotencia, Then MySQL lo deniega. Append duplicate no actualiza ni reemplaza ninguna fila. No utilizar credenciales administrativas para solicitudes de aplicación.
6. **Crash/retry y atomicidad.** Given un comando de negocio y evento de audit, When el proceso falla después del commit local y antes de relay, Then el comando no se repite y el relay recupera el evento durable; When falla después de commit global pero antes de marcar el outbox local entregado, Then retry no duplica ni cambia el evento global. Para worker, `handlerCompleted` persistido hace que retry solo vuelva a intentar audit relay/append sin invocar el handler. Simular cada ventana, reinicio y concurrencia con MySQL real, sin transacción cross-DataSource.
7. **Cobertura efectiva.** Given el CI candidato, When corren comandos del paquete, Then la suite MySQL nueva se descubre y ejecuta (sin `skip`), junto con unitarias, plataforma, typecheck, lint, format, build y calidad; la evidencia reporta SHA exacto, versión de Node/pnpm/MySQL, fixture sintética, resultado y cualquier check faltante. Una prueba de archivo presente no cuenta como ejecución.

## Trazabilidad requisito → port → implementación propuesta → prueba

| Requisito/fuente                   | Contrato actual / brecha                                                                                                | Implementación propuesta (no escrita aún)                                                                                                                                                                                                                                                                                                       | Prueba/evidencia requerida                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-170; BRD §16.1–16.3; SPECS §5.2 | `AuditStore` sync e in-memory; `PersistedAuditEvent` allowlisted; APIs hoy auditan tras retorno de algunos servicios.   | `packages/platform/audit/**` (port async), `packages/platform/outbox/**`, nuevo `packages/persistence/audit/**` (relay, proyección particionada y registry), y cada dominio/persistencia listado en `write_paths` (outbox local en el EntityManager del comando).                                                                               | Unitarias sanitizer/canonical hash; rollback conjunto; MySQL local-outbox→relay→registry/log/restart/concurrencia/grants.                        |
| Atomicidad por módulo              | Cada módulo TypeORM usa su propio DataSource/EntityManager; no hay transacción global compartida.                       | `packages/domain/{areas,assignments,documents,employees,files,identity,imports,insurance,settings,tenants,vehicles,alerts}/**` y `packages/persistence/{areas,assignments,documents,employees,files,identity,imports,insurance,settings,tenancy,vehicles}/**`; insertar evento sanitizado dentro de la transacción local con historia y cambio. | Unitarias y MySQL por módulo: prueba rollback si falla el audit-outbox y commit conjunto de mutation/history/outbox; ejecutar suites enumeradas. |
| SPECS §4 y §4.4; NFR-SC2           | `listAudit` requiere `view_audit` y deriva tenant de sesión; no debe ampliarse a una consulta cross-tenant.             | `apps/api/composition/**`, `apps/api/files/**`, `packages/platform/files/**`, `apps/worker/base/**`, `apps/worker/composition/**`, `infra/runtime/**`: inyección, awaits, fallo/retry y query tenant-scoped.                                                                                                                                    | A/B con IDs iguales, role deny/allow, inspección de filas/resultado SQL y ausencia de datos ajenos.                                              |
| FR-171 / S26 (parcial)             | BRD pide consulta global filtrable/exportable; el endpoint actual lista audit del tenant sin filtros y sin UI completa. | Mantener endpoint actual tenant-scoped y límites de lectura; filtros/export/UI quedan fuera hasta paquete propio.                                                                                                                                                                                                                               | Contrato HTTP autorizado y prueba de tenant/permisos; documentar gap restante sin atribuir cumplimiento total de FR-171.                         |
| Outbox M1 / worker                 | Worker guarda `handlerCompleted` antes del relay audit y ya evita reejecutar el handler tras fallo de append.           | Mantener checkpoint; el item de audit local se conserva y el relay solo confirma luego de commit global. `apps/worker/base/**`, `apps/worker/composition/**` y stores locales.                                                                                                                                                                  | MySQL crash/restart en ambas ventanas, append global idempotente y contador/efecto de handler no repetido.                                       |
| Files y efectos externos           | `pipeline.ts` coordina registros, object storage, scanner/queue y audit, que no comparten transacción.                  | Nuevo `packages/persistence/files/**` para intent/state/outbox durable; `packages/domain/files/**` y `packages/platform/files/**` implementan saga y pasos compensables/retry. No transacción distribuida.                                                                                                                                      | Fallar cada efecto por separado, reiniciar/reintentar, validar que no se exponga registro parcial y no se pierda audit intent.                   |
| SPECS §5.2 vs BRD §16.3            | BRD describe almacenamiento audit separado; owner decidió evento local transaccional más proyección global asíncrona.   | Aplicar mutación+history+outbox local en el mismo EntityManager; relay eventual a tabla global. La proyección puede tener lag; no afirmar atomicidad cross-DataSource.                                                                                                                                                                          | Crash tests de aceptación 1/6; comprobar ambos DataSources y evidencia de estado durable y retry.                                                |

## Paths, dependencias y límites de implementación

Paths propuestos son los `write_paths` del frontmatter. Los paquetes `packages/persistence/audit/**` y `packages/persistence/files/**` son nuevos; confirmar su registro en los globs del workspace y referencias TypeScript. Se autoriza `pnpm-lock.yaml` exclusivamente para agregar los importers de esos paquetes y sus dependencias indispensables, con lease de path explícito del coordinador; no regenerar el lockfile completo ni modificar importers ajenos. Si configuración compartida adicional, workflow, `packages/contracts/**`, manifests, migración fuera del slice o código consumidor no enumerado resulta necesario, detenerse y pedir paquete/lease ampliado antes de tocarlo.

No cambiar baselines, contratos públicos BFF/HTTP, modelo de permisos, UI, exportación S26, formato de reportes, política de retención de cinco años, flujos M3, AWS, producción ni datos reales. La partición temporal del audit log es requisito de NFR-SC2 y sí forma parte del alcance. El propietario ya aprobó el port asíncrono y la arquitectura local-outbox/relay descrita; no queda pendiente esa decisión. Cualquier seam de archivos que no alcance la saga durable debe registrarse con repro y bloquear la aceptación del trabajo de archivos, sin declarar atomicidad inexistente. La aprobación de este paquete no equivale a aceptación de implementación o G2.

## Comandos y evidencia

Usar runtime fijado Node `24.19.0` y pnpm `11.25.0`. Ejecutar las pruebas focales audit/platform/API files/worker, después `pnpm test:integration` contra MySQL 8 real efímero, y todos los comandos del frontmatter en el SHA candidato. `pnpm quality` debe incluir las pruebas nuevas y el harness; verificar los logs para confirmar que suites MySQL y fleet se ejecutaron. `pnpm test:e2e` valida el BFF disponible; no sustituye integración MySQL. `pnpm test:visual` solo si el cambio modifica UI o los gates del repo lo exigen; snapshots no se regeneran sin inspección visual. `baseline:check`, format, lint, typecheck, unit, platform, integration, build y quality no se reportan PASS salvo ejecución observable sobre el SHA señalado. La CI requerida y única auditoría independiente por PR/headSHA siguen siendo necesarias bajo SPEC/ORCH-1.3.

AWS continúa diferido por ADR-0002. No declarar aceptada la tarea ni G2; el orquestador verifica CI, auditoría, merge y evidencia acumulativa del gate conforme a ORCH §6–§7.
