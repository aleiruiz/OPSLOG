# FND-AWS — Plan documental y compatibilidad diferida

```yaml
id: FND-AWS
baseline: [SPEC-1.0, ORCH-1.0]
milestone: M0
kind: foundation
purpose: Consolidar plan documental de AWS/DB/secretos/recuperación sin conexión, inventario remoto ni provisionamiento.
requirements: [U-04, FR-002, NFR-S2, NFR-S4, NFR-B1, NFR-B3, NFR-B5, "SPECS §11"]
source_decisions: ["ADR-0001", "ADR-0002", "infra/plan/AWS.md"]
depends_on: ["baseline-checked"]
consumes: ["SPEC-1.0", "ORCH-1.0", "MySQL 8.0.45 como dato del usuario"]
produces: ["aws-deferred-plan-v1", "db-compatibility-checklist-v1", "staging-readiness-pending-v1"]
write_paths: [infra/plan/fnd-aws/**, docs/adr/aws/**, docs/runbooks/inventory/**]
read_paths: [AGENTS.md, CLAUDE.md, SPECS.md, Orchestrator.md, docs/adr/0001-environment-assumptions.md, docs/adr/0002-defer-aws-configuration.md, infra/plan/AWS.md]
forbidden_paths: [SPECS.md, Orchestrator.md, Tasks.md, .env*, apps/**, packages/**, tools/orchestrator/**]
acceptance: ["Given acceso AWS no autorizado/diferido, When se ejecuta el paquete, Then no intenta conexión, inventario, credenciales, provisionamiento ni despliegue.", "Given MySQL 8.0.45, When se documenta compatibilidad, Then se enumeran pruebas futuras y límites sin afirmar ejecución.", "Given staging/producción existentes, When se describe el inventario, Then ownership, red, TLS, backups, secretos y aislamiento quedan pendientes explícitos.", "Given AWS plan, When se revisa, Then ningún hallazgo documental se presenta como gate pasado."]
unit_cases: [".env no leído", "endpoint/región no confirmados", "AWS diferido", "secreto ausente", "runtime sin master DB"]
integration_cases: ["checklist de dos bases/usuarios por tenant", "MySQL efímero local separado de AWS", "RPO/RTO como evidencia pendiente"]
e2e_cases: ["runbook reproduce preparación sin credenciales", "plan distingue evidencia local de cloud real"]
commands: ["Get-Content infra/plan/AWS.md", "git diff --check -- infra/plan/fnd-aws docs/adr/aws docs/runbooks/inventory"]
fixtures: ["valores placeholder no secretos", "datos sintéticos", "matriz de controles pendiente"]
non_goals: ["az/aws/terraform/cdk apply", "RDS/AppSync/S3 inventory", "leer .env", "probar credenciales", "deploy"]
completion_evidence: ["commit/PR", "checklist documental", "bloqueos reales", "auditoría local", "auditorías externas por SHA"]
rollback: "Revertir documentación nueva; conservar AWS.md vigente e historial de decisiones. No destruir recursos ni borrar evidencia."
max_repair_cycles: 3
```

## Bloqueo conocido

La falta de acceso remoto no impide preparar documentación, pero impide afirmar compatibilidad, capacidad, IAM, TLS, backups o recuperación sobre AWS. El paquete debe cerrar como documental con esas verificaciones `pending`.
