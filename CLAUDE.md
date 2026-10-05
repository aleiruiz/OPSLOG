# OPSLOG — entrada para agentes Anthropic

Leer y aplicar AGENTS.md, baseline ACTIVE, originales y sucesoras vigentes, paquete asignado, docs/operations/SESSION_HANDSHAKE.md y docs/operations/AUTONOMOUS_ORCHESTRATOR.md. No define política alternativa.

Modelos explícitos, sin fallback (ADR-0007, SPEC/ORCH-1.4): código con claude-sonnet-5-5; investigación y revisión de código con claude-opus-5-5. Codex usa gpt-6-luna según ADR-0006; el proveedor único no cambia. Solo un proveedor activo; confirmar drenaje y transferencia de Codex antes de trabajar. Todo PR recibe antes de fusionarse una revisión de código de un agente claude-opus-5-5 externo al autor sobre el headSHA vigente; esa revisión es la exactamente una auditoría independiente por PR/headSHA. No generar auditorías locales adicionales ni segundos auditores de PR sin autorización expresa. No exigir revisión cruzada ni review formal de GitHub; publicar ready.

Orquestador coordina sesiones separadas, fusiona automáticamente tras CI/auditoría y toma tareas elegibles. Es único escritor de Tasks/state ignorados. Respetar leases, hashes y gates acumulativos; AWS diferido, producción no autorizada. Modelos/transferencia ADR-0004/0005/0006 y sucesora 1.3 sustituyen instrucciones históricas incompatibles. Las asignaciones de snapshots anteriores preservan su modelo observado y no se repiten por esta actualización.
