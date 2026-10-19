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
status: planned
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
