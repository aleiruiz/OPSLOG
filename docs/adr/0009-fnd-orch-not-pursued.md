# ADR-0009 — El propietario decide no perseguir el trabajo de FND-ORCH (orquestador)

Estado: **Confirmado por el propietario en el hilo del proyecto el 2026-10-06.** Tras ver la transcripción, el propietario respondió: «you got it right» (mensaje de las 08:33 UTC, relayado por el coordinador a la sesión autora). Este repositorio no puede verificar esa confirmación (la misma limitación que ADR-0008, que también recoge decisiones tomadas fuera del repositorio): el registro es una transcripción por la sesión autora, no una firma del propietario ni una aprobación de los auditores.
Fecha de la decisión: 2026-10-06, America/Mexico_City.
Decisor: Alei Ruiz (propietario).

## Contexto

ADR-0008 aceptó diferir a G1, como máximo a su cierre, los componentes no construidos de FND-ORCH (reconstrucción desde fake de GitHub, store persistente y proyección de Tasks, `simulate`/simulación de dispatch, fake de git/worktree y los e2e de bootstrap, recuperación, gate que bloquea M1 e invalidación por SHA; la lista vigente está en `docs/tasks/FND-ORCH.md`). Los dos auditores independientes de G1 sobre `main@b53f7af` señalaron que esa fecha límite se alcanza con G1 y que no había en el repositorio ninguna decisión posterior del propietario: `docs/tasks/FND-ORCH.md` y ADR-0008 no cambian desde `b0f45f5`.

## Decisión

El 2026-10-06, en el hilo del proyecto, el propietario indicó: «Yes start working on this, except the orchestrator thing, that was an issue on codex and I've not had that issue with you». Se transcribe así:

- No se persigue el trabajo de FND-ORCH ni del orquestador. Los componentes diferidos por ADR-0008 no se construyen en M1.
- Esto **supera la fecha de diferimiento de ADR-0008** («como máximo al cierre de G1»): ya no hay fecha, porque el trabajo no se retoma salvo nueva decisión del propietario.
- `tools/orchestrator`, `tests/orchestrator` y los pendientes de G0 sobre el orquestador **quedan sin cambios**: `handoff` frente a ADR-0007, `requestedPaths` vacío en el lease, id de auditor con lease vencido o que difiere solo en mayúsculas, gate no registrado que cuenta como abierto, validación de `stage`, `eventId` global, validación de `restore` y bloqueos por glob (`*`). Siguen abiertos y latentes: ningún entrypoint instancia el runtime fuera de `tests/orchestrator`.
- El motivo declarado por el propietario es que el problema que lo motivaba apareció con Codex y no ha vuelto a aparecer con Claude como único proveedor activo (ADR-0005/0007).

## Lo que esta decisión no hace

- No cambia SPEC-1.4 ni ORCH-1.4, ni los pines de modelo (ADR-0006/0007), ni el proveedor único activo.
- No aprueba G1: G1 conserva sus dos auditores independientes y la aceptación del propietario (ADR-0008).
- No toca `docs/baselines` ni los manifests de integridad, ni edita `docs/tasks/FND-ORCH.md` ni ADR-0008 (la evidencia histórica no se reescribe).
- No autoriza AWS (ADR-0002 sigue vigente) ni producción.

## Consecuencias y verificación

- Este ADR supera la fecha de diferimiento de ADR-0008. Si el propietario retira o corrige la decisión, un ADR posterior debe sustituirlo; el repositorio no puede comprobar el hilo del proyecto.
- Los informes de G1 deben citar este ADR como decisión del propietario transcrita y no verificable desde el repositorio, no como aprobación de los auditores.
- El registro de pendientes restantes y de las acciones del propietario está en `docs/tasks/CORE-INTEGRATE-M1-20261006.md` (sección «FIX-G1»).
