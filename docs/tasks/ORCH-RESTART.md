# ORCH-RESTART — reemplazo autónomo

Autorización: petición directa del usuario el 2026-10-04. Rol: coordinador Codex gpt-5.6-luna, sesiones de trabajo separadas con el mismo modelo. No requiere aprobación humana para tomar tareas, reparar entorno del proyecto o fusionar PRs que satisfacen CI y auditoría única.

Leer AGENTS/CLAUDE, ACTIVE y originales/sucesoras 1.0–1.2, ADR-0001/0002/0004/0005, fuentes, paquetes existentes y docs/operations/AUTONOMOUS_ORCHESTRATOR.md. Verificar todos los manifests. Nueva política documental preparada en C:/Repos/OPSLOG/.worktrees/orch-autonomy, rama codex/orch-autonomy: heredada de 10b9c31, solo documentación. Necesita publicarse/integrarse con una auditoría independiente, sin editar originales congelados. Leer estos documentos desde ese worktree hasta su integración; transmitir ubicación y hashes en cada paquete.

Primera acción: leer C:/Repos/OPSLOG/.orchestrator/handoff-autonomous.md, verificar drenaje del anterior (01a104e1-b2eb-71b3-a70c-43ad6ae41112) y adquirir ownership nuevo antes de mutar Tasks/dispatch. Conservar todos los worktrees/PRs. No asumir que Tasks esté actualizado. El anterior informó PR6 fusionado en 98551f6e; comprobar GitHub. PRs #1–#4 pueden estar desactualizados o fusionados: consultar estado real, no duplicarlos. Root main local estaba en 10b9c31, no actualizar con reset destructivo.

Despachar primera sesión integradora documental que tome ownership de codex/orch-autonomy y sus paths docs/baselines/1.2, BASELINE-1.2.json, ACTIVE, AGENTS, CLAUDE, docs/tasks/ORCH-RESTART.md, docs/operations/AUTONOMOUS_ORCHESTRATOR.md. Publicar PR ready, exactamente una sesión auditora del SHA, luego fusionar automáticamente si checks/evidencia válidos. Actualizar validadores de manifests/políticas si hace falta en sesión implementadora separada con paths asignados. No declarar auditoría del padre/preparador como revisión independiente.

En paralelo reconciliar M0/G0 y materializar paquetes vigentes para integración, reparación local o fundamentos pendientes. Si G0 ya empezó y falló, solo remediaciones M0 y revalidación; no M1. Si G0 pasó realmente, despachar siguiente etapa sin pedir al humano que seleccione tasks. AWS sigue diferido, tampoco conectarse para probar credenciales.

Aceptación: ownership único, continuidad verificada, heartbeat de diez minutos unido a nueva sesión, sesiones Luna separadas verificables por id, CI/audit por SHA, merge automático verificable y próximo trabajo despachado cuando sea elegible. Nunca fabricar estos resultados.
