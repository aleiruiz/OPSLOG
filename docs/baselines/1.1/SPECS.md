# OPSLOG — SPEC-1.1: proveedor exclusivo y auditoría interna independiente

Fecha: 2026-10-03, America/Mexico_City.
Estado: sucesora acotada adoptada por aclaración directa del usuario.
Hereda [SPEC-1.0](../../../SPECS.md) sin editar el original. Aplicar SPEC-1.0 más las sustituciones explícitas de este documento; no es un resumen ni elimina requisitos no mencionados.

## Cambio autorizado

El usuario aclara que Claude y Codex pueden trabajar en el repositorio en periodos distintos, pero únicamente un proveedor lo hará a la vez. No exige revisión de Claude a Codex ni viceversa.

Se sustituye la interpretación de U-07 y las referencias a consenso obligatorio OpenAI+Anthropic de SPEC-1.0 §9.2/§11:

- Un proveedor activo por repositorio; se permiten varios agentes, worktrees y subagentes del proveedor activo.
- Codex/OpenAI usa exclusivamente `gpt-5.6-luna`. Claude/Anthropic usa exclusivamente `claude-sonnet-5`.
- Cada implementador genera subauditor local independiente; los PRs conservan dos auditores externos al equipo autor, en sesiones distintas, **del mismo proveedor activo**, sobre el mismo SHA. Externo significa independiente del autor/equipo de implementación, no otro proveedor.
- Los hitos conservan dos auditores independientes del proveedor activo, contexto limpio y evidencia acumulativa. No exigir participación del proveedor inactivo para revisar, fusionar o pasar un gate.
- El orquestador registra proveedor/modelo real y no considera pendiente una auditoría del otro proveedor solo porque no esté disponible.

## Controles conservados

CI, cobertura, aislamiento multitenant, aceptación por requisitos, consenso por SHA, independencia del autor, límites de escritura, worktrees, gates G0–G5 y solicitud de intervención humana en auditoría siguen obligatorios. M0, dependencias funcionales y AWS diferido no cambian.

No iniciar desarrollo posterior mientras el gate previo no pase. La aclaración elimina una dependencia de proveedor; no aprueba automáticamente ningún código ni informe.

## Adopción y trazabilidad

Decisión registrada en [ADR-0005](../../adr/0005-single-active-provider.md). Protocolo efectivo de transición y auditoría en [ORCH-1.1](Orchestrator.md). La política de modelos de ADR-0004 sigue vigente; su requisito de revisión cruzada queda supersedido por esta versión.
