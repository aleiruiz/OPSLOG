# MVP-INTEGRATE-M5-20261019: composición final del MVP, despliegue en la demo y candidato para G5

```yaml
id: MVP-INTEGRATE-M5-20261019
baseline: [SPEC-1.4, ORCH-1.4, inherited: SPEC/ORCH 1.0-1.3 not superseded]
active_provider: anthropic
model: pin de código vigente según ADR-0007, sin fallback
milestone: M5
kind: integration
wave: 4 (último paquete de M5; único dueño de los archivos compartidos)
base_sha: el SHA de main con las olas 1 a 3 fusionadas (registrarlo al asignar)
accepted_dependencies:
  [
    MVP-AUDIT-UI-M5-20261019,
    MVP-SEARCH-M5-20261019 (PR 1 y PR 2),
    MVP-ANALYTICS-M5-20261019 (PR 1 y PR 2),
    MVP-REPORTS-M5-20261019 (PR 1 y PR 2),
    MVP-NOTIFY-M5-20261019,
    MVP-WEBHOOKS-M5-20261019,
    MVP-OPS-M5-20261019 (PR 1 y PR 2),
    MVP-QA-M5-20261019 (etapa 1),
    FIX-G4-L1-L2 (hilo aparte; debe estar fusionado),
  ]
requirements: [Orchestrator §M5 MVP-INTEGRATE, SPECS §9.2, SPECS §10 (M5), SPECS §10.1, ADR-0016]
write_paths:
  - apps/api/composition/**
  - apps/worker/composition/**
  - apps/api/server/**
  - apps/web/app/** (solo cableado)
  - fichas de vehículo, conductor, siniestro y orden en apps/web/** (solo montar la pestaña «Historial» de MVP-AUDIT-UI, el botón «Seguir» de MVP-NOTIFY y los enlaces a reportes y fichas PDF)
  - apps/web/features/audit/** (solo el enlace «Exportar» al reporte audit_log)
  - tests/integration/mvp/** y tests/e2e/mvp/** (nuevos)
  - e2e/mvp-journeys.spec.ts (nuevo) y e2e/real-api/**
  - tests/e2e/fleet/mysql.ts (solo grants o migraciones que falten)
  - docker-compose.yml, deploy/** (solo lo que falte para la demo)
  - docs/release/MVP-manifest.md (nuevo)
  - docs/operations/DEPLOY_COOLIFY.md (actualización de variables y limitaciones)
  - package.json, tsconfig.json, pnpm-lock.yaml (cableado de suites)
  - docs/tasks/MVP-INTEGRATE-M5-20261019.md
forbidden_paths:
  - SPECS.md, Orchestrator.md, docs/baselines/**, Tasks.md, .env*, AWS nuevo, producción y datos reales
  - reglas de negocio en packages/domain/** (una brecha se registra y se pide un FIX)
status: in_progress (PR 1 fusionado: cableado web, worker y journeys por API; PR 2: aislamiento, navegador, manifiesto y variables de despliegue; demo y regresión final pendientes)
```

## Objetivo y límites

Conectar los módulos de M5 en el producto, desplegar el candidato en la demo de Coolify con datos sintéticos y congelar artefactos y evidencia para G5. Sin reglas nuevas: si una brecha bloquea un escenario, se documenta con su condición de desbloqueo y se pide un `FIX` al coordinador. Este paquete no declara G5 aprobado; la preparación de G5 (`G5-AUDIT`) es un documento aparte. Orden y dueños: ADR-0016 §1; en la ola 4 este paquete es el único dueño de los archivos compartidos.

## Alcance

1. **Cableado web.** Pestaña «Historial» en las fichas; botón «Seguir» en vehículo y siniestro; enlaces de ficha a sus PDF y a reportes filtrados; «Exportar» de S26 al reporte `audit_log`; navegación «Análisis» completa (Dashboard en Inicio, Reportes, Auditoría) y campana de notificaciones.
2. **Worker compuesto.** Comprobar que el proceso `api` ejecuta en cada tick: outbox, escaneos de archivos, relevo de audit, escaneos periódicos (planes, SLA, vencimientos), proyección de búsqueda, jobs de exportación, notificaciones y webhooks, con el registro de jobs de MVP-REPORTS PR 1; un job que falla no detiene los demás.
3. **Journeys por API sobre MySQL** (`tests/e2e/mvp/*.integration.test.ts`): búsqueda → detalle; dashboard → drill-down; reporte grande → job → notificación «exportación lista» → descarga → revocación; cambio de estado de vehículo → notificación in-app y correo del sumidero → webhook firmado entregado a un receptor local; siniestro → historial de audit con diff restringido.
4. **Matriz de aislamiento consolidada** (`tests/integration/mvp/**`) para las vías nuevas de M5, ejecutando la de MVP-QA en el candidato.
5. **Journey de navegador** (`e2e/mvp-journeys.spec.ts`) sobre `e2e/real-api`: un supervisor recorre dashboard, búsqueda, reporte y notificación; un despachador sin costos ni PII recorre lo mismo sin verlos.
6. **Demo.** Desplegar el candidato en Coolify (staging, datos sintéticos) siguiendo el runbook de MVP-OPS, con respaldo previo; comprobar `/healthz`, `/readyz`, inicio de sesión real con Cognito y un recorrido corto. Actualizar `DEPLOY_COOLIFY.md` con las variables nuevas (`OPSLOG_SMTP_*`, respaldo) y las limitaciones vigentes.
7. **Manifiesto** `docs/release/MVP-manifest.md`: SHA del candidato, digest de las imágenes `api` y `web`, versiones exactas de MySQL y dependencias nuevas, resultados de cada suite, RPO/RTO y p95 medidos, y la lista de pendientes de lanzamiento de ADR-0016.
8. **Regresión.** En el SHA candidato pasan `pnpm quality`, `pnpm test:integration`, `pnpm test:fleet-integration`, `pnpm test:e2e`, `pnpm test:acceptance`, el simulacro y la carga de MVP-OPS, sin escenarios MySQL omitidos. `pnpm test:visual` queda según la decisión del propietario sobre M-1 de G4.

## Aceptación Given / When / Then

1. Given cada pantalla de M5, When se abre desde la navegación con el rol adecuado, Then usa datos del contrato real y no mocks; sin permiso, la entrada no aparece y la URL muestra el estado sin permiso.
2. Given los journeys por API, Then cada paso persiste, deja audit y, donde corresponde, un evento de la allowlist; ningún paso depende de orden de ejecución.
3. Given la matriz de aislamiento, Then ningún dato, conteo, archivo, notificación, entrega o error de B aparece en A, y al revés.
4. Given un rol sin `view_costs`, `incidents:view_costs` ni `view_pii`, Then ninguna respuesta, DOM, archivo exportado, correo del sumidero ni payload de webhook contiene importes o PII.
5. Given la demo desplegada, Then `readyz` está verde, el inicio de sesión con Cognito funciona y un reporte, una notificación y un webhook de prueba funcionan con datos sintéticos.
6. Given el manifiesto, Then cada artefacto congelado tiene digest y cada pendiente de lanzamiento su condición; nada pendiente se presenta como aprobado.

## Tamaño

Un PR de unas 2.000 líneas, casi todas pruebas, cableado y documentación. Si crece, PR 1 (cableado y journeys por API) y PR 2 (navegador, demo y manifiesto).

## Fuera de alcance

Reglas nuevas, cambios de contrato, publicación en producción, recursos AWS nuevos, la auditoría G5 y su declaración.

## Comandos y evidencia

```text
pnpm quality
pnpm test:integration
pnpm test:fleet-integration
pnpm test:e2e
pnpm test:acceptance
pnpm ops:drill
pnpm ops:load
pnpm exec prettier --check docs/tasks/MVP-INTEGRATE-M5-20261019.md docs/release/MVP-manifest.md
git diff --check
```

PR listo, CI verde y la única revisión Opus por PR/SHA. El autor no fusiona ni declara G5.

## Estado y notas

PR 1 (cableado y journeys por API):

- **Cableado web (alcance 1).** `Historial de auditoría` (`EntityAuditTab`) en vehículo, conductor y orden de trabajo como sección bajo la ficha, y como pestaña «Historial» en el siniestro; solo con `view_audit` (sin permiso no se pide nada ni aparece la pestaña). «Seguir» en vehículo y siniestro. Enlaces a la ficha PDF (`vehicle_sheet`, `driver_sheet`, `incident_sheet`) y al reporte `vehicle_history`, solo con `export` (igual que la entrada «Reportes»); `ReportsScreen` abre el reporte con los filtros que lleva la dirección. «Exportar» de Auditoría abre `audit_log` con el periodo, tipo y resultado elegidos. Dashboard en Inicio, búsqueda y campana ya estaban montados.
- **Worker compuesto (alcance 2).** `tests/integration/platform/worker-tick.test.ts` fija el orden de los jobs del tick del proceso `api` (outbox, escaneos, relevo de audit, exportaciones, notificaciones, webhooks) y que un job que falla, aun a mitad del tick, no detiene a los demás. Planes, SLA y proyección de búsqueda corren como jobs periódicos que encolan en el outbox; su registro con MySQL lo cubren `periodic.test.ts` y los journeys.
- **Journeys por API (alcance 3).** `tests/e2e/mvp/*.integration.test.ts` sobre dos bases MySQL y HTTP: búsqueda → detalle, dashboard → drill-down, reporte grande → job → notificación → descarga → revocación, estado de vehículo → notificación y correo del sumidero → webhook firmado en un receptor local, siniestro → historial de audit sin texto libre ni importes. Entran en `pnpm test:fleet-integration`.
- **Pendiente para PR 2 y siguientes.** Matriz de aislamiento consolidada (alcance 4), journey de navegador (5), demo, manifiesto y regresión (6 a 8). Las pestañas de vehículo y conductor son secciones, no `DetailTabs`, porque esas fichas no tienen pestañas.

PR 2 (aislamiento, navegador y manifiesto):

- **Matriz de aislamiento (alcance 4).** `tests/integration/mvp/**`, sobre el mundo de `tests/e2e/mvp/world.ts` (reloj de la base de datos, sin dependencia de orden: cada caso crea sus datos con etiqueta única). No repite `tests/acceptance/isolation-m5.test.ts`, que cubre A → B: `isolation-reverse.integration.test.ts` hace el espejo B → A para búsqueda, vistas guardadas, dashboard, reportes y descargas, notificaciones y correo del sumidero, webhooks e historial y consulta de audit, y comprueba por SQL que ninguna tabla nueva de una base tiene filas de la otra empresa. `redaction.integration.test.ts` cubre la aceptación 4 con un despachador sintético (`view`, `export`, `incidents:view`): ni el CSV de conductores, ni el catálogo, ni la búsqueda, ni el aviso, ni el correo del sumidero ni el payload firmado del webhook llevan licencia o importes, mientras que el administrador sí ve la licencia en el mismo archivo.
- **Journey de navegador (alcance 5).** `e2e/mvp-journeys.spec.ts` sobre `e2e/real-api`: supervisor (dashboard con costo, búsqueda, «Seguir», cambio de estado, reporte de conductores con licencia, aviso en la campana), despachador sin costos ni PII (sin indicador de costo, sin licencia en el reporte ni en la búsqueda, sin reportes de costos) y empresa B sin rastro de A. El arnés ganó `driver`, `outOfService` y `tick` (el tick del proceso `api`). Los roles son plantillas sintéticas que viven solo durante el archivo. Hallazgo menor: el avatar del shell falla si un rol no tiene etiqueta en `ROLE_LABELS`; no afecta a los seis roles reales (ver el manifiesto).
- **CI (alcance 8).** `tests/e2e/mvp` y `tests/integration/mvp` entran a `test:platform` (que ya corre `pnpm test:integration` en el job con MySQL 8.4.11); antes `tests/e2e/mvp` solo corría en `test:fleet-integration`, que el CI no ejecuta. El journey de navegador lo recoge `pnpm test:e2e`. `tests/acceptance` pasa al `tsconfig.json` raíz y a `format:check`; no entra al CI por duración.
- **Documentación (alcances 6 y 7).** `DEPLOY_COOLIFY.md` suma `OPSLOG_SMTP_*`, `OPSLOG_READ_ONLY` y las limitaciones vigentes (correo, respaldo, webhooks, reportes grandes, una réplica). `docs/release/MVP-manifest.md` nuevo: SHA del candidato y digest de imágenes **pendientes** (sin Docker aquí), versiones, resultados de CI por job, RPO/RTO y p95 de MVP-OPS con sus condiciones y los pendientes de lanzamiento de ADR-0016. Nada pendiente se presenta como aprobado.
- **Diferido a quien siga.** Despliegue de la demo en Coolify con respaldo previo, `readyz`, Cognito real y recorrido corto (lo hace el propietario; no se tocó Coolify, AWS ni DNS); anotar SHA de fusión y digest en el manifiesto; la regresión del alcance 8 sobre el SHA fusionado (`pnpm quality`, suites, `ops:drill`, `ops:load` y `test:acceptance` a mano).
