# Trazabilidad: reportes y exportaciones (MVP-REPORTS PR 1 y PR 2)

| Requisito                                       | Contrato                                               | Implementación                                                          | Prueba                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Motor de reportes, una definición por reporte   | `reports.catalog`, `reports.preview`                   | `packages/domain/reports` (`engine.ts`, `definitions/*`)                | `workforce.test.ts`, `vehicles.test.ts`, `engine.test.ts`                               |
| Columnas sensibles fuera de la consulta         | catálogo y vista previa sin columnas no permitidas     | `permittedColumns`, `planReport`; la fuente no se lee sin permiso       | `engine.test.ts`, `reports.test.ts` (BFF), `tests/integration/platform/reports.test.ts` |
| CSV RFC 4180, BOM y encabezados en español      | n/a                                                    | `packages/platform/exports/src/csv.ts`                                  | `csv.test.ts`                                                                           |
| XLSX en flujo, celdas tipadas, sin fórmulas     | n/a                                                    | `packages/platform/exports/src/xlsx.ts` (ExcelJS `WorkbookWriter`)      | `xlsx.test.ts`                                                                          |
| PDF con empresa, fecha de corte, autor y página | n/a                                                    | `packages/platform/exports/src/pdf.ts` (PDFKit, IBM Plex)               | `pdf.test.ts`                                                                           |
| Neutralización de fórmulas                      | n/a                                                    | `packages/platform/exports/src/formula.ts`                              | `formula.test.ts`, `reports.test.ts` (BFF y plataforma)                                 |
| Directo hasta 5.000 filas, job por encima       | `reports.export`, `exports.get`                        | `ExportService.request` (`packages/domain/exports`)                     | `service.test.ts`, `tests/integration/platform/reports.test.ts`                         |
| Revalidación al iniciar el job                  | `export.failed` con motivo                             | `ExportService.runDue`, `exportAuthority` (`report-apis.ts`)            | `service.test.ts`, `reports.test.ts` (plataforma)                                       |
| Idempotencia y límites de trabajos abiertos     | cabecera `Idempotency-Key`, 409 y 429                  | `ExportJobStore.insert`, `countOpen`                                    | `service.test.ts`, `store.test.ts`, `mysql.integration.test.ts`                         |
| Archivo en `tenants/<id>/exports/<jobId>`, 7 d  | `exports.download` (403, 404, 410)                     | `artifactStore` sobre `ObjectStorage`, área `exports`                   | `storage.test.ts`, `reports.test.ts` (BFF y plataforma)                                 |
| Purga de archivos vencidos                      | n/a                                                    | trabajo `exports.purge` (`apps/worker/composition/src/exports-jobs.ts`) | `worker-jobs.test.ts`, `reports.test.ts` (plataforma)                                   |
| Eventos de outbox y auditoría de cada descarga  | `export.completed {jobId, reportId, format, rowCount}` | `exportEnvelope`, `TypeOrmExportJobStore.transition`                    | `store.test.ts`, `mysql-exports.test.ts`                                                |
| Registro de trabajos del worker                 | n/a                                                    | `JobRegistry`, `createWorkerRuntime`, `startWorkerLoop`                 | `worker-jobs.test.ts`, `server.test.ts`                                                 |
| Aislamiento por empresa                         | 404 en estado y descarga de otra empresa               | toda sentencia filtra `company_id`; rutas de objeto con la empresa      | `reports.test.ts`, `mysql-exports.test.ts`, `mysql.integration.test.ts`                 |
| Pantalla accesible en `/analisis/reportes`      | n/a                                                    | `apps/web/features/reports`                                             | `reports.test.tsx` (axe, 10 ejecuciones seguidas)                                       |
| Rendimiento: 5.000 filas en 10 s                | n/a                                                    | CSV y XLSX en flujo                                                     | `reports.test.ts` de plataforma con `OPSLOG_PERF=1` (CSV 59 ms, XLSX 309 ms)            |

## Matriz por reporte

| Reporte             | Permiso de vista | Columnas sensibles             | Formatos       | Prueba                                 |
| ------------------- | ---------------- | ------------------------------ | -------------- | -------------------------------------- |
| `drivers`           | `view`           | Nº de licencia (`view_pii`)    | CSV, XLSX      | `workforce.test.ts`, `reports.test.ts` |
| `dispatchers`       | `view`           | Teléfono y correo (`view_pii`) | CSV, XLSX      | `workforce.test.ts`, `reports.test.ts` |
| `areas`             | `view`           | n/a                            | CSV, XLSX      | `workforce.test.ts`, `reports.test.ts` |
| `people_compliance` | `view`           | n/a                            | CSV, XLSX, PDF | `workforce.test.ts`, `reports.test.ts` |
| `vehicle_inventory` | `view`           | n/a                            | CSV, XLSX      | `vehicles.test.ts`, `reports.test.ts`  |
| `fleet_status`      | `view`           | n/a                            | CSV, XLSX      | `vehicles.test.ts`, `reports.test.ts`  |
| `insurance`         | `view`           | Deducible (`view_costs`)       | CSV, XLSX      | `vehicles.test.ts`, `reports.test.ts`  |
| `vehicle_documents` | `view`           | n/a                            | CSV, XLSX, PDF | `vehicles.test.ts`, `reports.test.ts`  |

Exportar exige además `export`.

### PR 2: reportes de mantenimiento, siniestros, transversales y fichas

| Reporte                      | Permiso de vista       | Datos protegidos                                               | Formatos  | Prueba                                                                 |
| ---------------------------- | ---------------------- | -------------------------------------------------------------- | --------- | ---------------------------------------------------------------------- |
| `vehicle_history`            | `view`                 | costo de órdenes (`view_costs`), siniestros (`incidents:view`) | CSV, XLSX | `history.test.ts`, `reports-operations.test.ts`                        |
| `maintenance_plan_vs_actual` | `view`                 | n/a                                                            | CSV, XLSX | `maintenance.test.ts`, `sparse.test.ts`                                |
| `maintenance_corrective`     | `view`                 | folio del siniestro (`incidents:view`)                         | CSV, XLSX | `maintenance.test.ts`, `reports-operations.test.ts`                    |
| `maintenance_costs`          | `view_costs`           | importes por moneda                                            | CSV, XLSX | `maintenance.test.ts`, `reports-operations.test.ts` (sin doble conteo) |
| `maintenance_frequency`      | `view`                 | n/a                                                            | CSV, XLSX | `maintenance.test.ts`, `sparse.test.ts`                                |
| `incidents_by_period`        | `incidents:view`       | n/a                                                            | CSV, XLSX | `incidents.test.ts`, `reports-operations.test.ts`                      |
| `incidents_by_subject`       | `incidents:view`       | n/a                                                            | CSV, XLSX | `incidents.test.ts`                                                    |
| `incidents_distribution`     | `incidents:view`       | n/a                                                            | CSV, XLSX | `incidents.test.ts`                                                    |
| `incident_costs`             | `incidents:view_costs` | importes por moneda (reparaciones, gastos, recuperaciones)     | CSV, XLSX | `incidents.test.ts`, `reports-operations.test.ts` (sin doble conteo)   |
| `incident_resolution`        | `incidents:view`       | n/a                                                            | CSV, XLSX | `incidents.test.ts`                                                    |
| `incident_aging`             | `incidents:view`       | n/a                                                            | CSV, XLSX | `incidents.test.ts`, `sparse.test.ts`                                  |
| `expirations`                | `view`                 | n/a                                                            | CSV, XLSX | `transversal.test.ts`                                                  |
| `audit_log`                  | `view_audit`           | cambios enmascarados como la pantalla de auditoría             | CSV, XLSX | `transversal.test.ts`, `reports-operations.test.ts`                    |
| `vehicle_sheet`              | `view`                 | deducible (`view_costs`), siniestros (`incidents:view`)        | PDF       | `sheets.test.ts`, `reports-operations.test.ts`                         |
| `driver_sheet`               | `view`                 | datos personales (`view_pii`)                                  | PDF       | `sheets.test.ts`                                                       |
| `incident_sheet`             | `incidents:view`       | importes (`incidents:view_costs`)                              | PDF       | `sheets.test.ts`                                                       |

Requisito, contrato, implementación y prueba de lo nuevo del PR 2:

| Requisito                                                        | Contrato                                        | Implementación                                                                                                 | Prueba                                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Costos de reparación sin doble conteo (SPECS §5.1, aceptación 7) | `incident_costs`, `maintenance_costs`           | `CostLedger.read` (órdenes vinculadas no canceladas una vez + gastos propios - recuperaciones)                 | `reports-operations.test.ts` (500,00 de la orden y 200,00 propios: 700,00)  |
| Alcance de mecánico (D9) con cierre seguro                       | n/a                                             | `operationalSources` (`report-ops-sources.ts`): vinculado sin `edit` / `incidents:edit` o sin actor lee vacío  | `maintenance.test.ts`, `service.test.ts` (exports), `mysql-reports.test.ts` |
| Filtro obligatorio (fichas, historial)                           | `BffReportFilter.required`, 400 `invalid_input` | `planReport`; la pantalla no carga ni exporta hasta aplicarlo                                                  | `engine.test.ts`, `reports.test.tsx`                                        |
| Vista previa sin recargar el reporte en cada página              | `reports.preview`                               | `ReportEngine.preview` + `PreviewCache` (TTL 30 s, tope de filas; clave por empresa, persona, permisos y plan) | `preview-cache.test.ts`, `apps/api/reports` `index.test.ts`                 |
| Bitácora enmascarada como la pantalla de auditoría               | `audit_log`                                     | `AuditQueryService.list` (misma máscara) en `buildAuditQueryService`                                           | `transversal.test.ts`, `reports-operations.test.ts`                         |
| Aislamiento por empresa de los reportes nuevos                   | n/a                                             | cada lectura recibe `tenantId` de la sesión                                                                    | `reports-operations.test.ts`, `mysql-reports.test.ts`                       |

## Desvíos registrados

- Navegación: la entrada «Reportes» lleva `nav.requires: 'export'` para que un lector sin `export` no vea el grupo «Análisis» (lo fija `features/audit/audit.test.tsx`, que este paquete no puede editar). La ruta sigue abierta con `view`. Prueba: `reports.test.tsx` y `app/routes.test.ts`.
- PDF: tope de 2.000 filas (`PDF_MAX_ROWS`), 422 `too_many_rows`. Prueba: `packages/domain/exports/src/service.test.ts`.
- PR 2: ver «Desviaciones del PR 2» en `docs/tasks/MVP-REPORTS-M5-20261019.md`.
