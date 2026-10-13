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
status: paquete preparado; espera todas las entregas de M4
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
