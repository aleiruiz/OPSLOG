# FND-REPO — Workspace, calidad y CI

```yaml
id: FND-REPO
baseline: [SPEC-1.1, ORCH-1.1, inherited: SPEC-1.0/ORCH-1.0]
milestone: M0
kind: foundation
purpose: Crear el workspace pnpm reproducible, scripts de calidad/build/test y CI local sintética sin AWS.
requirements: [U-02, U-03, U-05, U-06, FR-002, FR-170, NFR-P1, NFR-S2, NFR-M5]
source_decisions: [U-03, U-05, U-06, "SPECS §3", "SPECS §9", "ADR-0005 single active provider"]
depends_on: ["baseline-checked"]
consumes: ["SPEC-1.0", "ORCH-1.0"]
produces: ["workspace-v1", "quality-ci-v1", "synthetic-mysql-harness-v1"]
write_paths: [.gitignore, package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig*.json, eslint*, prettier*, .github/workflows/quality*, tests/harness/**, apps/**/package.json]
read_paths: [AGENTS.md, CLAUDE.md, SPECS.md, Orchestrator.md, docs/adr/0001-environment-assumptions.md, docs/adr/0002-defer-aws-configuration.md]
forbidden_paths: [SPECS.md, Orchestrator.md, Tasks.md, .env*, packages/contracts/**, packages/ui/**, tools/orchestrator/**, infra/**]
acceptance: ["Given un clone limpio sin secretos, When se instalan dependencias con frozen-lockfile, Then la instalación es reproducible.", "Given un test/lint/cobertura inválido, When corre el pipeline, Then falla y reporta la causa.", "Given MySQL 8.0.45 efímero y fixtures A/B sintéticos, When corre integración, Then valida migración desde cero y aislamiento básico sin AWS."]
unit_cases: ["script inexistente", "cobertura bajo umbral", "TypeScript strict", "secreto en árbol de archivos"]
integration_cases: ["MySQL 8.0.45 efímero", "dos tenants y IDs locales iguales", "rollback A no afecta B", "concurrencia mínima A/B"]
e2e_cases: ["clon limpio ejecuta quality/build/test", "CI no conecta AWS ni lee .env"]
commands: ["pnpm install --frozen-lockfile", "pnpm lint", "pnpm format:check", "pnpm typecheck", "pnpm test:unit", "pnpm test:integration", "pnpm build"]
fixtures: ["datos sintéticos tenant-A/tenant-B", "reloj determinista", "credenciales efímeras de test explícitas"]
non_goals: ["funcionalidad M1+", "conexión AWS", "leer .env", "decidir ORM o contratos compartidos sin ADR/propietario"]
completion_evidence: ["commit/PR listo para revisión", "baseSHA/headSHA", "lista de comandos y resultados", "CI real", "una auditoría independiente del proveedor activo por SHA"]
rollback: "Revertir commits del paquete; conservar lock/worktree y evidencia. No borrar fixtures ni resetear bases externas."
max_repair_cycles: 3
```

## Notas de coordinación

FND-REPO es propietario exclusivo de la raíz de workspace, lockfile, configuración compartida y workflows. Debe solicitar `ContractChangeRequested` para cualquier cambio fuera de `write_paths`. La auditoría local se crea antes del PR y no puede editar el árbol del autor. El CI de AWS/staging queda pendiente y no puede representarse como verde.

Provider-lock efectivo: solo Codex está activo en este repositorio durante esta ronda y los nuevos agentes/auditores usan `gpt-6-luna`; no se requiere revisión Anthropic para este intento. Cambiar a Claude exige drenar leases/agentes y registrar un nuevo epoch.
