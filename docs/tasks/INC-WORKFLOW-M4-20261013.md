# INC-WORKFLOW-M4-20261013: máquina de estados del siniestro, cierre y reapertura

```yaml
id: INC-WORKFLOW-M4-20261013
baseline: [SPEC-1.4, ORCH-1.4, inherited: SPEC/ORCH 1.0-1.3 not superseded]
active_provider: anthropic
model: pin de código vigente según ADR-0007, sin fallback
milestone: M4
kind: implementation
wave: 2
base_sha: el SHA de main que contiene la fusión de INC-CASES PR 2 (registrarlo al asignar)
depends_on:
  - G3 aceptado por el propietario el 2026-10-12 (instrucción directa)
  - INC-CASES-M4-20261013 PR 1 y PR 2 fusionados (modelo Incident, timeline, idempotencia, evidencia)
requirements:
  [
    FR-112,
    FR-113,
    FR-116,
    FR-119 (asignación; aviso in-app en INC-SLA),
    FR-120,
    FR-121,
    BR-I7,
    BR-016,
    BR-017,
    BR-028 (según D20),
    US-032,
    US-033,
    SPECS §2.3 D8/D10/D11/D16/D20,
    ADR-0014,
    SPECS §5.2,
    SPECS §5.3,
    SPECS §6,
    SPECS §6.2,
    SPECS §7 (eventos incident.*),
  ]
write_paths:
  - packages/domain/incidents/workflow/**
  - packages/persistence/incidents/workflow/**
  - apps/api/incidents/workflow/**
  - packages/contracts/src/bff/incident-workflow.ts (nuevo)
  - apps/api/bff/src/routes/incident-workflow.ts (nuevo) y apps/api/bff/src/incident-workflow.test.ts (nuevo)
  - apps/api/composition/src/platform/incident-workflow-apis.ts (nuevo)
  - tests/integration/platform/incident-workflow.test.ts y mysql-incident-workflow.test.ts (nuevos)
  - packages/domain/maintenance/orders/src/{types.ts,service.ts} (solo PR 2: puerto opcional de bloqueos del vehículo)
  - docs/tasks/INC-WORKFLOW-M4-20261013.md
shared_paths_owned_in_wave_2:
  - registro de contratos, rutas BFF, composición, arneses MySQL y raíz (lista de INC-CASES)
  - packages/domain/settings/**, packages/persistence/settings/**, packages/contracts/src/bff/alerts.ts, apps/api/bff/src/routes/alerts.ts (campo de foto al reportar)
  - packages/domain/incidents/cases/** y apps/api/incidents/cases/** solo para enganchar la vista `allowedCommands` y bloquear escrituras por estado; sin cambiar el modelo
forbidden_paths:
  - SPECS.md, Orchestrator.md, docs/baselines/**, Tasks.md, .env*, AWS, producción
  - apps/web/** (INC-UI)
  - packages/domain/incidents/{costs,repairs,sla}/** y equivalentes
  - tests/integration/incidents/**, tests/e2e/incidents/** (INC-INTEGRATE)
status: paquete preparado; espera la fusión de INC-CASES
```

## Encargo

Implementar la tabla de SPECS §6.2 como comandos, con requisitos estructurados, permisos por comando, versión, idempotencia en comandos financieros, timeline, aprobación D20 cuando el costo supera el umbral, cierre con snapshot, reapertura con ciclo nuevo y decisión explícita del estado del vehículo. No hay otras transiciones ni override (D16). Este paquete define los puertos que INC-COSTS implementa después; mientras no existan, fallan cerrado.

Orden de M4 y dueños de archivos compartidos: ver la tabla de `INC-CASES-M4-20261013.md`. Este paquete es la ola 2.

## Fuentes

- `SPECS.md` §2.3 (D8, D10, D11, D16, D20), §5.2, §5.3, §6, §6.2, §7, §8; `Orchestrator.md` INC-WORKFLOW e INC-INTEGRATE.
- BRD v0.2 §11.1 a §11.4, §19 (BR-016, BR-017, BR-028), §20 (FR-112, FR-113, FR-116, FR-119 a FR-121), §21 (US-032, US-033, US-051), §22 (US-032, US-033). SPECS prevalece sobre el BRD: la tabla de SPECS §6.2 sustituye la de BRD §11.2.
- ADR-0014: decisiones del propietario del 2026-10-13 sobre D20 por monto, permisos propios de siniestros y `repair` con orden o presupuesto.
- Informe G3: idempotencia obligatoria en comandos con efecto financiero (H2), aprobación con `incidents:approve` y no con `approve` (M5), evidencia solo `clean` (H3), alcance que falla cerrado (L1) y zona del tenant (M4).
- Código: `packages/domain/maintenance/orders` (`TRANSITIONS`, `requireVersion`, `missing`, `IdempotentCommands.execute`, aprobación D20 que se borra al editar o reabrir), `packages/domain/settings` (`closeCostThreshold`, `timeZone`), puertos de INC-CASES (evidencia, cobertura, timeline).

## Comandos y tabla de transiciones

`POST /api/v1/incidents/:incidentId/transitions` con `{command, version, ...}`. `allowed` se calcula en el servidor; el cliente nunca envía `status`.

| Comando              | Origen → destino                                                                                                                   | Permiso                                                            | Requisitos (ids estables)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `report`             | `draft` → `reported`                                                                                                               | `incidents:edit`, o autor del borrador con `incidents:report` (D8) | `vehicle`, `type`, `occurred_at`, `location`, `description`, `severity`, `driver_or_reason`, `vehicle_operable`, `photo_or_justification`. Fija `reportedAt`, `reportedBy`; inicia SLA                                                                                                                                                                                                                                                      |
| `assign`             | cualquier no terminal salvo `draft`, sin cambio de estado                                                                          | `incidents:edit`                                                   | `responsible` válido: miembro activo del tenant con `incidents:view` e `incidents:edit`                                                                                                                                                                                                                                                                                                                                                     |
| `review`             | `reported` → `under_review`; `reopened` → `under_review`                                                                           | `incidents:edit`                                                   | `responsible`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `insure`             | `under_review` → `insurance_process`                                                                                               | `incidents:edit`                                                   | `policy_at_event`, `insurer`, `claim_number`, `insurer_reported_on`, `required_documents` (parte o denuncia `clean` si el tipo lo exige)                                                                                                                                                                                                                                                                                                    |
| `no_insurance`       | `under_review` → `no_insurance`                                                                                                    | `incidents:edit`                                                   | `no_insurance_reason`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `reject`             | `insurance_process` → `insurance_rejected`                                                                                         | `incidents:edit`                                                   | `rejection_reason`, `rejection_letter` (evidencia `clean` de categoría `rejection_letter`)                                                                                                                                                                                                                                                                                                                                                  |
| `appeal`             | `insurance_rejected` → `insurance_process`                                                                                         | `incidents:edit`                                                   | `appeal_note`; borra `assumptionApproval`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `approve_assumption` | `insurance_rejected`, sin cambio de estado                                                                                         | `incidents:approve`                                                | `d20_configured`; registra `assumptionApproval`                                                                                                                                                                                                                                                                                                                                                                                             |
| `repair`             | `under_review` (si el tipo permite ruta directa), `no_insurance`, `insurance_process`, `insurance_rejected`, `reopened` → `repair` | `incidents:edit`                                                   | `repair_allowed_for_type` (si no, `invalid_transition`), `repair_order_or_budget` (orden correctiva vinculada o evidencia `budget` `clean`, ADR-0014); desde `insurance_process` además `insurer_result` aceptado o parcial; desde `no_insurance` o `insurance_rejected` además `cost_assumed`; desde `insurance_rejected` además `assumption_approval` si el costo supera el umbral D20; desde `reopened` además `responsible`             |
| `resolve`            | `under_review` (ruta directa), `no_insurance`, `insurance_process`, `insurance_rejected`, `repair` → `resolved`                    | `incidents:edit`                                                   | `resolution_summary`, `vehicle_status_decision`; desde `insurance_process` `insurer_result`; desde `no_insurance` o `insurance_rejected` `cost_assumed` (y `assumption_approval` si el costo supera el umbral D20); desde `repair` `repair_orders_finished` (sin órdenes vinculadas se cumple), `repair_costs` (costos de las órdenes o, sin órdenes, al menos una línea propia de categoría `repair`), `final_evidence`. Fija `resolvedAt` |
| `approve_close`      | `resolved`, sin cambio de estado                                                                                                   | `incidents:approve`                                                | `d20_configured`; registra `closeApproval`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `close`              | `resolved` → `closed`                                                                                                              | `incidents:close` y `incidents:view_costs`                         | revalida todos los requisitos de `resolve`, `no_pending_evidence`, `repair_orders_closed`, `close_approval` si el costo supera el umbral D20                                                                                                                                                                                                                                                                                                |
| `reopen`             | `closed` → `reopened`                                                                                                              | `incidents:reopen`                                                 | `reason`; `cycle + 1`; conserva el snapshot del cierre previo; borra `closeApproval`                                                                                                                                                                                                                                                                                                                                                        |
| `cancel`             | cualquier no terminal → `cancelled`                                                                                                | `incidents:edit`, o autor de un `draft` con `incidents:report`     | `reason`, `no_costs`, `no_repairs`                                                                                                                                                                                                                                                                                                                                                                                                          |

`closed` y `cancelled` son terminales. `reopened` → `under_review` o `repair` con responsable y requisitos de destino. Cada error de requisitos es 422 `missing_requirements` con la lista completa de ids; estado no permitido 409 `invalid_transition`; versión obsoleta 409 `stale_version`.

`GET /api/v1/incidents/:incidentId/next-steps` devuelve para el actor actual `[{command, missingRequirements[]}]` solo de los comandos que su permiso y el estado permiten. La UI muestra esa lista; no recalcula reglas.

## Datos del proceso

`PUT /api/v1/incidents/:incidentId/insurance` con `version`: `policyId` (debe cubrir `occurredOn`; reemplaza `policySnapshot`), `insurerName` (precarga del snapshot), `claimNumber`, `adjusterName`, `adjusterContact`, `insurerReportedOn` (día del tenant, no futuro ni anterior a `occurredOn`), `insurerResult` (`pending`, `accepted`, `partial`, `rejected`), `rejectionReason`, `appealNote`, `noInsuranceReason`. Se admite en `under_review`, `insurance_process`, `insurance_rejected`, `no_insurance` y `reopened`. `PUT /api/v1/incidents/:incidentId/resolution` con `resolutionSummary`, `totalLoss`, `vehicleStatusDecision` y `costAssumed`, en los estados desde los que se puede resolver y en `resolved`. Cambiar la resolución en `resolved` borra `closeApproval`.

`no_insurance` se registra como decisión del caso. El texto visible nunca afirma falta legal de cobertura: dice "Sin póliza registrada vigente a la fecha del evento" (SPECS §6.2).

## Invariantes

1. Solo existen los comandos de la tabla. Los permisos son los propios de siniestros (ADR-0014): los verbos genéricos `view`, `create` y `edit` no habilitan ningún comando. Ningún endpoint de INC-CASES, INC-COSTS ni INC-SLA cambia `status`.
2. `closed` y `cancelled` rechazan toda escritura de cualquier paquete: datos, terceros, evidencia, costos, vínculos y datos de proceso. Este paquete añade la comprobación compartida que usan los demás.
3. D20 por monto (ADR-0014): con `closeCostThreshold` configurado, `close` y la asunción de costo tras rechazo exigen aprobación previa de un miembro con `incidents:approve` solo si el costo a cargo de la empresa supera el umbral. El costo es `companyBorne` por moneda, leído por el puerto `IncidentCostTotals` en la misma transacción del comando. Regla: se exige aprobación si `companyBorne` en la moneda del umbral es estrictamente mayor que el umbral, en unidad mínima, o si hay un `companyBorne` mayor que cero en otra moneda (sin conversión no se puede probar que no lo supera). Igual al umbral no exige aprobación. La asunción compara los costos registrados en ese momento; `close` vuelve a comparar con los finales. Sin umbral no se pide ni se inventa. Si la configuración o los totales no se pueden leer, el comando falla (500) en vez de tratarse como "no supera". `next-steps` solo lista `close_approval` o `assumption_approval` cuando la comparación lo exige.
4. Las aprobaciones se borran al reabrir, apelar o cambiar resolución, y por INC-COSTS al cambiar costos o vínculos. `close` comprueba la aprobación bajo el mismo CAS.
5. Idempotencia (SPECS §5.2, G3 H2): `Idempotency-Key` obligatoria en `close`, `reopen`, `approve_close` y `approve_assumption`; aceptada en el resto. Misma clave y mismo cuerpo repiten la respuesta guardada, filtrada para quien llama; otro cuerpo da 409 `idempotency_conflict`; sin clave en un comando obligatorio, 400 `idempotency_key_required`. Se reutiliza `opslog_incident_idempotency` y `canonicalJson`.
6. Cierre: escribe en la misma transacción el estado, `closedAt`, `closedBy`, una fila en `opslog_incident_closures` con el snapshot del ciclo (estado previo, resolución, decisión de vehículo, resultado de aseguradora, ids y versiones de órdenes vinculadas) y llama al puerto `IncidentClosureCosts` para que INC-COSTS guarde su snapshot en la misma transacción. Reabrir nunca modifica ni borra filas de cierre.
7. Decisión de vehículo (D11, SPECS §5.3): `vehicleStatusDecision` se registra y nunca se aplica sola. `active` se rechaza (422 `vehicle_blocked`) si hay otra causa abierta: órdenes de taller abiertas del vehículo o otro siniestro no terminal con `vehicleOperable = false`. Con `totalLoss = true` la vista propone `decommissioned`. Aplicar el estado es un comando explícito del módulo de vehículos.
8. PR 2 también cierra el hueco inverso: añade a `WorkOrderReferences` un puerto opcional de bloqueos del vehículo y lo usa en el cierre de una orden con decisión `active`. Sin el puerto, el comportamiento actual no cambia; la composición lo conecta a los siniestros abiertos no operables.
9. Puertos hacia INC-COSTS: `IncidentRepairs` (órdenes vinculadas con estado, versión y si tienen costos), `IncidentCostPresence`, `IncidentCostTotals` (`companyBorne` por moneda) e `IncidentClosureCosts`. Sin implementación, la composición conecta una variante que falla cerrado: `repair_order_or_budget`, `repair_orders_finished` y `no_repairs` quedan como faltantes, aunque haya presupuesto; `no_costs` también; con umbral D20, `IncidentCostTotals` exige aprobación. Así nadie llega a `repair`, ni cancela, ni cierra sin aprobación sin INC-COSTS.
10. Alcance de mecánico y errores de permisos fallan cerrado, como en INC-CASES.
11. Fechas de calendario (`insurerReportedOn`, decisiones por día) en la zona IANA del tenant.
12. En `repair`, retirar la última orden vinculada o desvincular la última evidencia `budget` `clean` cuando no queda la otra da 422 `repair_order_or_budget`. Este paquete añade esa comprobación al desvínculo de evidencia de INC-CASES; INC-COSTS la aplica al desvínculo de órdenes.

## Configuración

Campo nuevo en la configuración de empresa: `incidentReportPhoto` (`photo_or_justification` por defecto, `photo_required`). Con `photo_or_justification`, `report` acepta una foto `clean` o `noPhotoJustification` no vacía; con `photo_required`, exige foto `clean`. Migración expand en `packages/persistence/settings`, contrato opcional en `bff/alerts.ts` (el contrato de configuración actual) y ruta existente.

## Persistencia

`packages/persistence/incidents/workflow`: tabla `opslog_incident_closures` (PK `(company_id, incident_id, cycle)`, grants SELECT e INSERT). Las columnas del incidente ya existen desde INC-CASES. Se reutilizan `opslog_incident_transitions` e `opslog_incident_idempotency`. Migración versionada en su propia tabla de migraciones, paso ordenado después de casos en `incident-source.ts` y grants añadidos en los arneses.

## Eventos

Allowlist exacta: `incident.status_changed {incidentId, vehicleId, version, status}`, `incident.assigned {incidentId, version}`, `incident.closed {incidentId, vehicleId, version}`, `incident.reopened {incidentId, version, cycle}`, `incident.cancelled {incidentId, version}`. Son los eventos de webhook de SPECS §7; la entrega externa es de MVP-WEBHOOKS. Nada de motivos, nombres, montos ni texto libre. El timeline guarda comentario y motivo; esos textos solo los ve quien puede ver el incidente.

## Pruebas de aceptación

1. **Tabla exhaustiva.** Para cada uno de los 11 estados × 14 comandos, los pares permitidos con requisitos completos pasan y todos los demás dan 409 sin efectos. Prueba generada desde la tabla, con mutación dirigida sobre el mapa de transiciones.
2. **Matriz de permisos.** Para cada comando, un actor sin el permiso recibe 403 en un incidente visible; un actor con `incidents:report` solo reporta o cancela su propio borrador; US-032: un actor con solo `incidents:view` recibe `next-steps` vacío en `reported`; un editor de flota con `view` y `edit` genéricos e `incidents:view` recibe 403 en todos los comandos (ADR-0014). En MySQL, el responsable debe tener `incidents:edit`: asignar un miembro con solo `edit` genérico da 422.
3. **Faltantes US-032.** Given `under_review` sin número de reporte, aseguradora ni fecha, When `insure`, Then 422 con `claim_number`, `insurer`, `insurer_reported_on` y sin cambios.
4. **Foto o justificación.** Con `photo_or_justification`: foto `pending_scan` sin justificación falla; justificación sola pasa. Con `photo_required`: justificación sola falla; foto `clean` pasa.
5. **Orden o presupuesto (ADR-0014).** Con un puerto de prueba de reparaciones: `repair` con solo una orden correctiva vinculada pasa; con solo un presupuesto `clean` pasa; con presupuesto en `pending_scan` y sin orden da 422 `repair_order_or_budget`; sin INC-COSTS conectado, `repair` falla cerrado aunque haya presupuesto. En `repair` sin órdenes, desvincular el único presupuesto da 422.
6. **Ruta por tipo.** `traffic_violation` va `reported → under_review → resolved → closed`; `collision` desde `under_review` no puede ir a `repair` ni a `resolved` sin `insure` o `no_insurance`; `theft_total` nunca entra a `repair`.
7. **Rechazo y apelación (US-033).** `insurance_process → insurance_rejected` exige motivo y carta `clean`; `appeal` vuelve a `insurance_process` y borra la aprobación de asunción; asumir sin `costAssumed` falla.
8. **D20 por monto (ADR-0014).** Umbral 5.000,00 MXN. Con `companyBorne` 4.999,99 MXN, `close` pasa sin aprobación y `next-steps` no lista `close_approval`; con 5.000,00 exactos, también pasa; con 5.000,01, `close` sin aprobación da 422 `close_approval` y pasa tras `approve_close`. Con 100,00 USD a cargo de la empresa y umbral en MXN, se exige aprobación aunque el total en MXN sea menor. Recuperaciones que bajan `companyBorne` por debajo del umbral eliminan la exigencia. La asunción tras rechazo sigue la misma tabla con `assumption_approval`; asumir por debajo del umbral y cerrar con costos que ya lo superan exige `close_approval`. `approve_close` con `approve` genérico pero sin `incidents:approve` da 403; editar la resolución tras aprobar obliga a aprobar de nuevo. Sin umbral, no se pide aprobación. Configuración o totales ilegibles: 500 sin cierre. Sin INC-COSTS conectado y con umbral, se exige aprobación.
9. **Idempotencia.** Dos `close` concurrentes con la misma clave: un cierre, una fila de cierre, un evento y la misma respuesta; misma clave con otro cuerpo: 409; `close` sin clave: 400; la respuesta repetida a un actor sin `incidents:view_costs` no lleva importes.
10. **Versión.** Dos comandos con la misma versión: uno gana, el otro 409 `stale_version` sin timeline ni outbox.
11. **Cerrado inmutable.** En `closed`: `PATCH`, terceros, evidencia, datos de aseguradora, resolución y comandos distintos de `reopen` dan 409. Reabrir sin `incidents:reopen` da 403; sin motivo, 422.
12. **Reapertura.** Cerrar, reabrir, volver a resolver y cerrar deja dos filas de cierre (ciclos 1 y 2) con su snapshot intacto, `reopenCount = 1` y timeline completo.
13. **Cancelación.** Con un puerto de prueba que informa una orden vinculada o un costo, `cancel` da 422 `no_repairs` o `no_costs`; sin ellos, cancela con motivo. Sin INC-COSTS conectado, `cancel` desde `under_review` falla cerrado.
14. **Bloqueos del vehículo.** Dos siniestros no operables del mismo vehículo: resolver uno con `active` da 422 `vehicle_blocked`; con una orden de taller abierta, igual. PR 2: cerrar una orden con `active` y un siniestro no operable abierto también da 422; sin puerto conectado, el cierre de órdenes sigue como en M3.
15. **Tenant A/B en MySQL.** Comandos, `next-steps`, datos de proceso y responsable de B desde A dan 404 uniforme y no escriben; asignar un miembro de B como responsable falla como desconocido.
16. **Atomicidad.** Fallo inyectado en audit, outbox o en el snapshot de costos durante `close`: no cambia estado, no hay fila de cierre ni evento.

## Decisiones por defecto

- `repair → resolved` exige evidencia final (`post_repair` o factura `clean`) siempre, porque SPECS §6.2 no la condiciona a configuración.
- `close` exige además `incidents:view_costs` (quien cierra valida costos, como `view_costs` en el cierre de órdenes) y órdenes vinculadas en `closed`, no solo `completed`, porque el cierre es administrativo y financiero.
- `close` exige que no haya evidencia en `pending_scan`.
- Responsable: miembro activo con `incidents:view` e `incidents:edit`.
- Datos del ajustador visibles con `incidents:view` (contacto profesional de la aseguradora).
- Sin regla de inactividad aquí (INC-SLA); sin sub-estado "esperando a" ni override.

## Decisiones del propietario (ADR-0014)

- D20 compara el costo a cargo de la empresa con el umbral: aprobación solo si lo supera (estrictamente), o si hay costo en otra moneda. Ver invariante 3. BR-028 y US-051 quedan cubiertos así.
- Permisos propios de siniestros; los verbos genéricos no habilitan comandos.
- `repair` exige orden correctiva vinculada o presupuesto `clean`, no ambos, desde todos los orígenes. La fila `insurance_process → repair` de SPECS §6.2 dice "orden correctiva y presupuesto"; ADR-0014 registra que el propietario adoptó "una de las dos" también ahí.
- Alinear D20 por monto en el cierre de órdenes de mantenimiento es una tarea de seguimiento separada, no de este paquete.

## Tamaño y división

**PR 1**: tabla, requisitos, `next-steps`, `assign`, datos de aseguradora, `report` a `resolve`, `reject`, `appeal`, `cancel`, idempotencia, bloqueo de terminales y campo de configuración (casos 1 a 7, 10, 11 parcial, 13, 15). **PR 2**: aprobaciones D20, `close` con snapshot, `reopen` con ciclo, decisión de vehículo y puerto inverso en órdenes (casos 8, 9, 11, 12, 14, 16). Estimado: PR 1 unas 2.200 líneas; PR 2 unas 1.600.

## Fuera de alcance

Costos, vínculos de órdenes y consolidación (INC-COSTS), SLA, alertas y aviso in-app de asignación (INC-SLA), pantallas (INC-UI), editor de workflow por tipo (FR-124, fase 1.5), override (D16), avisos y correo (INC-SLA, ADR-0014), alineación de D20 por monto en mantenimiento (tarea de seguimiento de ADR-0014), webhooks (MVP-WEBHOOKS) y cambio automático del estado del vehículo (D11).

## Comandos y evidencia

```text
pnpm quality
pnpm test:integration
pnpm exec prettier --check docs/tasks/INC-WORKFLOW-M4-20261013.md
git diff --check
```

Registrar SHA, versión de MySQL, salida de comandos, resultado de la mutación dirigida sobre la tabla y la matriz de trazabilidad para INC-INTEGRATE. PR listo, CI verde y la única auditoría independiente por PR/SHA (ADR-0007, ADR-0011). El autor no fusiona ni declara G4.
