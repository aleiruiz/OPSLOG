# MODEL-LUNA6 — Pin Codex gpt-6-luna

```yaml
id: MODEL-LUNA6
baseline: [SPEC-1.3, ORCH-1.3, inherited: SPEC/ORCH-1.0–1.2]
kind: documentation-and-runtime-remediation
purpose: Adoptar el pin gpt-6-luna en instrucciones vigentes y runtime, manteniendo proveedor único, gates, handshake y auditoría única.
owner: Codex, model gpt-6-luna
baseSHA: 61c35c20f1a68e4eb58802fa42759ca4335051d7
leaseId: model-luna6-doc-runtime-01
epoch: model-luna6-parent-20261004
write_paths:
  [
    AGENTS.md,
    CLAUDE.md,
    docs/baselines/ACTIVE.md,
    docs/baselines/1.3/**,
    docs/baselines/BASELINE-1.3.json,
    docs/adr/0006-luna6-model-policy.md,
    docs/operations/**,
    docs/tasks/**,
    tools/orchestrator/domain.ts,
    tests/orchestrator/runtime.test.ts,
  ]
forbidden_paths:
  [
    SPECS.md,
    Orchestrator.md,
    docs/baselines/1.1/**,
    docs/baselines/1.2/**,
    docs/baselines/BASELINE-1.0.json,
    docs/baselines/BASELINE-1.1.json,
    docs/baselines/BASELINE-1.2.json,
    docs/audits/**,
    .env*,
    AWS,
    Tasks.md,
    .orchestrator/**,
    package.json,
    pnpm-lock.yaml,
  ]
```

## Contrato y límites

- SPEC/ORCH-1.3 hereda 1.2 salvo el pin de Codex, que cambia a `gpt-6-luna`; Claude permanece en `claude-sonnet-5`.
- Mantener un solo proveedor activo por repositorio, asignación explícita/observada, independencia autor-auditor, exactamente una auditoría independiente por PR/headSHA, READY/ACK con `startAuthorized: true`, controles de CI y gates acumulativos.
- ADR-0006 adopta el cambio el 2026-10-04 y supersede solo la selección histórica de modelo Codex. No editar baselines congeladas, ADR históricos ni auditorías previas.
- Evidencia, revisiones y snapshots existentes conservan SHA y modelo realmente observado. No repetir trabajo histórico debido al nuevo pin. Las asignaciones y revalidaciones nuevas usan Luna 6, después de drenar y transferir ownership/leases según el handshake.
- El coordinador opera en una sesión independiente y reporta directamente al humano. Cada trabajador completa READY/ACK con el coordinador, sin intermediación del chat creador.

## Implementación

- Actualizar pin/modelo en guías vigentes y paquetes activos; mantener ejemplos, límites de proveedor, auditoría única y gates.
- Añadir sucesoras SPECS/Orchestrator 1.3 y manifest canonical LF con SHA-256 de sus archivos.
- Cambiar `Model` y `MODEL_BY_PROVIDER.codex`; agregar casos para aceptar el pin nuevo y rechazar el antiguo, un modelo observado distinto y una auditoría del proveedor inactivo.

## Aceptación y evidencia

- Given provider `codex`, When se adquiere un lease, Then usa `gpt-6-luna`.
- Given candidate auditado con `gpt-6-luna` en SHA coincidente, When se valida, Then se acepta solo con CI y exactamente una auditoría independiente del proveedor activo.
- Given `gpt-5.6-luna`, un modelo observado distinto o proveedor auditor inactivo, When se valida o configura, Then se rechaza.
- Confirmar que los hashes canonical LF de baselines 1.0, 1.1 y 1.2 siguen intactos; comprobar hashes del manifest 1.3 y enlaces relativos.
- Comandos reproducibles con Node 24 del runtime del workspace: `node_modules/.bin/vitest.cmd run tests/orchestrator/runtime.test.ts`, `node_modules/.bin/eslint.cmd tools/orchestrator/domain.ts tests/orchestrator/runtime.test.ts --max-warnings 0`, `node_modules/.bin/prettier.cmd --check tools/orchestrator/domain.ts tests/orchestrator/runtime.test.ts docs/adr/0006-luna6-model-policy.md docs/tasks/MODEL-LUNA6.md` y `node_modules/.bin/tsc.cmd -b tests/orchestrator/tsconfig.json --pretty false`.
- Registrar resultado real de cada comprobación, `git diff --check`, SHA de publicación y PR ready. El padre coordina exactamente una auditoría independiente del SHA final; este paquete no declara auditoría ni gate aprobado.
