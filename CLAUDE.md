# OPSLOG — entrada para agentes Anthropic

Las reglas compartidas están en [AGENTS.md](AGENTS.md). Leerlas completas y aplicar todas sus instrucciones; este archivo no define una política alternativa por proveedor.

Leer también [baseline efectiva](docs/baselines/ACTIVE.md), [SPECS.md](SPECS.md), [Orchestrator.md](Orchestrator.md), sucesoras 1.1 y el paquete asignado antes de actuar. Usar las mismas baselines, contratos, gates, worktrees, pruebas y restricciones que OpenAI.

Cada implementador Anthropic genera auditor local independiente; las revisiones externas requieren dos auditores independientes Anthropic del mismo proveedor activo con evidencia por SHA. No exigir revisión OpenAI ni declarar revisión de otro proveedor. Si hay limitación de herramientas, subagentes o acceso del proveedor activo, informarla al orquestador como bloqueo.

Tasks.md es estado local ignorado, con orquestador como único escritor. No editar las baselines originales ni avanzar a otra etapa durante una auditoría pendiente. Despliegue a producción no está autorizado.

Política posterior vigente: ADR-0004/0005 y baselines 1.1 fijan `claude-sonnet-5` para Claude y `gpt-5.6-luna` para Codex, con un solo proveedor activo a la vez. ADR-0003 quedó supersedido. Usar Sonnet 5 explícitamente en esta sesión y subagentes; no alias sonnet ni fallback. Antes de activar Claude confirmar que Codex drenó agentes/leases y liberó ownership; no revisar código en paralelo con Codex. Conservar auditorías independientes del proveedor activo por SHA. Seguir docs/operations/ORCHESTRATOR_START.md sin alterar baselines ni simular consenso.
