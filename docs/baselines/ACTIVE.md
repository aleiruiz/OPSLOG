# Baseline efectiva de OPSLOG

Vigente: **SPEC-1.3 / ORCH-1.3**, adoptada por instrucciones directas del usuario el 2026-10-04.

Leer originales SPECS.md/Orchestrator.md y sucesoras [1.1](1.1/Orchestrator.md), [SPEC 1.2](1.2/SPECS.md), [ORCH 1.2](1.2/Orchestrator.md), [SPEC 1.3](1.3/SPECS.md) y [ORCH 1.3](1.3/Orchestrator.md). Heredar todos los requisitos no sustituidos; manifests BASELINE-1.0/1.1/1.2.json y [BASELINE-1.3](BASELINE-1.3.json).

Un proveedor activo; Codex gpt-6-luna o Claude claude-sonnet-5. Exactamente una auditoría independiente por PR/SHA, sin auditorías locales adicionales ni review formal de GitHub. PR ready. Dispatcher autónomo, workers en sesiones separadas y pulse cada diez minutos. Al migrar, preservar la evidencia previa por SHA/modelo y aplicar el pin nuevo a asignaciones y revalidaciones. AWS diferido; gates acumulativos intactos, ninguno se declara aprobado aquí. Arranque vigente: docs/tasks/ORCH-RESTART.md y docs/operations/AUTONOMOUS_ORCHESTRATOR.md.
