# FND-ORCH — Runtime de coordinación

```yaml
id: FND-ORCH
baseline: [SPEC-1.3, ORCH-1.3, inherited: SPEC-1.0/ORCH-1.0 and SPEC/ORCH-1.1–1.2]
milestone: M0
kind: foundation
purpose: Implementar runtime/CLI TypeScript para paquetes, leases, fencing, proveedores y gates con fakes sintéticos.
requirements: [U-07, U-08, U-09, U-10, 'ORCH §2', 'ORCH §4', 'ORCH §6', 'ORCH §7']
source_decisions:
  ['ADR-0005 single active provider', 'ADR-0006 Codex model pin', 'SPECS §10', 'Orchestrator §2.2']
depends_on: [FND-REPO, FND-CONTRACTS]
consumes: ['workspace-v1', 'contracts-v1']
produces: ['orchestrator-runtime-v1', 'lease-state-v1', 'gate-evidence-validator-v1']
write_paths: [tools/orchestrator/**, tests/orchestrator/**, docs/operations/runtime/**]
read_paths:
  [
    AGENTS.md,
    CLAUDE.md,
    SPECS.md,
    Orchestrator.md,
    docs/adr/0004-provider-model-policy.md,
    docs/adr/0007-claude-model-split.md,
    docs/operations/ORCHESTRATOR_START.md,
    docs/tasks/ORCH-BOOTSTRAP.md,
  ]
forbidden_paths:
  [
    SPECS.md,
    Orchestrator.md,
    Tasks.md,
    .env*,
    package.json,
    pnpm-lock.yaml,
    packages/contracts/**,
    packages/ui/**,
    infra/**,
  ]
acceptance:
  [
    'Given tres tareas elegibles, When se simula despacho, Then cada una tiene lease/fencing/baseSHA/worktree/model explícitos y no hay solapamiento.',
    'Given lease stale o fencing viejo, When llega un resultado, Then se marca stale y no fusiona.',
    'Given gate pendiente/fallido o proveedor no activo, When se pide una tarea de etapa posterior, Then queda bloqueada.',
    'Given reinicio, When se reconstruye desde estado sintético/GitHub fake, Then no se inventan PRs, reviews ni consenso.',
    'Given Codex es proveedor activo, When se valida un candidato, Then exige exactamente una auditoría Codex independiente externa al autor sobre el mismo SHA y no exige review formal.',
    'Given handoff a Claude, When se solicita cambio, Then drena agentes/leases, cambia epoch y fija claude-sonnet-5-5 (autor) y claude-opus-5-5 (auditoría).',
  ]
unit_cases:
  [
    'doble lease',
    'heartbeat/timeout',
    'fencing',
    'idempotencia eventId',
    'SHA cambiado',
    'tres ciclos de reparación',
    'Tasks atomic projection',
  ]
integration_cases:
  [
    'git/worktree fake',
    'GitHub fake',
    'OpenAI Luna explicit',
    'Anthropic Sonnet 5.5/Opus 5.5 unavailable',
    'state store SQLite WAL',
  ]
e2e_cases: ['bootstrap M0', 'recovery', 'gate blocks M1', 'candidate SHA invalidation']
commands:
  [
    'pnpm test --filter orchestrator',
    'pnpm lint --filter orchestrator',
    'pnpm typecheck --filter orchestrator',
    'pnpm orchestrator simulate',
  ]
fixtures:
  [
    'IDs opacos sintéticos',
    'sin API keys',
    'sin datos reales',
    'providers fake con modelo solicitado registrado',
  ]
non_goals:
  ['merge sin auditorías', 'AWS', 'M1', 'crear chats de usuario', 'usar fallback de modelo']
completion_evidence:
  [
    'commit/PR listo para revisión',
    'tests de recuperación/gates',
    'modelo solicitado y observado',
    'una auditoría independiente del proveedor activo por SHA',
    'handoff/provider epoch',
  ]
rollback: 'Deshabilitar dispatcher nuevo y conservar estado/leases/evidencia; no borrar worktrees o tareas activas.'
max_repair_cycles: 3
```

## Política de proveedores

Provider-lock efectivo: solo Codex está activo en esta ronda; autor y auditor reciben `gpt-6-luna` explícito. Claude queda inactivo, no es un bloqueo. Un handoff futuro debe drenar los agentes/leases Codex, incrementar epoch y fijar `claude-sonnet-5-5` para código y `claude-opus-5-5` para auditoría (ADR-0007); si la herramienta no permite fijar/observar el modelo del proveedor activo, el estado es `blocked`. No se implementan adaptadores para secretos reales.
