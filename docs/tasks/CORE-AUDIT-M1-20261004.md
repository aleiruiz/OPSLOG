# CORE-AUDIT-M1-20261004 — auditoría/outbox y worker desde cero

```yaml
id: CORE-AUDIT-M1-20261004
baseline: [SPEC-1.3, ORCH-1.3, inherited: SPEC-1.0/ORCH-1.0, SPEC-1.1/ORCH-1.1, SPEC-1.2/ORCH-1.2]
milestone: M1
kind: implementation
baseSHA: 61c35c20f1a68e4eb58802fa42759ca4335051d7
depends_on: [G0-human-reaffirmed]
write_paths: [apps/worker/base/**, packages/platform/audit/**, packages/platform/outbox/**, infra/queues/**, docs/tasks/CORE-AUDIT-M1-20261004.md]
forbidden_paths: [SPECS.md, Orchestrator.md, docs/baselines/**, Tasks.md, .orchestrator/**, .env*, pnpm-lock.yaml, packages/contracts/**, packages/persistence/**, apps/api/**]
```

Implementar completamente desde cero el slice de auditoría/outbox/worker, sin copiar PR11, sus reparaciones ni sus ramas. Cubrir eventos auditados sin PII, outbox transaccional, claim con lease/fencing, retry/backoff, DLQ, métricas, reconciliación y contexto tenant.

Semántica de entrega: la identidad del outbox se compone de tenant y eventId; idempotencyKey se deduplica dentro de ese evento. Las operaciones de lectura/ack/retry requieren tenant y eventId para evitar ambigüedad de IDs locales repetidos. El worker guarda `handlerCompleted` con el fencing antes de insertar el evento de auditoría; si `audit.append` falla, conserva el claim hasta su expiración y, al recuperarlo, reintenta solo la auditoría sin invocar de nuevo el handler. Un adaptador durable debe persistir ese checkpoint con el estado de lease. Existe una ventana inevitable ante caída entre efecto externo y checkpoint, por lo que los handlers deben ser idempotentes por `(tenantId, eventId)`.

Los adaptadores actuales de outbox/audit/queue son en memoria. La integración MySQL pertenece al harness del repositorio y no valida persistencia de estos adaptadores; no conectar pruebas a una base no identificada como sintética.

Aceptación mínima: rollback no publica; dos workers concurrentes no procesan el mismo evento; lease stale no puede mutar; retry es idempotente/deduplicable; tenant inexistente/suspendido se rechaza sin handler; redacción elimina secretos/PII; pruebas de error, concurrencia y aislamiento A/B. No modificar el gate Playwright ni manifests/lockfile.

Leer instrucciones, baselines, ADR-0001/0002/0004/0005, SESSION_HANDSHAKE, AUTONOMOUS_ORCHESTRATOR y SPECS §4–§7. Usar solo datos sintéticos. El autor no audita ni fusiona su candidato; cualquier PR nuevo requiere exactamente una auditoría independiente sobre su SHA.

## Evidencia de remediación PR #15

- Baseline sincronizada con `main@ae492e698d15fd6e03e28e786c18b9bfc24374ac`; merge upstream sin conflictos.
- Outbox deduplica por identidad de evento `(tenantId, eventId)` y acota la clave idempotente a `(tenantId, eventId, idempotencyKey)`. `get`, `acknowledge`, `retry` y checkpoint de handler requieren tenant+eventId; IDs locales iguales entre tenants no se confunden.
- Audit store deduplica por `(tenantId, eventId)` y aplica la misma redacción recursiva de campos PII/secreto y patrones en valores libres.
- El worker persiste el checkpoint `handlerCompleted` antes de append de auditoría. Si append falla conserva el evento `processing` hasta expirar el lease; la recuperación omite el handler y reintenta el append. Los adaptadores durables deben guardar checkpoint y lease juntos. Un fallo del proceso entre efecto externo y checkpoint aún exige handler idempotente por tenant/eventId.
- Validado con Node `24.19.0` y pnpm `11.25.0`: typechecks strict/noUnused de audit, outbox, queues y worker (incluye tests); Vitest del slice: 14 tests / 3 archivos PASS; ESLint del scope PASS; Prettier de los archivos TypeScript del scope PASS; `git diff --check` PASS.
- Calidad de paquete: `pnpm run lint`, `pnpm run typecheck`, `pnpm run build` y `pnpm run test:unit` PASS. `pnpm run format:check` falla en 41 archivos enumerados por el script, todos fuera del pathScope; no se reformatearon. El format check dedicado a los archivos del slice pasa.
- Integración MySQL no ejecutada: `OPSLOG_TEST_MYSQL_ADMIN_URL` no está configurada y el harness crea/elimina bases y usuarios; los adaptadores de este slice siguen siendo en memoria. No se validó persistencia real/MySQL.
