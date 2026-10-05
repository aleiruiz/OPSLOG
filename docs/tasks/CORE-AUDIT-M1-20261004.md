# CORE-AUDIT-M1-20261004 — auditoría/outbox y worker desde cero

```yaml
id: CORE-AUDIT-M1-20261004
baseline: [SPEC-1.2, ORCH-1.2, inherited: SPEC-1.0/ORCH-1.0, SPEC-1.1/ORCH-1.1]
milestone: M1
kind: implementation
baseSHA: 61c35c20f1a68e4eb58802fa42759ca4335051d7
depends_on: [G0-human-reaffirmed]
write_paths: [apps/worker/base/**, packages/platform/audit/**, packages/platform/outbox/**, infra/queues/**, docs/tasks/CORE-AUDIT-M1-20261004.md]
forbidden_paths: [SPECS.md, Orchestrator.md, docs/baselines/**, Tasks.md, .orchestrator/**, .env*, pnpm-lock.yaml, packages/contracts/**, packages/persistence/**, apps/api/**]
```

Implementar completamente desde cero el slice de auditoría/outbox/worker, sin copiar PR11, sus reparaciones ni sus ramas. Cubrir eventos auditados sin PII, outbox transaccional, claim con lease/fencing, retry/backoff, DLQ, métricas, reconciliación y contexto tenant.

Aceptación mínima: rollback no publica; dos workers concurrentes no procesan el mismo evento; lease stale no puede mutar; retry es idempotente/deduplicable; tenant inexistente/suspendido se rechaza sin handler; redacción elimina secretos/PII; pruebas de error, concurrencia y aislamiento A/B. No modificar el gate Playwright ni manifests/lockfile.

Leer instrucciones, baselines, ADR-0001/0002/0004/0005, SESSION_HANDSHAKE, AUTONOMOUS_ORCHESTRATOR y SPECS §4–§7. Usar solo datos sintéticos. El autor no audita ni fusiona su candidato; cualquier PR nuevo requiere exactamente una auditoría independiente sobre su SHA.
