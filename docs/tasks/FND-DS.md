# FND-DS — Design system Material UI

```yaml
id: FND-DS
baseline: [SPEC-1.1, ORCH-1.1, inherited: SPEC-1.0/ORCH-1.0]
milestone: M0
kind: foundation
purpose: Entregar tokens, tema, componentes base y stories accesibles antes de pantallas funcionales.
requirements: [U-02, U-06, FR-023, FR-140, NFR-S2, NFR-M5, "SPECS §8"]
source_decisions: [U-02, U-06, "SPECS §8", "CLAUDE_ARTIFACT_REFERENCE", "ADR-0005 single active provider"]
depends_on: ["baseline-checked"]
consumes: ["SPEC-1.0", "ORCH-1.0", "artifact-ux-reference"]
produces: ["opslog-theme-v1", "ui-components-v1", "ui-state-catalog-v1"]
write_paths: [packages/ui/**, docs/design/**]
read_paths: [AGENTS.md, CLAUDE.md, SPECS.md, Orchestrator.md, docs/sources/CLAUDE_ARTIFACT_REFERENCE.md, docs/tasks/ORCH-BOOTSTRAP.md]
forbidden_paths: [SPECS.md, Orchestrator.md, Tasks.md, .env*, package.json, pnpm-lock.yaml, apps/**, packages/contracts/**, tools/orchestrator/**]
acceptance: ["Given tokens SPECS/artifact, When se renderiza el tema, Then colores, tipografías, escala y geometría están centralizados.", "Given teclado/lector/contraste, When se ejercitan los componentes, Then foco, labels, estados y contraste WCAG AA son verificables.", "Given loading/vacío/sin resultados/error/sin permiso/incompleto/vencido/cerrado/éxito/sesión expirada, When se revisa el catálogo, Then cada estado tiene componente y story.", "Given pantalla funcional futura, When consume el paquete, Then no necesita colores o reglas de autorización hardcodeados."]
unit_cases: ["tokens completos", "contraste", "focus visible", "disabled/loading", "status y severity separados", "responsive 360px"]
integration_cases: ["axe sobre stories", "tema Material UI", "visual snapshots representativos"]
e2e_cases: ["navegación por teclado en DataTable/Wizard/Timeline", "estados comprensibles sin solo color"]
commands: ["pnpm storybook", "pnpm test --filter ui", "pnpm axe --filter ui", "pnpm lint --filter ui"]
fixtures: ["stories sintéticas", "sin datos reales", "roles y permisos representados como lenguaje de usuario"]
non_goals: ["pantallas de producto", "API/ORM", "reglas de autorización en componentes", "copiar código del artifact"]
completion_evidence: ["commit/PR listo para revisión", "stories y axe", "tokens/contraste", "una auditoría independiente del proveedor activo por SHA"]
rollback: "Revertir cambios del paquete y conservar snapshots/evidencia; no tocar aplicaciones consumidoras."
max_repair_cycles: 3
```

## Fronteras

Material UI es la base; IBM Plex Sans/Mono y los valores de SPECS son tokens. Las etiquetas deben ser comprensibles, no exponer IDs técnicos de permisos. No se inicia ninguna pantalla funcional hasta G0.

Provider-lock efectivo: solo Codex está activo, con `gpt-6-luna` para autor y auditor. No se lanza Claude concurrentemente; un cambio de proveedor requiere drenaje y nuevo epoch.
