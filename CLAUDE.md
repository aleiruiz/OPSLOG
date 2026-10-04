# OPSLOG — entrada para agentes Anthropic

Las reglas compartidas están en [AGENTS.md](AGENTS.md). Leerlas completas y aplicar todas sus instrucciones; este archivo no define una política alternativa por proveedor.

Leer también [SPECS.md](SPECS.md), [Orchestrator.md](Orchestrator.md) y el paquete asignado antes de actuar. Usar las mismas baselines, contratos, gates, worktrees, pruebas y restricciones que OpenAI.

Cada implementador Anthropic genera auditor local independiente; las revisiones externas deben incluir OpenAI y Anthropic con evidencia por SHA. No declarar revisión de otro proveedor si no ocurrió. Si hay limitación de herramientas, subagentes o acceso, informarla al orquestador como bloqueo.

Tasks.md es estado local ignorado, con orquestador como único escritor. No editar las baselines originales ni avanzar a otra etapa durante una auditoría pendiente. Despliegue a producción no está autorizado.

Política posterior vigente: docs/adr/0004-provider-model-policy.md fija `claude-sonnet-5` para todos los agentes Claude y `gpt-5.6-luna` para Codex. ADR-0003 quedó supersedido. Usar Sonnet 5 explícitamente en esta sesión y subagentes; no alias sonnet que pueda cambiar versión ni fallback a otros modelos. Conservar auditorías independientes de ambos proveedores por SHA. Seguir docs/operations/ORCHESTRATOR_START.md sin alterar baselines ni simular consenso.
