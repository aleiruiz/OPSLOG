# Informe de auditoría de gate G3 — candidato `05fa96d2057ed1910f77c9afa64f317f9cb56682`

Fecha: 2026-10-12. Alcance: acumulativo M0–M3, con foco en M3 (PRs #79–#88) y regresión de M0–M2. Encargo: `docs/tasks/G3-AUDIT-20261012.md`.

Auditor: uno, independiente, `claude-opus-5-5`, contexto limpio, no autor de M3 (ADR-0011 §1, decisión del propietario transcrita y no verificable desde el repositorio). Profundidad ligera según ADR-0011 §3: pruebas nuevas repetidas tres veces y mutación dirigida solo en código crítico de seguridad.

**Veredicto recomendado: CHANGES.** No hay hallazgos de seguridad Medium o superiores. Lo que bloquea es un defecto funcional del workflow (H1) y dos entregables de M3 que SPECS exige y que están declarados como pendientes (H2, H3). G3 **no** queda aprobado por este informe: la aceptación o el diferimiento es decisión del propietario.

## Candidato

- `05fa96d` es el squash del PR #89 sobre `cf52e26` (#88). El diff entre ambos es solo `docs/tasks/G3-AUDIT-20261012.md` y su entrada en `format:check` de `package.json`.
- La regresión local se ejecutó sobre `cf52e26`. El CI `quality` del PR #89 (head `08a5180`, base `cf52e26`) pasó completo: `pnpm quality`, `test:e2e` y `test:visual`.

## Regresión acumulativa

Entorno: MySQL **8.4.11** desechable (`mirror.gcr.io/library/mysql:8.4.11@sha256:80f4933e…`, el mismo pin de CI), Node 22.22.0, pnpm 11.25.0, Chromium 1194 preinstalado (Playwright 1.56.1). Sin `.env`, solo datos sintéticos.

| Comprobación                                                                            | Resultado                                                                         |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm quality` (baseline, leak scan, lint, format, typecheck, unit, integración, build) | Verde, 68 suites y ninguna omitida (`OPSLOG_TEST_MYSQL_ADMIN_URL` definido)       |
| `pnpm test:e2e` (`CI=1`)                                                                | 111/112 en la primera pasada; ver la nota de abajo. Al re-ejecutarlo aislado: 9/9 |
| `pnpm test:visual`                                                                      | 770/770                                                                           |
| `e2e/maintenance-real.spec.ts` + `e2e/maintenance.spec.ts` ×3                           | 30/30                                                                             |
| `tests/e2e/maintenance` ×3                                                              | 18/18 cada vez                                                                    |
| `persistence-maintenance-{orders,plans}` integración ×3                                 | 5/5 y 5/5 cada vez                                                                |

Nota: `e2e/components.spec.ts:147` (axe de todas las historias) superó su timeout de 120 s una vez, mientras la máquina de 4 núcleos compilaba en paralelo. Aislado pasó en 2,0 min para 9 pruebas, cerca del límite. No es de M3; queda como L7.

### Mutación dirigida (7/7 detectados)

| Mutante                                                        | Detectado por                                      |
| -------------------------------------------------------------- | -------------------------------------------------- |
| `workOrderView` expone siempre `costs` (`views.ts:34`)         | unit domain + unit api + `tests/e2e/maintenance`   |
| `transitionView` no quita costos del historial (`views.ts:48`) | unit domain + `tests/e2e/maintenance`              |
| `close` no exige aprobación D20 (`service.ts:207`)             | unit domain + `tests/e2e/maintenance`              |
| CAS del store sin `version` (`orders/src/store.ts:74`)         | integración persistencia + `tests/e2e/maintenance` |
| `requireVersion` sin efecto (`workflow.ts:89`)                 | unit domain                                        |
| `canSee` ignora el alcance del mecánico (`workflow.ts:63`)     | unit domain + unit api + `tests/e2e/maintenance`   |
| `close` sin `view_costs` (`workflow.ts:81`)                    | unit domain                                        |

Los paquetes de dominio tienen umbrales de cobertura, así que una parte de las detecciones en unit podría deberse al umbral y no a una aserción. Las que también detecta `tests/e2e/maintenance` sí son por aserción.

## Hallazgos bloqueantes

### H1 (High, funcional): cancelar una orden preventiva deja el plan atascado para siempre

- `packages/persistence/maintenance/plans/src/worker-store.ts:193-202`: `scan()` no genera nada mientras la última ocurrencia no esté `completed` o `closed`. Como mucho emite un `overdue`.
- `packages/domain/maintenance/orders/src/service.ts:244-255`: `cancel` solo registra el cambio de estado. Nada en planes, el worker o la composición consume la cancelación.
- **Reproducido** sobre MySQL 8.4.11: plan cada 30 días, escaneo, adopción, cancelación y escaneos el 2026-11-15, 2026-12-20 y 2027-03-01. Las órdenes programadas del plan siguen siendo 1, la original (`scheduled`), y no se genera ninguna nueva. La ocurrencia tampoco se puede volver a adoptar, porque el id ya existe (`service.ts:58` devuelve `duplicate`).
- SPECS §6.1 (`SPECS.md:229`) permite cancelar desde scheduled, assigned e in_progress. Con este defecto, el mantenimiento preventivo del vehículo deja de funcionar sin aviso, que es justo lo que M3 debe evitar (trabajo reactivo).

### H2 (High, contrato): falta `Idempotency-Key` en cierre y reapertura

- `SPECS.md:195` es normativo: clave por tenant, actor y comando, con hash del payload y expiración; la misma clave con otro payload devuelve 409; «No reintentar una operación financiera parcialmente aplicada sin esta defensa».
- `docs/tasks/MNT-QA-M3-20261011.md:62` exige el replay estable y el 409 por conflicto. Las líneas `:95` y `:111` dicen que cualquier implementación faltante deja pendiente la validación de M3.
- La descripción del pendiente en `docs/traceability/maintenance.md` es exacta: el CAS de versión evita el doble efecto, pero no hay registro de claves. Hoy un reintento de red recibe 409 `stale_version` en lugar del resultado estable.
- Bloquea según `SPECS.md:352`, salvo que el propietario lo difiera explícitamente.

### H3 (High, alcance): no hay evidencias ni facturas

- `SPECS.md:44` y `:348` incluyen «evidencia» en el alcance de M3. `:227` exige evidencias/factura «según configuración» para completar.
- `MNT-QA-M3:61` pide bloquear el cierre si falta evidencia configurada, y `:89` pide registrar evidencia en el journey de navegador. `e2e/maintenance-real.spec.ts:104-135` no registra evidencia y tampoco asigna un mecánico (solo responsable y taller).
- Se puede leer «según configuración» como «ninguna configurada», pero el entregable de evidencia de M3 no existe. Decisión del propietario: implementar o diferir.

## Hallazgos no bloqueantes (Medium, diferibles por el propietario)

- **M1. La reapertura no recalcula el plan.** `worker-store.ts:346` ignora un segundo `preventive_closed` cuando la ocurrencia ya está `completed`. `service.ts:159-166` rechaza re-completar con fecha o km menores que los del primer cierre. Así, un km mal tecleado no se puede corregir hacia abajo, y una corrección hacia arriba se descarta en silencio. SPECS §6.1 pide «recalcular plan idempotentemente». La prueba `qa-orders.integration.test.ts:183-191` re-cierra con los mismos valores, así que no lo detecta. Reabrir y luego cancelar deja el plan avanzado sobre trabajo cancelado.
- **M2. Las alertas de mantenimiento no se ven en la interfaz.** Incumple la aceptación #8 de `MNT-UI-M3` (`docs/tasks/MNT-UI-M3-20261011.md:98`). `packages/contracts/src/bff/alerts.ts` no tiene una fuente de mantenimiento. El pendiente está bien declarado.
- **M3. La prueba de D9 no ejercita el vínculo real miembro → mecánico.** `tests/e2e/maintenance/qa-world.ts:117` simula `mechanicIdsOfMember: async () => []` y los actores traen `mechanicIds` fijos. El `.every(...)` de `qa-orders.integration.test.ts:389-393` también pasa con una lista vacía, y el journey real no tiene login de mecánico. La fila FR-096 de la trazabilidad sobrestima la evidencia.
- **M4. Fechas de calendario en UTC, no en la zona IANA del tenant.** `SPECS.md:184` pide la zona del tenant. `packages/domain/maintenance/plans/src/evaluator.ts:155`, `worker-store.ts:195,226,263` y `service.ts:157` usan `toISOString().slice(0,10)`. En America/Mexico_City, desde las 18:00 locales, las alertas y la orden salen un día antes. MNT-PLANS lo redactó en UTC, así que quizá fue una aceptación consciente, pero no consta como desviación.
- **M5. Permiso de D20.** `SPECS.md:79` pide `incidents:approve`. El código usa el permiso genérico `approve` (`packages/domain/maintenance/orders/src/workflow.ts:80`, `apps/web/features/maintenance/workflow.ts:39`) y la desviación no está documentada. El impacto es latente: `apps/api/composition/src/platform/work-order-apis.ts:91` fija `closeApprovalRequired` en `false` hasta que exista el umbral (pendiente declarado).
- **M6. La interfaz pide y muestra IDs técnicos.** El responsable se escribe como UUID en texto libre (`apps/web/features/maintenance/CommandForm.tsx:66-70`) y el vehículo también (`PlanForm.tsx:96-102`, `CorrectiveOrderForm.tsx:63-73`). Las fichas muestran IDs (`WorkOrderDetail.tsx:150,198,200`, `MyOrdersScreen.tsx:71`). Funciona, pero queda lejos de la usabilidad de SPECS §8.

## Hallazgos Low / Info

- **L1. El alcance D9 queda abierto si el vínculo del mecánico se desactiva.** `workflow.ts:55-56` + `work-order-apis.ts:47-50`: con `mechanicIds = []` el usuario ya no está acotado y ve todas las órdenes que su rol `view` permite. No cruza tenants ni expone costos. Pasa a Medium cuando exista la plantilla de rol de mecánico.
- **L2.** Un mecánico acotado puede leer todo el catálogo: planes, órdenes programadas, talleres y mecánicos (`apps/api/maintenance/plans/src/index.ts:55-59`). No hay costos ni PII de D23.
- **L3.** `worker-store.ts:348-349`: si se edita el plan y sube `lastServiceKm` entre la completación y el cierre, el evento de cierre falla siempre y acaba en la DLQ. El plan cae en el estado de H1.
- **L4.** Tras un 409, «Recargar» conserva el borrador, pero `WorkEditor.tsx:42-47` reenvía la lista completa de tareas con la versión nueva y descarta tareas concurrentes. `WorkOrderDetail.test.tsx:201-213` no comprueba el borrador tras recargar.
- **L5. Pruebas vacuas o mal nombradas.** `e2e/maintenance-real.spec.ts:164-168` no comprueba el estado HTTP del fetch crudo. `apps/web/app/shell.test.tsx:33` se llama «role without view → 403» pero usa `viewer` y no comprueba ningún 403.
- **L6. Huecos de accesibilidad y responsive.** Mis órdenes a 360 px solo se prueba fuera del shell (`e2e/maintenance.spec.ts:64-95`). El axe de navegador con contraste no recorre `CorrectiveOrderForm`, `WorkEditor`, `CostEditor` ni `PlanForm` en edición. La ficha no tiene enlace profundo ni funciona el botón atrás (`MaintenanceArea.tsx:44`).
- **L7.** `e2e/components.spec.ts:147` corre cerca de su timeout de 120 s; ver la nota de la regresión.
- **I1.** D20 no se puede activar en producción hasta que el umbral exista en la configuración de la empresa (pendiente declarado). La lógica en sí es sólida: editar o reabrir borra la aprobación, y el cierre vuelve a comprobarla bajo CAS.

## Verificado conforme

- **Workflow.** La tabla de transiciones (`workflow.ts:11-18`) coincide con SPECS §6.1, y `approve_close` no cambia el estado. Closed y Cancelled bloquean la edición. Todo comando pasa por `requireVersion` y el store hace `UPDATE … WHERE version` con `affected === 1`. Con dos cierres concurrentes gana uno solo (probado).
- **Generación preventiva.** No se duplica: hay bloqueo de escritura sobre el plan, claves únicas (plan, secuencia) y (empresa, ocurrencia), y el plan avanza una sola vez. Umbrales de 15 días y 500 km inclusivos; overdue solo estrictamente después del objetivo.
- **Dinero.** Unidades menores enteras como texto más moneda ISO; cantidades DECIMAL(10,3). Sin flotantes.
- **D11.** El cierre exige una decisión explícita sobre el vehículo y no permite volver a `active` con otro episodio de taller abierto.
- **D14.** No hay gate de presupuesto.
- **Seguridad multitenant.**
  - Tenant y actor salen solo de la sesión. Los IDs ajenos dan el mismo error que los desconocidos, también los referenciados en el body.
  - `view_costs` se aplica en el servidor en listas, detalle, transiciones, historial y errores. La auditoría solo guarda `{attempts:1}`.
  - El alcance del mecánico se filtra en SQL y vuelve a comprobarse con `canSee`.
  - El negocio, los hijos, el historial, la auditoría y el outbox se escriben en una sola transacción (rollback probado).
  - El outbox usa allowlist exacta por tipo de evento, sin PII ni costos. El worker toma el tenant del sobre del outbox, con una base física por tenant.
  - No hay SQL interpolado en producción y la asignación masiva está bloqueada por allowlists.
- **UX.** Navegación del shell a Mantenimiento con guarda `view`. NextStepPanel muestra los faltantes estructurados. El 409 ofrece recargar sin sobrescribir. Estados de carga, vacío, error, 401 y 403. Todos los campos tienen etiqueta.
- **Omisiones.** Las suites MySQL fallan en CI si falta la URL, en lugar de omitirse en silencio.

## Recomendación

1. Corregir H1: que la cancelación de una preventiva libere o cierre la ocurrencia, de modo que el plan vuelva a programar. Añadir una prueba con MySQL.
2. Para H2 y H3, implementar o que el propietario los difiera explícitamente, con condición de desbloqueo, como se hizo con ADR-0010.
3. Diferir o corregir M1–M6 a criterio del propietario.

Este informe no declara G3 aprobado. M4 sigue bloqueado hasta la aceptación registrada del propietario.
