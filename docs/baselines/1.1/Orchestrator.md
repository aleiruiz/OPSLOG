# OPSLOG — ORCH-1.1: un proveedor activo y auditores del mismo proveedor

Fecha: 2026-10-03, America/Mexico_City.
Estado: sucesora acotada adoptada por aclaración directa del usuario.
Hereda [ORCH-1.0](../../../Orchestrator.md) sin editar el original; aplicar todas sus reglas salvo las sustituciones expresas de esta versión. Compatible con [SPEC-1.1](SPECS.md).

## 1. Exclusividad por proveedor

Hay un único proveedor activo por repositorio: `openai` o `anthropic`. Orquestador, implementadores, integradores, subauditores, auditores de PR/hito y herramientas de agentes deben pertenecer al proveedor activo.

Se permiten múltiples agentes/worktrees simultáneos del mismo proveedor para sostener los tres carriles. No se permiten agentes del otro proveedor trabajando, leyendo el cambio para auditarlo o ejecutando una revisión en paralelo. El proveedor inactivo no es una dependencia de aceptación.

Modelos fijos: `gpt-5.6-luna` para OpenAI/Codex y `claude-sonnet-5` para Anthropic/Claude. Registrar identificadores efectivos. No usar otros modelos para obtener independencia: obtenerla mediante roles/sesiones/contexto aislados.

## 2. Roles y revisiones que sustituyen ORCH-1.0

Las dos filas de auditor externo por proveedor de ORCH-1.0 §1 se sustituyen por **Auditor independiente A** y **Auditor independiente B**, del proveedor activo. No participaron como autores en el paquete evaluado; tienen sesiones diferentes, baseline/contratos/diff/pruebas y no reciben el veredicto del otro antes de emitir el suyo. Subauditor local sigue separado y no cuenta como A/B.

En §6, pasos 3/6/8 y restricciones de proveedor, consenso es autor con respuestas resueltas más A/B `pass` sobre el mismo headSHA, CI requerido y candidato actualizado. No hay requisito OpenAI+Anthropic. Las correcciones y conflictos que cambien SHA invalidan los veredictos como antes.

En §7 y gates G0–G5, los dos auditores de hito pertenecen al proveedor activo y son independientes de los autores del incremento. Se mantienen auditoría acumulativa, ambiente cerrado, datos sintéticos, hallazgos, revalidación y decisión humana si fue solicitada.

En FND-INTEGRATE/FND-ORCH, verificar capacidad/adaptador/modelo del proveedor activo y rechazo de doble proveedor. Documentar interfaz del proveedor alternativo sin invocarlo. Un proveedor inactivo ausente no impide aceptar el paquete o gate.

## 3. Bloqueo y transferencia de proveedor

El orquestador guarda exclusividad en `.orchestrator/provider-lock` o en el state store transaccional: repositoryId, activeProvider, ownerSession, epoch/fencing token y estado `active | draining | released`. Antes de lanzar cualquier agente, revisar ownership/epoch y proveedor. Bootstrap manual registra equivalente verificable hasta que exista runtime.

Para pasar de Codex a Claude o viceversa:

1. Dejar de asignar tareas nuevas y marcar `draining`.
2. Esperar finalización o detener explícitamente los agentes/subagentes/auditores activos; comprobar estado real antes de liberar leases. Un heartbeat vencido por sí solo no prueba que murió la sesión.
3. Conservar commits, worktrees, PRs, checks, hallazgos abiertos y estado de gates; no descartar trabajo para cambiar proveedor.
4. Preparar handoff sanitizado con base/headSHAs, tareas, ownership, dependencias y siguiente acción; no credenciales ni razonamiento privado.
5. Liberar escritor de Tasks/store y lock anterior; nueva sesión adquiere exclusividad con epoch nuevo y modelo correspondiente.
6. Reconciliar contexto e iniciar únicamente agentes del nuevo proveedor. Resultados de epoch anterior no autorizan una mutación tardía.

Un PR o gate con veredictos completos previos sobre código idéntico conserva evidencia histórica; un cambio de SHA exige auditoría del proveedor que lo revise ahora. Una revisión inconclusa al transferir debe cerrarse mediante dos sesiones independientes del nuevo proveedor, sin fingir participación del anterior ni exigir revisión cruzada.

## 4. Evidencia y pruebas adicionales de FND-ORCH

Probar que se rechaza lanzamiento del proveedor inactivo, que tres agentes del activo pueden trabajar sin path compartido, que transferencia exige drenar/liberar leases y que eventos con epoch antiguo no fusionan ni cambian gates. Un fallo/disponibilidad del proveedor activo sí puede bloquear trabajo dependiente; no cambiar proveedor automáticamente sin handoff coordinado.

Tasks.md muestra proveedor activo, modelo, sesión propietaria y estado de transferencia además de campos ORCH-1.0. Solo orquestador activo lo escribe. Los paquetes consumen SPEC-1.1/ORCH-1.1 junto con baselines originales y registran esta aclaración antes de despachar.

## 5. Inmutabilidad

Esta sucesora cambia exclusivamente coordinación de proveedores e independencia de auditoría. Mantener intactos los originales SPEC-1.0/ORCH-1.0 y sus hashes; congelar también estos documentos con manifiesto 1.1. Cualquier cambio incompatible posterior necesita sucesora explícita. No se declaran gates o pruebas completados por actualizar políticas.
