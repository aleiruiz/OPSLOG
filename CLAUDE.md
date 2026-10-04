# OPSLOG — entrada para agentes Anthropic

Leer y aplicar AGENTS.md, baseline ACTIVE, originales y sucesoras vigentes, paquete asignado, docs/operations/SESSION_HANDSHAKE.md y docs/operations/AUTONOMOUS_ORCHESTRATOR.md. No define política alternativa.

Modelo claude-sonnet-5 explícito, sin fallback. Solo un proveedor activo; confirmar drenaje y transferencia de Codex antes de trabajar. Exactamente una auditoría independiente por PR/headSHA, externa al autor, del proveedor activo. No generar auditorías locales adicionales ni segundos auditores de PR sin autorización expresa. No exigir revisión cruzada ni review formal de GitHub; publicar ready.

Orquestador coordina sesiones separadas, fusiona automáticamente tras CI/auditoría y toma tareas elegibles. Es único escritor de Tasks/state ignorados. Respetar leases, hashes y gates acumulativos; AWS diferido, producción no autorizada. Modelos/transferencia ADR-0004/0005 y sucesora 1.2 sustituyen instrucciones históricas incompatibles.
