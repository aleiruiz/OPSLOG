# ORCH-HANDSHAKE-HARDEN — autorización explícita de sesiones hijas

```yaml
id: ORCH-HANDSHAKE-HARDEN
baseline: [SPEC-1.2, ORCH-1.2, inherited: SPEC-1.0/ORCH-1.0, SPEC-1.1/ORCH-1.1]
milestone: M0
kind: documentation
purpose: Cerrar los gaps de lectura obligatoria y autorización explícita antes del trabajo real de una sesión hija.
depends_on: [ORCH-RESTART]
source_decisions: ["SESSION_HANDSHAKE", "ORCH-1.2", "ADR-0005"]
write_paths: [AGENTS.md, CLAUDE.md, docs/operations/SESSION_HANDSHAKE.md, docs/operations/AUTONOMOUS_ORCHESTRATOR.md, docs/operations/ORCHESTRATOR_START.md, docs/tasks/ORCH-RESTART.md, docs/tasks/ORCH-HANDSHAKE-HARDEN.md]
forbidden_paths: [SPECS.md, Orchestrator.md, docs/baselines/**, manifests/**, package.json, pnpm-lock.yaml, Tasks.md, .orchestrator/**, .env*]
requirements:
  - SESSION_HANDSHAKE es lectura obligatoria para ambos proveedores y aparece en AGENTS y en la guía de arranque.
  - READY incluye handshakeId, parent/child thread IDs reales, taskId, leaseId, epoch, modelo, host, worktree, rama, baseSHA y pathScope.
  - El padre valida identidad, modelo, lease, epoch, baseSHA y paths y emite ACK para el mismo handshakeId.
  - Solo ACK explícito con startAuthorized: true habilita trabajo real; timeout, anchored, worktree o mensaje inicial no habilitan.
  - READY/ACK stale, incorrecto, incompleto o de otro padre bloquea; ACK válido repetido es idempotente.
  - Cambio de ownership, lease, epoch, alcance o reprovisionamiento exige nuevo handshake; commits normales posteriores al ACK no.
acceptance:
  - Given una sesión provisionada, When no existe ACK válido, Then permanece await-parent-ack y no escribe ni ejecuta trabajo.
  - Given READY completo y correlacionado, When el padre responde ACK con startAuthorized true, Then la sesión puede iniciar únicamente su pathScope.
  - Given identidad, modelo, lease, epoch, baseSHA o paths stale/incorrectos, When llega READY o ACK, Then se bloquea y no muta estado.
  - Given un ACK válido repetido, When se reconcilia, Then no crea otra sesión ni cambia el alcance.
checks: ["links relativos", "git diff --check", "hashes de baselines congeladas", "scope documental sin código/manifests/lockfiles"]
tests: []
evidence: ["READY/ACK correlacionados", "diff documental", "checks reproducibles", "PR listo para revisión"]
non_goals: ["runtime del orquestador", "auditoría adicional", "merge", "cambio de baselines", "AWS"]
completion_evidence: ["commit/PR ready", "una auditoría independiente por SHA coordinada por el padre"]
```

## Trazabilidad

`AGENTS.md` y `CLAUDE.md` enlazan la lectura obligatoria; las guías de arranque fijan la precedencia y el gate; `SESSION_HANDSHAKE.md` define el protocolo y los rechazos; este paquete identifica el alcance y la evidencia esperada. La auditoría independiente y la publicación del PR corresponden al orquestador padre.
