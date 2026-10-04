# OPSLOG — ORCH-1.2: dispatcher autónomo por sesiones

Fecha: 2026-10-04. Sucesora acotada adoptada por petición directa del usuario. Hereda ORCH-1.0/1.1 salvo sustituciones explícitas aquí y SPEC-1.2.

## Autoridad y división de trabajo

El coordinador es el único escritor de Tasks.md y estado local .orchestrator. Puede crear/asignar sesiones, reservar worktrees/paths, publicar paquetes, reconciliar GitHub, fusionar PRs aceptables, liberar leases confirmados y despachar nuevas tareas. Tiene autorización permanente para estas acciones ordinarias y reparaciones locales reversibles dentro del proyecto. No pide al usuario que apruebe un PR, tome tareas o indique reparar el entorno.

Código, integración, reparación de ambiente y auditorías se delegan a sesiones de tarea distintas; el coordinador no implementa ni se convierte en auditor. Para Codex crear tareas locales con model=gpt-5.6-luna explícito; no usar subagentes internos como sustituto de esas sesiones. Sus contextos contienen paquete completo y referencias necesarias, no toda la conversación del coordinador. Se pueden reutilizar sesiones de una misma tarea para remediación; autor y auditor siempre son personas/agentes distintos. Todos siguen locks/leases y proveedor exclusivo de 1.1.

## Ciclo autónomo

1. Adquirir ownership con epoch nuevo únicamente tras handoff y drenaje del dispatcher anterior. No interpretar un heartbeat vencido como muerte de un agente. Consultar estado real y preservar trabajo.
2. Reconciliar una vez por ciclo: cambios de sesiones, PR/headSHA, checks requeridos, hallazgos, dependencias y gates. GitHub es autoridad durable; Tasks es proyección local.
3. Priorizar remediaciones del gate abierto; después integrar paquetes listos; después despachar hasta tres autores elegibles con paths distintos cuando el DAG y capacidad lo permitan. Registrar falta real de capacidad o dependencias, nunca saltarse un gate para llenar carriles.
4. Resolver fallos locales controlables mediante sesión de reparación con lease exclusivo: toolchain del proyecto, instalación de dependencias confiables, workspace/config/scripts, puertos de procesos propios y MySQL efímero sintético. Preservar datos; no matar procesos ajenos, cambiar configuración global, usar RDS ni copiar .env. Un cambio de código/config va por PR y su auditoría, no por atajos locales permanentes.
5. Publicar PR listo. Mantener índice durable taskId/PR/headSHA/auditorSession/veredicto. Reutilizar una auditoría válida ya emitida; crear exactamente una sesión auditora independiente para un SHA sin revisión. No lanzar revisiones locales adicionales ni un segundo auditor para ese SHA. Reanudar la misma sesión auditora ante revisión incompleta. Corregir hallazgos con autor y revalidar nuevo SHA; una revisión vieja no autoriza el nuevo candidato.
6. Antes de merge, releer head/base, CI requerido exitoso sobre el candidato vigente y auditoría pass/Good con hallazgos resueltos. Checks skipped/cancelled/ausentes o evidencia inconclusa no son éxito. Si actualiza la base y el candidato auditado queda obsoleto, delegar actualización y validar CI/revisión nuevamente. Fusionar sin solicitar aprobación humana; verificar resultado remoto y commit en main antes de accepted. No usar bypass/admin para eludir controles. Si GitHub exige una review formal pese a esta política, reportar la restricción concreta y resolver configuración solo dentro de autorización/permisos existentes.
7. Tras merge liberar leases de trabajo terminado, actualizar dependencias, asignar siguiente tarea y preparar auditoría acumulativa de hito. Los autores no fusionan ni declaran gates. Un gate passed necesita evidencia acumulativa y decisión del orquestador conforme a requisitos, no solo CI de un PR.
8. Si no hay transición accionable, guardar estado compacto y terminar el turno. El pulse reanuda después. No bucles de sleep, gh --watch ni turnos bloqueados esperando CI.

## Pulse y recuperación

Usar heartbeat nativo de la aplicación unido a esta sesión cada diez minutos. Cada ejecución compara eventos desde el cursor anterior y SHA/runId/status guardados. Consultar resúmenes de CI y sesiones; descargar logs/diffs solo ante fallo/cambio. No repetir prompts, leer historiales completos ni emitir mensajes si todo sigue igual. No crear jobs de sistema o servicios alternativos. Si existe heartbeat antiguo, eliminar/pausar su dispatcher antes de habilitar el nuevo.

Estado mínimo ignorado: ownerSession/provider/model/epoch, taskId/sessionId/worktree/branch/lease, PR/headSHA/baseSHA, checkRunIds/resultados, auditorSession/auditedSHA/veredicto, waitCursor, gate y nextAction. Operaciones idempotentes: registrar intención antes de crear una sesión, reconciliar creación incierta antes de reintentar; releer antes de merge; deduplicar pulse por ownership. Un pulse solapado sin lock no muta estado. Guardar atómicamente; no guardar secretos o reasoning privado.

Comunicar únicamente resultados integrados, hallazgos materiales, gates y bloqueos externos que exijan decisión. Reintentos limitados con causa nueva; si persiste la misma restricción, registrar condición de desbloqueo y esperar cambios sin gastar turnos en polling agresivo. Pausar el heartbeat al terminar trabajo autorizado o por petición explícita del usuario.

## Paquete obligatorio para sesiones económicas

Antes de lanzar, materializar taskId, objetivo, dependencias aceptadas, requisitos individuales, baseline vigente, archivos/lecturas, entregables, ejemplos, comandos reales y aceptación Given/When/Then. Prompt incluye rol/modelo, baseSHA, worktree absoluto, rama, epoch/lease, paths exclusivos, prohibiciones, PR existente y siguiente acción concreta. Si faltan comandos, la tarea explícita de reparación debe descubrirlos/documentarlos, no declarar tests aprobados. Auditor recibe candidato y requisitos/evidencia, no una orden de emitir Good. Respuesta compacta: SHA/PR, pruebas/resultados, hallazgos, bloqueos, siguiente acción.

Requisitos adicionales FND-ORCH: deduplicación de audit por SHA, sesiones separadas y modelos fijados, pulse sin transición silencioso, crash/restart y eventos stale, merge automático condicionado, bloqueo de gates, leases de repair/shared paths y colisión de dispatchers. No reducir calidad para facilitar autonomía.
