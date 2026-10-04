# ADR-0005 — Un proveedor a la vez y sin auditoría cruzada

Estado: vigente por aclaración directa del usuario.
Fecha: 2026-10-03, America/Mexico_City.

## Decisión

Claude y Codex pueden trabajar sobre OPSLOG, pero no al mismo tiempo. Todos los agentes activos pertenecen al proveedor que tenga el repositorio; pueden trabajar en paralelo mediante worktrees. Codex usa Luna 5.6 y Claude usa Sonnet 5, incluidos auditores/subagentes.

No se espera revisión de Claude a Codex ni viceversa. Las revisiones independientes se hacen entre sesiones del mismo proveedor activo, sin autores aprobándose ni suprimir checks/gates.

## Efecto sobre la baseline

La revisión cruzada obligatoria de SPEC-1.0/ORCH-1.0 y ADR-0004 cambia de manera explícita. Se registran sucesoras acotadas [SPEC-1.1](../baselines/1.1/SPECS.md) y [ORCH-1.1](../baselines/1.1/Orchestrator.md); los originales permanecen intactos. Heredar sus restantes requisitos, alcance y tareas.

No exigir adaptador del proveedor inactivo para fusionar o cerrar G0; sí exigir auditores del activo, CI real y aceptación acumulativa. AWS sigue diferido.
