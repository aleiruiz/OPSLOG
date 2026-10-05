# FND-CONTRACTS — Contratos base y trazabilidad

```yaml
id: FND-CONTRACTS
baseline: [SPEC-1.1, ORCH-1.1, inherited: SPEC-1.0/ORCH-1.0]
milestone: M0
kind: foundation
purpose: Materializar contratos tipados/runtime y trazabilidad individual del alcance, sin importar entidades ORM.
requirements: [FR-001, FR-002, FR-010, FR-011, FR-020, FR-023, FR-050, FR-070, FR-090, FR-110, FR-130, FR-150, FR-170, NFR-S2, NFR-S4]
source_decisions: [U-03, U-05, "SPECS §4", "SPECS §7", "SPECS §10.1", "ADR-0005 single active provider"]
depends_on: ["baseline-checked"]
consumes: ["SPEC-1.0", "ORCH-1.0", "BRD FR/BR/AC/NFR/US"]
produces: ["contracts-v1", "traceability-m0-v1", "error-event-file-contracts-v1"]
write_paths: [packages/contracts/**, docs/contracts/**, docs/traceability/**]
read_paths: [AGENTS.md, CLAUDE.md, SPECS.md, Orchestrator.md, docs/tasks/ORCH-BOOTSTRAP.md, docs/sources/BRD_SRD_OPSLOG_Bitacoras_Operativas_v0.2.md]
forbidden_paths: [SPECS.md, Orchestrator.md, Tasks.md, .env*, package.json, pnpm-lock.yaml, packages/ui/**, tools/orchestrator/**, infra/**]
acceptance: ["Given requisitos BRD y decisiones SPECS, When se consulta la matriz, Then cada ID individual queda como implementado, diferido o pendiente con contrato/prueba/evidencia.", "Given payload válido e inválido, When se valida el esquema, Then los errores son estructurados y no filtran PII/SQL/stack.", "Given evento/outbox de tenant A, When se valida, Then tenantId, versión, idempotencia y payload mínimo son obligatorios.", "Given recurso ajeno, When se serializa el error, Then se usa 404 uniforme."]
unit_cases: ["campos requeridos", "enum/fechas/moneda", "tenantId ausente", "payload desconocido", "correlationId", "fieldErrors/missingRequirements"]
integration_cases: ["compatibilidad de versiones de contrato", "serialización JSON/OpenAPI", "eventos idempotentes A/B", "archivos y límites de tamaño"]
e2e_cases: ["contrato puede consumirse sin ORM", "trazabilidad enlaza FR→contrato→prueba→evidencia"]
commands: ["pnpm test --filter contracts", "pnpm lint --filter contracts", "pnpm typecheck --filter contracts", "pnpm contracts:check"]
fixtures: ["payloads sintéticos válidos/inválidos", "tenant-A/tenant-B", "errores sin datos reales"]
non_goals: ["implementar handlers/ORM", "pantallas", "resolver decisiones D3/D6/D7/D16", "conectar AWS"]
completion_evidence: ["commit/PR listo para revisión", "schemas y tests", "matriz individual completa", "una auditoría independiente del proveedor activo por SHA"]
rollback: "Revertir el commit del contrato y marcar consumidores incompatibles; no cambiar baselines ni copiar interfaces de otros paquetes."
max_repair_cycles: 3
```

## Decisiones y límites

Los conflictos del BRD (por ejemplo referencias documentales a FR-120) se registran por texto y se resuelven con SPECS, sin editar la fuente. El paquete debe separar `CONFIRMED`, `PROPOSED`, `ASSUMPTION` y `DECISION REQUIRED`; no convertir una propuesta en regla sin decisión compatible.

Provider-lock efectivo: Codex es el único proveedor activo de esta ronda, con `gpt-6-luna` explícito para autor y auditor. No se espera adaptador Anthropic ni se bloquea el paquete por su ausencia.
