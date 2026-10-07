# AUDIT-PERSIST-G2 — persistencia tenant-scoped del AuditStore global

```yaml
id: AUDIT-PERSIST-G2-20261007
baseline: [SPEC-1.3, ORCH-1.3, inherited: SPEC-1.0/ORCH-1.0, SPEC-1.1/ORCH-1.1, SPEC-1.2/ORCH-1.2]
active_provider: openai
model: gpt-6-luna
milestone: M2
kind: implementation
base_sha: a324fb9cd9e288fe2b4147e19b8f8691e7758b00
status: package-ready; implementation not started
depends_on: [CORE-AUDIT-M1-20261004, CORE-INTEGRATE-M1-20261006, FLT-INTEGRATE-G2-20261007]
requirements:
  [FR-170, FR-171 (tenant-scoped backend prerequisite only), NFR-SC2, SPECS-4, SPECS-4.4, SPECS-5.2]
source_decisions: [ADR-0004, ADR-0005, ADR-0006, ADR-0001, ADR-0002]
write_paths:
  [
    packages/platform/audit/**,
    packages/persistence/audit/**,
    apps/api/composition/**,
    apps/api/files/**,
    packages/platform/files/**,
    apps/worker/base/**,
    apps/worker/composition/**,
    infra/runtime/**,
    tests/integration/platform/**,
    tests/e2e/fleet/**,
    tests/harness/**,
    package.json,
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
    apps/api/composition/**,
    apps/worker/base/**,
  ]
forbidden_paths:
  [
    SPECS.md,
    Orchestrator.md,
    docs/baselines/**,
    Tasks.md,
    .orchestrator/**,
    .env*,
    pnpm-lock.yaml,
    packages/contracts/**,
    infra/aws/**,
  ]
acceptance:
  - 'Given audit append/read calls from API, files and worker, When the selected storage adapter is MySQL, Then every acknowledged event is durably stored and readable after adapter/process restart, with failures propagated or retried according to the approved atomicity decision.'
  - 'Given tenant A and B with a repeated eventId, When each appends and reads its event, Then uniqueness is scoped to (tenantId,eventId), both tenants retain their own event, and no query path can enumerate or return another tenant’s events.'
  - 'Given a duplicate (tenantId,eventId), When identical content is retried, Then append is idempotent; When immutable identity is reused with different content, Then the adapter returns a deterministic conflict and never overwrites the original.'
  - 'Given raw audit input containing unknown fields, PII or credentials, When it reaches the persistence boundary, Then only the allowlisted sanitized representation is stored and returned.'
  - 'Given the runtime database account, When it attempts DDL, UPDATE or DELETE on audit rows, Then MySQL denies the operation; the separate migrator can apply/revert versioned schema changes.'
  - 'Given a synthetic MySQL 8 database and concurrent writers/readers, When restart, transient DB failure, retries and tenant A/B races are exercised, Then committed events remain immutable, deduplicated and tenant-isolated, and CI actually executes every scenario.'
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
  ]
integration_cases:
  [
    MySQL 8 migration/grants,
    runtime DDL denial,
    restart durability,
    two-connection concurrent append,
    retry after transient failure,
    A/B same eventId isolation,
    permission-gated tenant-scoped read,
    worker checkpoint/retry without handler replay,
    fail-closed behavior per approved atomicity decision,
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
  ]
non_goals:
  [
    cross-tenant query,
    UI/S26 export,
    public contract changes,
    unapproved retention/partitioning,
    AWS,
    production,
    M3,
    real data,
  ]
max_repair_cycles: 3
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

El estado actual en `packages/platform/audit/src/index.ts` es `append(event): void` y `list(tenantId): readonly PersistedAuditEvent[]`; `Platform.listAudit` autentica y exige `view_audit`, y entrega `context.tenantId` al store. El valor predeterminado de composición continúa siendo `InMemoryAuditStore`. Los registros de historial de cada dominio no sustituyen el AuditStore global persistente.

La baseline de esta tarea es SPEC/ORCH-1.3 por instrucción directa vigente del usuario, con ADR-0006. `docs/baselines/ACTIVE.md` declara 1.4; se registra aquí únicamente como discrepancia del checkout, sin adoptar 1.4 ni modificar baselines/manifests. Las fuentes inspeccionadas son SPECS §4/§4.4 (aislamiento y matriz A/B), §5.2 (mutación, historial, audit local y outbox atómicos), §8 (design system primero) y §10 (gates acumulativos), además de Orchestrator §3/§6/§7. El prompt de preparación mencionó SPECS §13/§15, pero la SPECS heredada en este checkout no tiene esos encabezados; la trazabilidad funcional aplicable está en BRD §16, FR-170/171, NFR-SC2 y S26. Esta discrepancia no altera el baseline.

AWS y staging real siguen diferidos por ADR-0002. Usar únicamente datos sintéticos y MySQL 8 efímero local/CI; no conectar ni aprovisionar AWS, producción o una base existente.

## Decisiones de contrato obligatorias antes de implementar

El paquete no adopta una semántica incompatible por inferencia. El orquestador/propietario debe registrar la decisión y, si corresponde, versionar el contrato antes de iniciar implementación:

| Decisión                  | Evidencia y tensión                                                                                                                                                                                                                        | Requisito para la decisión de entrada                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interfaz async            | TypeORM requiere I/O asíncrono; el port actual es síncrono y varios call sites ignoran el resultado.                                                                                                                                       | Aprobar `append(event): Promise<void>` y `list(tenantId, filters?): Promise<readonly PersistedAuditEvent[]>` o interfaz equivalente; propagar `await` y errores. Mantener el argumento de tenant interno, tomado de contexto autenticado, no de una entrada pública. Definir compatibilidad para `InMemoryAuditStore` y pruebas.                                                                                                                                                                          |
| Atomicidad con el comando | SPECS §5.2 exige comando + historial + audit local + outbox atómicos. BRD §16.3 describe almacenamiento de audit separado del transaccional. El worker ya checkpointa el handler antes de append y reintenta audit sin repetir el handler. | Elegir y documentar una estrategia compatible antes de declarar durable: escritura audit dentro de la transacción del comando en la misma base tenant, o un outbox de auditoría durable escrito atómicamente con el comando y consumido idempotentemente. No afirmar atomicidad ni aceptar “el comando respondió éxito, se perdió audit”. Determinar qué operación queda bloqueada/reintentable si la persistencia falla. Sin esta decisión el requisito permanece P1 y la tarea/gate no puede aceptarse. |
| Conflicto idempotente     | El store en memoria conserva silenciosamente el primer evento para la misma clave.                                                                                                                                                         | Definir igualdad canónica para retry idéntico y respuesta estable de conflicto cuando `(tenantId,eventId)` coincide con contenido diferente; nunca actualizar una fila existente.                                                                                                                                                                                                                                                                                                                         |
| Consulta y FR-171         | El endpoint actual entrega la lista completa del tenant autorizado; el BRD pide filtros/exportación y el UI S26.                                                                                                                           | Esta tarea cubre persistencia y lectura tenant-scoped necesarias para G2. No crear UI, exportación ni capacidades nuevas de filtros; aclarar paginación/orden/límite para evitar lectura ilimitada. FR-171 de producto sigue parcialmente abierto hasta su paquete UI/API propio.                                                                                                                                                                                                                         |
| NFR-SC2 / retención       | BRD propone particionar auditoría por fecha y BRD §16.3 pide retención mínima de cinco años como decisión normativa pendiente.                                                                                                             | Confirmar si partición/retención se implementan ahora o se mantienen explícitamente pendientes; no borrar filas ni fijar una retención normativa por inferencia. Índices comienzan por tenant y usan los filtros/orden acordados.                                                                                                                                                                                                                                                                         |

La lista actual de call sites que debe migrar/probar incluye: `PlatformKernel.auditNow` y sus usos en `apps/api/composition/src/platform/{apis,invitations,members,sessions,settings}.ts`; la lectura `listAudit` en `apps/api/composition/src/platform/events.ts`; `packages/platform/files/src/pipeline.ts`; `apps/api/files/src/index.ts` (escrituras y rutas de error); y `apps/worker/base/src/index.ts` (append posterior al checkpoint). Composición/inyección está en `apps/api/composition/src/platform.ts`, `platform/types.ts` y `apps/worker/composition/src/index.ts`. Actualizar pruebas/mocks que consumen esos ports; buscar todos los usos antes de editar y no asumir que esta lista sustituye al grep del implementador.

## Requisitos de persistencia y seguridad

- Tabla append-only con identidad compuesta `(tenant_id,event_id)` (o mapeo `company_id` equivalente), `tenant_id` presente en claves/índices, timestamps UTC, campos tipados y datos allowlisted. Mismo `eventId` en tenants diferentes es válido.
- Sanitizar de nuevo en el límite del adaptador, incluso si quien llama entrega un evento raw. Persistir solo los campos tipados actuales y `AuditData` allowlisted; no guardar cuerpos HTTP, secretos, credenciales, PII libre, valores previos/nuevos sin política aprobada, ni campos extra. Verificar actor/correlation/entity IDs y manejo de entrada inválida con las reglas actuales de `packages/platform/audit`.
- Consultas parametrizadas siempre restringidas por tenant y filtros permitidos. `view_audit` se exige antes de ejecutar la lectura; se deriva tenant desde `TenantContext`, sin aceptar tenant de body/query/header. No debe existir API de store para `listAllTenants`.
- Runtime DB user obtiene solo `SELECT`/`INSERT` (y permisos mínimos expresamente justificados) sobre la tabla de auditoría; nunca DDL, `UPDATE`, `DELETE`, `GRANT` o privilegio master. Cuenta/rol de migración independiente, limitado a DDL. Probar grants efectivos contra MySQL, no solo inspeccionar configuración.
- Fallo de base, timeout, violación de clave o dato inválido no puede convertirse en append exitoso ni en lectura vacía. La escritura sigue la estrategia de atomicidad acordada; el worker conserva la semántica de no reejecutar el handler después de `handlerCompleted` y no reconoce el evento hasta completar la persistencia requerida. No filtrar error/PII en respuesta o log.
- Cambios de esquema mediante migraciones TypeORM versionadas y reversibles sin pérdida; no usar `synchronize:true`. Aplicar migración con rol migrador y probar que la cuenta runtime no puede aplicarla. Ningún cambio destructivo a esquemas ya aplicados.

## Aceptación reproducible Given / When / Then

1. **Persistencia/reinicio.** Given MySQL 8 efímero y tenant sintético A, When el adapter confirma append y se destruye/recrea la conexión/proceso, Then `list(A)` devuelve el evento allowlisted una sola vez. Al no haber conexión o fallar INSERT, append rechaza y la operación sigue exactamente el comportamiento fail-closed/outbox acordado; ninguna ruta informa éxito sin evidencia durable.
2. **Idempotencia y carrera.** Given dos instancias de adapter y escrituras simultáneas para el mismo `(A,eventId)`, When ambas envían el mismo evento canónico, Then existe una fila y ambas terminan de forma determinista; si payloads difieren, una fila original permanece intacta y la otra recibe conflicto. Para `(B,eventId)` igual, existe otra fila independiente. Repetir tras reinicio produce el mismo resultado.
3. **Aislamiento de lectura.** Given A/B con IDs iguales y un actor de A autorizado `view_audit`, When consulta su audit store/BFF, Then solo obtiene filas de A; actor sin permiso recibe el error uniforme y la consulta no se ejecuta. Intentos con tenant B suministrado por cliente no alteran el tenant de contexto. Comprobar respuesta, SQL/resultados y ausencia de filtración en errores.
4. **Sanitización persistente.** Given un evento raw con email/teléfono, token, texto libre, claves desconocidas, actor no opaco o campo extra, When append pasa por el adapter, Then esos valores no aparecen en columnas, JSON, respuesta de list, logs ni artefactos de prueba; los campos inválidos de identidad son rechazados, no convertidos a una clave que pueda colisionar.
5. **Grants/immutability.** Given migrador y runtime con usuarios MySQL separados, When migrator ejecuta up/down en esquema sintético, Then migración funciona; When runtime intenta DDL, UPDATE o DELETE, Then MySQL lo deniega. Append duplicate no actualiza ni reemplaza la fila. No utilizar credenciales administrativas para solicitudes de aplicación.
6. **Crash/retry y atomicidad.** Given un comando de negocio y evento de audit, When el proceso falla entre commit del comando y persistencia audit, Then el mecanismo decidido recupera el evento sin duplicar el comando ni declararlo completo antes de evidencia durable. Para outbox worker, con `handlerCompleted` persistido y audit fallido, retry solo vuelve a intentar el audit append y no vuelve a ejecutar el handler. Simular fallo, reinicio y concurrencia con MySQL real.
7. **Cobertura efectiva.** Given el CI candidato, When corren comandos del paquete, Then la suite MySQL nueva se descubre y ejecuta (sin `skip`), junto con unitarias, plataforma, typecheck, lint, format, build y calidad; la evidencia reporta SHA exacto, versión de Node/pnpm/MySQL, fixture sintética, resultado y cualquier check faltante. Una prueba de archivo presente no cuenta como ejecución.

## Trazabilidad requisito → port → implementación propuesta → prueba

| Requisito/fuente                   | Contrato actual / brecha                                                                                                | Implementación propuesta (no escrita aún)                                                                                                                                                                    | Prueba/evidencia requerida                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| FR-170; BRD §16.1–16.3; SPECS §5.2 | `AuditStore` sync e in-memory; append deduplica por tenant/evento; `PersistedAuditEvent` allowlisted.                   | `packages/platform/audit/**` (port async/semántica acordada) y nuevo `packages/persistence/audit/**` (entidad, store TypeORM, migración).                                                                    | Unitarias sanitización/idempotencia/conflicto; MySQL insert/read/restart/concurrencia/grants.                            |
| SPECS §4 y §4.4; NFR-SC2 propuesto | `listAudit` requiere `view_audit` y deriva tenant de sesión; no debe ampliarse a una consulta cross-tenant.             | `apps/api/composition/**`, `apps/api/files/**`, `packages/platform/files/**`, `apps/worker/base/**`, `apps/worker/composition/**`, `infra/runtime/**`: inyección, awaits, fallo/retry y query tenant-scoped. | A/B con IDs iguales, role deny/allow, inspección de filas/resultado SQL y ausencia de datos ajenos.                      |
| FR-171 / S26 (parcial)             | BRD pide consulta global filtrable/exportable; el endpoint actual lista audit del tenant sin filtros y sin UI completa. | Mantener endpoint actual tenant-scoped y límites de lectura; filtros/export/UI quedan fuera hasta paquete propio.                                                                                            | Contrato HTTP autorizado y prueba de tenant/permisos; documentar gap restante sin atribuir cumplimiento total de FR-171. |
| Outbox M1 / worker                 | Worker guarda `handlerCompleted` antes de audit append y, ante error, recupera para retry sin reejecutar handler.       | Preservar/revisar `apps/worker/base/**` y añadir adapter durable en esa ruta después de decidir atomicidad.                                                                                                  | MySQL crash/restart con checkpoint + audit retry, error SQL, dedup y contador/efecto de handler exactamente una vez.     |
| SPECS §5.2 vs BRD §16.3            | Alcance de atomicidad/almacenamiento separado requiere resolución explícita.                                            | Decisión/contrato antes de código; luego incluir transacción/outbox que corresponda dentro de rutas reservadas.                                                                                              | Escenario crash de aceptación 6, evidencia durable y documentación de límites.                                           |

## Paths, dependencias y límites de implementación

Paths propuestos son los `write_paths` del frontmatter. El paquete `packages/persistence/audit/**` es nuevo; confirmar su registro en los globs de workspace y las referencias TypeScript. Si configuración compartida adicional, workflow, `packages/contracts/**`, manifests, migración fuera del slice, o código consumidor no enumerado resulta necesario, detenerse y pedir paquete/lease ampliado antes de tocarlo. `pnpm-lock.yaml` no se edita salvo coordinación explícita separada.

No cambiar baselines, contratos públicos BFF/HTTP, modelo de permisos, UI, exportación S26, formato de reportes, retención normativa, particionamiento, flujos M3, AWS, producción ni datos reales. La aprobación de este paquete no equivale a aceptación de implementación o G2. Dependencia crítica: resolución de interfaz async y atomicidad arriba; hasta que exista, son bloqueantes explícitos, no supuestos del autor.

## Comandos y evidencia

Usar runtime fijado Node `24.19.0` y pnpm `11.25.0`. Ejecutar las pruebas focales audit/platform/API files/worker, después `pnpm test:integration` contra MySQL 8 real efímero, y todos los comandos del frontmatter en el SHA candidato. `pnpm quality` debe incluir las pruebas nuevas y el harness; verificar los logs para confirmar que suites MySQL y fleet se ejecutaron. `pnpm test:e2e` valida el BFF disponible; no sustituye integración MySQL. `pnpm test:visual` solo si el cambio modifica UI o los gates del repo lo exigen; snapshots no se regeneran sin inspección visual. `baseline:check`, format, lint, typecheck, unit, platform, integration, build y quality no se reportan PASS salvo ejecución observable sobre el SHA señalado. La CI requerida y única auditoría independiente por PR/headSHA siguen siendo necesarias bajo SPEC/ORCH-1.3.

AWS continúa diferido por ADR-0002. No declarar aceptada la tarea ni G2; el orquestador verifica CI, auditoría, merge y evidencia acumulativa del gate conforme a ORCH §6–§7.
