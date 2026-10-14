# INC-INTEGRATE-M4-20261013: integración real de siniestros para G4

```yaml
id: INC-INTEGRATE-M4-20261013
baseline: [SPEC-1.4, ORCH-1.4, inherited: SPEC/ORCH 1.0-1.3 not superseded]
active_provider: anthropic
model: pin de código vigente según ADR-0007, sin fallback
milestone: M4
kind: integration
wave: 4 (último paquete de M4)
base_sha: el SHA de main con INC-UI PR 2 fusionado (registrarlo al asignar)
accepted_dependencies:
  [
    INC-CASES-M4-20261013 (PR 1 y PR 2),
    INC-WORKFLOW-M4-20261013 (PR 1 y PR 2),
    INC-COSTS-M4-20261013,
    INC-SLA-M4-20261013,
    INC-UI-M4-20261013 (PR 1 y PR 2),
  ]
write_paths:
  - apps/api/composition/**
  - apps/worker/composition/**
  - apps/web/app/** (solo cableado: enlace de la ficha de vehículo al listado filtrado de siniestros)
  - apps/web/vehicles/** (solo el enlace "Siniestros" de la ficha)
  - tests/integration/incidents/**
  - tests/e2e/incidents/**
  - e2e/incidents-journeys.spec.ts (nuevo)
  - e2e/real-api/**
  - tests/e2e/fleet/mysql.ts (solo si falta algún grant o paso de migración de siniestros)
  - docs/traceability/incidents.md (nuevo)
  - package.json, tsconfig.json, pnpm-lock.yaml (cableado de suites)
  - docs/tasks/INC-INTEGRATE-M4-20261013.md
forbidden_paths:
  - SPECS.md, Orchestrator.md, docs/baselines/**, Tasks.md, .env*, AWS, producción
  - reglas de negocio en packages/domain/** (si falta una regla, se registra como pendiente)
status: implementado en `wip/inc-integrate` sobre `642a947`; listo para PR y para la única auditoría independiente por SHA (ver «Estado y evidencia»)
```

## Objetivo y límites

Componer las entregas de M4 en el producto y producir la evidencia acumulativa que G4 exige: un siniestro de principio a fin por API real sobre MySQL 8.4 sintético y por navegador, sin regresión de M0 a M3. `Orchestrator.md` asigna a este paquete la composición y el registro, `tests/integration/incidents/**` y `tests/e2e/incidents/**`.

No se crean reglas de negocio nuevas. Si una brecha bloquea un escenario, se documenta como pendiente con su condición de desbloqueo y se pide un `FIX` al coordinador; no se inventa comportamiento. Este paquete no declara G4 aprobado ni inicia M5. La preparación de la auditoría G4 es un documento aparte, como `G3-AUDIT-20261012.md`.

Orden de M4 y dueños de archivos compartidos: ver `INC-CASES-M4-20261013.md`. En la ola 4 este paquete es el único dueño de los archivos compartidos.

## Alcance

1. **Cableado pendiente.** Registrar en `apps/worker/composition` los handlers de `apps/worker/incident-sla`, el consumo de `incident.assigned` y el envío de correo de `incident.sla_alert` con el sumidero de prueba (ADR-0014); dejar el disparo periódico de `incident.sla.scan` conectado al mecanismo local disponible y documentar que el disparador en la nube y el envío real de correo siguen diferidos (ADR-0002). Añadir en la ficha de vehículo un enlace "Siniestros" al listado filtrado por ese vehículo.
2. **Mundo de pruebas.** `tests/e2e/incidents/world.ts` sobre el arnés de flota con tenants A y B, cuenta runtime de siniestros con exactamente los grants declarados por cada paquete, roles sintéticos con los permisos propios de ADR-0014 (responsable de casos con `incidents:view` e `incidents:edit`, reportero con `incidents:view` e `incidents:report`, supervisor con `incidents:approve`, cerrador con `incidents:close` e `incidents:view_costs`, consulta con `incidents:view`, editor de flota con `view`, `create` y `edit` genéricos e `incidents:view`) y reloj determinista.
3. **Journeys por API sobre MySQL** (`tests/e2e/incidents/*.integration.test.ts`), los cinco de `Orchestrator.md`:
   - **Aceptado.** Borrador → reportado → revisión → proceso con aseguradora → resultado aceptado → orden correctiva creada y vinculada → reparación → orden cerrada → resuelto con evidencia final → cierre con snapshot de costos.
   - **Rechazado, apelado y asumido.** Proceso → rechazado con carta → apelación → rechazado otra vez → asunción con costo por encima del umbral y aprobación D20 → reparación → resuelto → cerrado con aprobación de cierre; la misma ruta con costo igual al umbral cierra sin aprobación.
   - **Sin seguro.** Revisión → `no_insurance` con motivo → asunción → reparación con solo presupuesto `clean` y costo como línea propia → resuelto → cerrado; el texto nunca afirma falta legal de cobertura.
   - **Pérdida total.** `theft_total` → proceso → resuelto sin reparación con `totalLoss` → propuesta `decommissioned` aplicada solo con el comando explícito de vehículos → cerrado; ningún camino lleva a `repair`.
   - **Reapertura.** Caso cerrado → reabierto con motivo → evidencia nueva → reparación adicional → resuelto → cerrado; dos snapshots de cierre y dos ciclos de SLA con métricas separadas.
4. **Matriz de aislamiento** (`tests/integration/incidents/**`, SPECS §4.4): con ids locales iguales en A y B, lectura, escritura, comandos, terceros, evidencia y descarga, costos, vínculos de órdenes, avisos SLA, correos del sumidero, jobs y reintentos, idempotencia (misma clave en A y B no colisiona), outbox y audit. Incluye headers manipulados, tenant suspendido, sesión revocada y cambio de permisos con un job de SLA pendiente.
5. **Journey de navegador** (`e2e/incidents-journeys.spec.ts`) sobre `e2e/real-api`: asistente móvil a 360 px con foto, reporte, revisión, rechazo, apelación, reparación con orden creada desde la ficha, cierre con aprobación y reapertura; un rol sin `incidents:view_costs` ni `view_pii` recorre la misma ficha sin ver importes ni identidad de terceros.
6. **Trazabilidad consolidada.** `docs/traceability/incidents.md` con la cadena requisito → contrato → implementación → prueba → evidencia por SHA para FR-110 a FR-125, BR-I1 a BR-I7, BR-005, BR-006, BR-016 a BR-020, BR-024, BR-027, BR-028, US-021, US-030 a US-035, US-051, D4, D8, D10, D11, D15, D16, D17, D18, D20, D23 y ADR-0014. Conservar las etiquetas de fuente (`CONFIRMED`, `PROPOSED`, `DECISION REQUIRED`) y marcar como diferidos, sin contarlos como implementados, FR-124, FR-125, el envío real de correo (el sumidero de prueba sí cuenta como implementado) y las vistas guardadas.
7. **Regresión acumulativa.** En el SHA candidato pasan `pnpm quality`, `pnpm test:integration`, `pnpm test:fleet-integration`, `pnpm test:e2e` y `pnpm test:visual`, sin escenarios MySQL omitidos. Añadir `tests/e2e/incidents` a `test:fleet-integration` y `test:platform`.

## Aceptación Given / When / Then

1. Given una sesión con `incidents:view`, When abre "Siniestros" desde Operación, Then ve lista, asistente y ficha con datos del contrato y estados compartidos; un miembro con alcance de mecánico no ve la entrada ni accede por URL; el editor de flota con `edit` genérico ve los casos pero no los gestiona (403 en API, sin acciones en navegador).
2. Given el arnés de API real con MySQL 8.4 y tenants A/B, When corren los cinco journeys, Then cada paso persiste, cada transición deja timeline, audit y un evento de la allowlist, y los totales de costos por moneda coinciden con la suma exacta de órdenes y líneas sin doble conteo.
3. Given la reapertura, Then el ciclo 1 conserva su snapshot de cierre y su resultado de SLA, y el ciclo 2 se mide desde la reapertura.
4. Given la matriz de aislamiento, Then ningún dato, conteo, aviso, archivo o error de B aparece en A, y al revés.
5. Given un rol sin `incidents:view_costs` y sin `view_pii`, When recorre API y navegador, Then ninguna respuesta, DOM, árbol accesible, timeline, error, audit ni outbox contiene importes o identidad de terceros.
6. Given dos cierres concurrentes con la misma `Idempotency-Key`, Then un cierre, un snapshot, un evento y la misma respuesta; con claves distintas, uno gana y el otro recibe 409.
7. Given un vehículo con dos siniestros no operables y una orden de taller abierta, When se resuelve uno con decisión `active` o se cierra la orden con `active`, Then ambos se rechazan mientras quede otra causa abierta.
8. Given un aviso SLA y el worker compuesto con el sumidero de prueba, Then el sumidero recibe un correo por destinatario autorizado, sin importes ni PII, y repetir el scan no envía otro.
9. Given el SHA candidato, When corren los comandos de regresión, Then todos pasan sin omisiones y se registra la versión exacta de MySQL de cada corrida.
10. Given pendientes declarados (envío real de correo, disparador periódico en la nube, alineación de D20 por monto en mantenimiento), When se publica la trazabilidad, Then siguen marcados pendientes con su condición de desbloqueo y no como aprobados.

## Decisiones por defecto

- Los cinco journeys de `Orchestrator.md` se ejecutan por API y el de navegador cubre el recorrido más largo más el rol restringido; los otros cuatro por navegador no son obligatorios.
- El enlace desde la ficha de vehículo al listado filtrado cubre la pestaña "Siniestros" de S11 en M4; el historial unificado del vehículo (FR-077) sigue en su paquete de flota.

## Tamaño

Un PR de unas 2.000 líneas, casi todas pruebas y trazabilidad. Si el journey de navegador o la matriz de aislamiento lo hacen crecer, separar cableado y journeys por API (PR 1) de navegador y trazabilidad (PR 2).

## Fuera de alcance

Reglas nuevas, cambios de contrato, M5 (reportes, dashboard, búsqueda, correo general de MVP-NOTIFY, webhooks), auditoría G4 y su declaración, y AWS.

## Comandos y evidencia

```text
pnpm quality
pnpm test:integration
pnpm test:fleet-integration
pnpm test:e2e
pnpm test:visual
pnpm exec prettier --check docs/tasks/INC-INTEGRATE-M4-20261013.md docs/traceability/incidents.md
git diff --check
```

PR listo, CI verde y la única auditoría independiente por PR/SHA (ADR-0007, ADR-0011). Cada cambio de código invalida la auditoría anterior. La evidencia registra SHA, comando, resultado, versión de MySQL y reporte de Playwright.

## Estado y evidencia

Base: `origin/main` en `642a947`. SHA final, comandos y resultados: ver la sección «Corridas» al final de este documento.

### Qué se entregó

- **Cableado.** Los handlers de `apps/worker/incident-sla`, `incident.assigned` y el sumidero de correo de prueba ya estaban registrados por INC-SLA mediante `registerIncidentSlaHandlers` en `apps/api/composition/src/platform/runtime.ts`; este paquete añade lo que faltaba: el disparo periódico. `apps/worker/composition/src/periodic.ts` define `PeriodicScheduler`: un temporizador (`unref`) por trabajo, que recorre los tenants activos, aísla el fallo de un tenant, no solapa pasadas y exige un intervalo mínimo de 1 s. La composición registra `incident.sla.scan` (`INCIDENT_SLA_SCAN_JOB`) cada 15 min (`worker.slaScanIntervalMs`) y encola con `incidentSla.enqueueScan`. Prueba: `tests/integration/platform/periodic.test.ts`. El código movido a `periodic.ts` y `runtime.ts` deja `platform.ts` sin líneas nuevas (límite de 400).
- **Pendiente del anfitrión.** El repositorio no tiene un `main` de servidor: quien levante el proceso debe llamar `platform.runtime.periodic.start()` y `stop()`. El disparador periódico en la nube y el envío real de correo siguen diferidos (ADR-0002). Hallazgo: los escaneos de planes de mantenimiento tampoco tienen planificador en el anfitrión (solo los encolan las fixtures de prueba); queda fuera de este paquete y se registra para el coordinador.
- **Ficha de vehículo.** Enlace «Siniestros del vehículo» (visible con `incidents:view`) a `/incidents?vehicleId=<id>`; la lista aplica el filtro, lo muestra en un aviso con «Ver todos los siniestros» y los filtros rápidos lo conservan.
- **Mundo de pruebas** (`tests/e2e/incidents/world.ts`, `steps.ts`): arnés de flota con tenants A y B, cuenta runtime de siniestros con los grants exactos de `tests/e2e/fleet/mysql.ts` (sin cambios: ya cubrían las tablas de siniestros), roles sintéticos `incident_supervisor` (`incidents:approve`, `close`, `reopen`, `view_costs`) e `incident_reporter` (`incidents:create`, `report`), registrados solo mientras corre la suite, y reloj determinista (`advance` mueve el reloj y renueva las sesiones).
- **Journeys por API sobre MySQL 8.4:** aceptado, rechazado/apelado/asumido (D20 igual y un centavo por encima), sin seguro (orden creada con `Idempotency-Key`), pérdida total (`theft_total`) y reapertura. **Matriz A/B:** 19 rutas contra un caso inexistente, listas, filtros, sugerencias, vínculo de orden ajena, filas de B y grants de la cuenta de A. **Navegador:** `e2e/incidents-journeys.spec.ts` a 360 px.
- **Trazabilidad:** `docs/traceability/incidents.md`.
- **Regresión:** `tests/e2e/incidents` y `tests/integration/incidents` en `test:fleet-integration` y `test:platform`; `tests/e2e/incidents` y el documento de trazabilidad en `format:check`.

### Correcciones consolidadas de las revisiones

| Origen       | Hallazgo                                                           | Resultado                                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G4 (umbral)  | `closeCostThreshold` visible en `GET /alerts/settings` sin permiso | Corregido: se omite el campo (no `null`) sin `incidents:view_costs`; una escritura que no lo envía conserva el valor guardado. La web oculta los campos y no los envía. Prueba en `alerts.test.ts` y en acceptance 7 |
| MNT/INC-UI   | `POST work-orders` sin `Idempotency-Key`                           | Corregido: cabecera opcional (hash de carga, conflicto 409, repetición devuelve la misma orden, carrera resuelta); `CreateOrderForm` la usa y `RepairTab` conserva la orden creada al cerrar y reabrir el diálogo    |
| INC-SLA      | Disparo periódico del escaneo                                      | Corregido: ver «Cableado»                                                                                                                                                                                            |
| INC-CASES    | Tamaño de las columnas selladas                                    | Corregido: migración `2026101500030` ensancha a 2048; prueba con clave larga y 200 caracteres de 3 bytes                                                                                                             |
| INC-CASES    | Auditoría de descarga sin id de evidencia                          | Corregido: `entityType` `incident_evidence` con `incidentId.evidenceId`                                                                                                                                              |
| INC-CASES    | Topes de hijos fuera de la transacción                             | Corregido: el conteo se hace dentro de la transacción (20 terceros vivos, 50 evidencias)                                                                                                                             |
| INC-COSTS    | Deducible: `GET costs` daba 500 si fallaba la consulta             | Corregido: `policyDeductible: null` y `policyDeductibleUnavailable: true`; los totales no cambian; la web lo explica                                                                                                 |
| INC-WORKFLOW | `next-steps` listaba `approve_*` sin necesidad                     | Corregido: solo se listan si el monto lo exige y falta la aprobación o quedó vencida (`approvalIsDue`)                                                                                                               |
| INC-UI       | `setIncident(null)` del asistente                                  | Corregido: el borrador sale de `useLive`; sin estado local                                                                                                                                                           |
| INC-UI       | Huella de `useUploadQueue` incluía `version`                       | Corregido: la huella no incluye la versión; la versión se fija por trabajo y se renueva solo tras un resultado definitivo                                                                                            |
| INC-UI       | PNG transparente salía negro como JPEG                             | Corregido: con transparencia se emite PNG                                                                                                                                                                            |
| INC-UI       | Descarga de evidencia con 401                                      | Corregido: vence la sesión (`onExpired`)                                                                                                                                                                             |
| INC-UI       | Etiquetas de cobertura de `InsuranceTab`                           | Verificado, sin cambio: usa `coverageLabel` del módulo de seguros                                                                                                                                                    |

### Diferido, con su razón (para el auditor G4)

| Origen         | Hallazgo                                                                                                  | Razón                                                                                                                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INC-CASES      | Filtro de estado del `PATCH`; nombres de campo del audit                                                  | Decisiones documentadas: el sanitizador del audit es un diseño de plataforma compartido y los nombres de campo viven en el timeline. Cambiarlos toca contratos de otros paquetes                                                               |
| INC-COSTS      | Lecturas de órdenes no serializables durante el cierre; verificaciones de vínculo fuera de la transacción | El estado de la orden pertenece a otro módulo y no puede entrar en la transacción del caso. Se vuelve a leer al decidir; el peor caso es un rechazo o una aceptación sobre una orden que cambió un instante antes                              |
| INC-COSTS      | `PUT costs` puede dar 500 tras confirmar                                                                  | El disparador principal (el deducible) quedó corregido. Un fallo de lectura de la orden sigue siendo 500 por diseño («nunca un cero»); reintentar con la misma clave repite la respuesta                                                       |
| INC-COSTS      | Un `PUT` sin cambios no registra su clave                                                                 | Registrarla exigiría una escritura sin subir la versión. Un `PUT` sin cambios es inocuo; reintentar tras otros cambios da 409 `stale_version`                                                                                                  |
| INC-COSTS      | Validación ISO 4217                                                                                       | La forma `[A-Z]{3}` se valida igual en cuatro módulos (ajustes, seguros, órdenes y costos). Una lista cerrada debe compartirse y tiene otro dueño                                                                                              |
| INC-SLA L1     | `void kernel.outbox.transaction`                                                                          | Se intentó una verificación de arranque que exige el outbox en memoria con el almacén SLA en memoria; rompía suites que combinan outbox MySQL con otros módulos y se revirtió. Sin riesgo de producción: el adaptador persistente lo sustituye |
| INC-SLA L4     | Capacidad                                                                                                 | Nota: un escaneo de 500 incidentes tarda unos 16,5 s sobre MySQL; el presupuesto de SPECS §9.3 es de 15 min por tenant. Si crece, paginar más pequeño o escanear por caso                                                                      |
| ADR-0014 §1    | D20 por monto en órdenes de mantenimiento                                                                 | Sigue **pendiente** (aceptación 10): hoy mantenimiento pide aprobación en todo cierre si hay umbral. Se desbloquea con un FIX de mantenimiento; no se implementa aquí                                                                          |
| ADR-0002       | Disparador periódico en la nube y envío real de correo                                                    | Diferidos; el sumidero de prueba cuenta como implementado                                                                                                                                                                                      |
| FR-124, FR-125 | Configuración por tipo; tareas dentro del caso                                                            | Prioridad S, diferidos; vistas guardadas también                                                                                                                                                                                               |

### Alcance de los journeys frente al texto del paquete

Ver «Brechas contra el texto del paquete» en `docs/traceability/incidents.md`. En resumen: el paso a `repair` con órdenes terminadas ya está probado en INC-COSTS y en `incidents-real.spec.ts`; los journeys de esta ola lo evitan para no depender del ciclo de vida de la orden de taller.

### Corridas

MySQL 8.4.11 sintético (contenedor local). Playwright con `--workers=1`.

| Comando                                                         | Resultado                                               |
| --------------------------------------------------------------- | ------------------------------------------------------- |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check`              | verdes                                                  |
| `pnpm test:unit`                                                | verde (web 1289 pruebas)                                |
| `pnpm test:integration` (incluye `test:platform` con cobertura) | verde; `periodic.ts` 100 % de líneas, ramas y funciones |
| `pnpm leak:scan`, `pnpm baseline:check`                         | verdes                                                  |
| `e2e/incidents-real.spec.ts`                                    | 15 de 15, dos corridas seguidas                         |
| `e2e/incidents-journeys.spec.ts`                                | 3 de 3, dos corridas seguidas                           |

Hallazgo del journey de navegador: vincular una orden borra la aprobación de asunción y una orden abierta bloquea el cierre (`repair_orders_closed`); por eso el journey crea la orden desde la ficha tras la reapertura. No se ejecutaron `pnpm test:e2e` completo ni `pnpm test:visual`. El SHA queda registrado en el commit que contiene esta sección y en el informe de entrega.
