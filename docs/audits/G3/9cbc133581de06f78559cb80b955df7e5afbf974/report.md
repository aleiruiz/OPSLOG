# Informe de revalidación de gate G3 — candidato `9cbc133581de06f78559cb80b955df7e5afbf974`

Fecha: 2026-10-12. Alcance: revalidación de los hallazgos del informe `docs/audits/G3/05fa96d2057ed1910f77c9afa64f317f9cb56682/report.md` y regresión ligera. Las correcciones llegaron en los PRs #91, #92, #93, #95 y #94 (`git log 21d5ff5..9cbc133`).

Auditor: uno, independiente, con el modelo de revisión de ADR-0007, contexto limpio, no autor de las correcciones (ADR-0011 §1, decisión del propietario transcrita y no verificable desde el repositorio). Profundidad ligera según ADR-0011 §3: pruebas nuevas repetidas tres veces y mutación dirigida solo en código crítico de seguridad.

**Veredicto recomendado: APPROVE.** Los tres High y los seis Medium están resueltos con pruebas que fallan si se revierte la corrección. No hay hallazgos nuevos de seguridad Medium o superiores. Quedan solo Low e Info. Este informe **no** declara G3 aprobado: la aceptación es decisión del propietario.

## Candidato

- `9cbc133` es el squash del PR #94 sobre `2205b5f` (#95). El encargo indica que el CI `quality` (`pnpm quality`, `test:e2e` y `test:visual`) pasó sobre el head del PR #94, que es este mismo árbol.
- No se ejecutó aquí `pnpm quality` completo ni `pnpm lint` completo (ADR-0011 §3 y el límite de memoria de la máquina de 4 núcleos). Sí se ejecutó `pnpm build` (`tsc -b`), que pasó y sirve también de typecheck.

## Estado de los hallazgos del informe 05fa96d

| Hallazgo                         | Estado                                    | Evidencia                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1 cancelar atasca el plan       | Resuelto                                  | `service.ts:291-311` emite `preventive_cancelled`; el worker lo consume (`apps/worker/maintenance-plans/src/index.ts:76-99`); `lifecycle.ts:318-335` deja la ocurrencia `cancelled`; `worker-store.ts:170-173` solo bloquea con una ocurrencia `scheduled`. Reproducido en MySQL 8.4.11 con el mismo escenario: `qa-plan-lifecycle.integration.test.ts:151`                                                                                                    |
| H2 falta `Idempotency-Key`       | Resuelto                                  | Clave por (tenant, actor, comando, clave) en la PK (`orders/src/migrations.ts:115-123`); hash SHA-256 del payload canónico (`idempotency.ts:33-34`); replay, 409 por conflicto y nueva comprobación de permisos (`execute.ts:47-106`); obligatoria en `close` y `reopen` (`execute.ts:56-60`, `bff/src/routes/work-orders.ts:166-167`). Pruebas: `qa-idempotency.integration.test.ts`, `idempotency.test.ts`, persistencia `mysql.integration.test.ts:319-580` |
| H3 sin evidencias ni facturas    | Resuelto                                  | `files.ts:42-56` exige archivos `clean` según `maintenanceEvidence`; se aplica en `complete` y `close` (`service.ts:193`, `:252`); facturas solo con `view_costs` (`files.ts:86`, `:104`). Pruebas: `qa-evidence.integration.test.ts:86-300`, `files.test.ts`, journey `e2e/maintenance-real.spec.ts:291`                                                                                                                                                      |
| M1 reabrir no recalcula el plan  | Resuelto                                  | `lifecycle.ts:142-177` (rollback a la línea base previa) y `:293-315`; la línea base excluye el cierre propio (`service.ts:199`), así que se puede corregir el km hacia abajo. Pruebas: `qa-plan-lifecycle.integration.test.ts:187`, `:250`, `:267`, `:284`                                                                                                                                                                                                    |
| M2 alertas no visibles           | Resuelto                                  | Ruta `maintenance.alerts.list` (`bff/src/routes/maintenance-alerts.ts:52`), `MaintenanceApi.listAlerts` con el alcance D9 (`plans/src/index.ts:200-209`), panel en la UI (`MaintenanceAlertsPanel.tsx`). Pruebas: `alerts.test.tsx`, `AlertsScreen.test.tsx`, `e2e/maintenance.spec.ts:216`                                                                                                                                                                    |
| M3 D9 sin vínculo real           | Resuelto                                  | `qa-world.ts:114-115` y `:189-190` usan `createMechanicScope` sobre el store real de mecánicos; aserciones positivas y no vacuas en `qa-orders.integration.test.ts:405-427`; login real de mecánico en `e2e/maintenance-real.spec.ts:186`                                                                                                                                                                                                                      |
| M4 fechas en UTC                 | Resuelto                                  | `calendarDay` con zona IANA (`plans/src/rules.ts:114`); usado en el evaluador (`evaluator.ts:20`), el worker (`worker-store.ts:154`) y la fecha real no futura (`service.ts:196`). Prueba: persistencia de planes `mysql.integration.test.ts:97` (America/Mexico_City). La trazabilidad declara que documentos, seguros y alertas siguen en UTC                                                                                                                |
| M5 permiso de D20                | Resuelto                                  | `workflow.ts:92` y `apps/web/features/maintenance/workflow.ts:39` usan `incidents:approve`; el rol administrador lo recibe (`composition/src/access.ts:25`)                                                                                                                                                                                                                                                                                                    |
| M6 IDs técnicos en la UI         | Resuelto, con limitación documentada      | `OptionPicker` de responsable (`CommandForm.tsx`), `VehiclePicker.tsx`, etiquetas en ficha y Mis órdenes (`WorkOrderDetail.tsx:156`, `MyOrdersScreen.tsx:73`). Las personas se nombran por mecánico o por rol («Mecánico 2») porque el contrato de identidad no trae nombres. Pruebas: `directory.test.tsx`, `shell.test.tsx`                                                                                                                                  |
| L1 D9 abierto al desactivar      | Resuelto                                  | `workflow.ts:64-65` con `mechanicLinked`; `mechanic-scope.ts:28-29` cuenta registros activos o no. Prueba: `qa-orders.integration.test.ts:430`                                                                                                                                                                                                                                                                                                                 |
| L2 catálogo completo al mecánico | Resuelto                                  | `plans/src/index.ts` devuelve planes vacíos o `not_found`, y solo los mecánicos y talleres propios, sin contacto, a un llamador acotado. Prueba: `plans/src/index.test.ts:72`                                                                                                                                                                                                                                                                                  |
| L3 edición del plan lleva a DLQ  | Resuelto                                  | `lifecycle.ts:248-256`: la línea base no retrocede y el cierre ya no falla. Prueba: `qa-plan-lifecycle.integration.test.ts:306`                                                                                                                                                                                                                                                                                                                                |
| L4 409 descarta tareas           | Resuelto                                  | `workMerge.ts:46` (fusión de tres vías). Pruebas: `workMerge.test.ts`, `WorkOrderDetail.test.tsx`                                                                                                                                                                                                                                                                                                                                                              |
| L5 pruebas vacuas                | Resuelto                                  | `e2e/maintenance-real.spec.ts:181` comprueba 200; `apps/web/features/maintenance/shell.test.tsx:44` comprueba el 403 real                                                                                                                                                                                                                                                                                                                                      |
| L6 accesibilidad y enlace        | Resuelto                                  | Ruta `/flota/mantenimiento/ordenes/:id` (`apps/web/app/routes.ts:277-282`); `e2e/maintenance.spec.ts:115-149` (axe de los formularios), `:191` (atrás y adelante) y `:230` (360 px dentro del shell)                                                                                                                                                                                                                                                           |
| L7 axe cerca del timeout         | Resuelto (no reejecutado aquí)            | `e2e/components.spec.ts:146-184` parte el pase en ocho grupos más la página. Lo cubre el CI `test:e2e` del PR #94                                                                                                                                                                                                                                                                                                                                              |
| I1 D20 no activable              | Resuelto, con la semántica ya documentada | Umbral `closeCostThreshold` en la configuración; `work-order-apis.ts:130-131` lo usa. Con umbral, todo cierre pide aprobación sin comparar el monto (documentado en `docs/traceability/maintenance.md:40`)                                                                                                                                                                                                                                                     |

## Regresión ligera

Entorno: MySQL **8.4.11** desechable (contenedor `mysql3309`), Node 22.22.0, Chromium 1194 preinstalado. Sin `.env`, solo datos sintéticos. Antes de las suites se ejecutó `pnpm build` (verde).

| Comprobación                                                                     | Resultado                        |
| -------------------------------------------------------------------------------- | -------------------------------- |
| `vitest run tests/e2e/maintenance` (7 archivos) ×3                               | 40/40 cada vez                   |
| `@opslog/persistence-maintenance-orders` `test:integration` (incluye las claves) | 12/12 cada vez                   |
| `@opslog/persistence-maintenance-plans` `test:integration`                       | 7/7 cada vez                     |
| `e2e/maintenance-real.spec.ts` + `e2e/maintenance.spec.ts` con `CI=1` ×3         | 19/19 cada vez, de 1,0 a 1,1 min |

Ninguna prueba se omitió: `OPSLOG_TEST_MYSQL_ADMIN_URL` estaba definido en todas las corridas.

### Mutación dirigida (5/5 detectados)

Cada mutante se aplicó solo, se corrieron la unit del dominio de órdenes y `tests/e2e/maintenance` (y la integración de persistencia en C), y se revirtió con `git checkout`. Al final `git status` quedó limpio.

| Mutante                                                                              | Detectado por                                                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| A. El replay no vuelve a comprobar visibilidad ni permiso (`execute.ts:104` borrado) | unit `idempotency.test.ts` (replay con permiso revocado)                                   |
| B. El replay no compara el hash del payload (`execute.ts:101`)                       | unit `idempotency.test.ts` + `qa-idempotency.integration.test.ts` (otra carga, mismo key)  |
| C. La búsqueda de la clave ignora al actor (`orders/src/store.ts:232`)               | integración de persistencia (aislamiento por actor) + `qa-idempotency.integration.test.ts` |
| D. El alcance del mecánico ignora `mechanicLinked` (`workflow.ts:65`)                | unit `service.test.ts` (D9 falla cerrado) + `qa-orders.integration.test.ts:430`            |
| E. `close` no exige la evidencia configurada (`service.ts:252` borrado)              | unit `files.test.ts` + `qa-evidence.integration.test.ts:86`                                |

Las detecciones son por aserción, no por umbral de cobertura: la unit se corrió sin cobertura. El mutante A solo lo detecta la unit; ninguna prueba MySQL cubre el replay con permiso revocado. No es un hueco de seguridad porque el código es el mismo, pero se anota.

## Hallazgos nuevos

No hay hallazgos High ni Medium.

- **N1 (Low, D20).** Adjuntar o quitar una factura o evidencia en una orden `completed` no borra la aprobación de cierre. `files.ts:172-177` crea la nueva versión sin `closeApproval: null`, mientras que `base.ts:157-158` declara que cualquier edición posterior de una orden completada necesita una aprobación nueva. Hoy el impacto es pequeño: la factura es un documento de soporte y los montos siguen en `updateCosts`, que sí borra la aprobación.

## Seguimientos conocidos, confirmados (Low / Info)

- **Low.** `closeCostThreshold` se lee con `view` en `GET` de la configuración (`composition/src/settings.ts:101`, `:109`), sin `view_costs`. Es un umbral de configuración, no el costo de una orden.
- **Info.** D20 pide aprobación para todo cierre cuando hay umbral; el monto no se compara (`work-order-apis.ts:128-131`, documentado en la trazabilidad).
- **Low.** Archivos huérfanos: `uploadFile` guarda el archivo antes del vínculo (`orders/src/index.ts:297-307`) y no lo retira si el vínculo pierde el CAS. `detachFile` borra solo el vínculo.
- **Low.** `WorkOrderApi.command()` (`orders/src/index.ts:149-158`, `:341-350`) aún acepta `close` y `reopen` por tipo y llama al servicio sin clave. Es latente: la BFF usa solo `transition()` para los comandos de estado.
- **Info.** No hay purga de claves vencidas; la tabla crece una fila por comando con clave (limitación declarada).
- **Info.** `mechanicLinked` es opcional en `WorkOrderApiDeps`; si una composición futura lo omite, el alcance vuelve al criterio anterior. La composición actual lo pasa (`work-order-apis.ts:161`).

## Verificado conforme

- **Ciclo de vida del plan.** Plan y ocurrencia se bloquean en el mismo orden que el escaneo. Cada evento se aplica una vez por versión de la orden (`appliedVersion`). Los eventos fuera de orden convergen y los sucesores adoptados nunca se descartan (pruebas de carrera en `qa-plan-lifecycle.integration.test.ts:400` y `:449`).
- **Idempotencia.** La clave se escribe en la misma transacción que el CAS, el historial, la auditoría y el outbox. Un comando rechazado no deja clave. Dos duplicados concurrentes dan un solo efecto. La respuesta guardada se filtra por `view_costs` del llamador en cada replay.
- **Evidencia.** Solo cuenta un archivo `clean` del mismo tenant subido por el mismo actor. Un archivo se vincula una sola vez por empresa. Orden cerrada o cancelada no admite cambios. Nada de los archivos viaja en el outbox.

## Recomendación

1. Aceptar las correcciones de H1–H3, M1–M6, L1–L7 e I1.
2. Registrar N1 y los seguimientos Low como deuda diferible, a criterio del propietario.

Este informe no declara G3 aprobado. La aceptación de G3, y por tanto el inicio de M4, sigue siendo decisión registrada del propietario.

## Decisión del propietario

- 2026-10-12, 23:38 UTC: Alei Ruiz aceptó G3 sobre `9cbc133` en el hilo del proyecto («Si, lo apruebo.»). La decisión está transcrita y no se puede verificar desde el repositorio.
- N1 y los seguimientos Low e Info de este informe quedan como deuda diferible.
