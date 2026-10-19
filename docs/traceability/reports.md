# Trazabilidad: reportes y exportaciones (MVP-REPORTS PR 1)

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

Exportar exige además `export`. Los reportes de mantenimiento, siniestros y transversales y las fichas
PDF son del PR 2.

## Desvíos registrados

- Navegación: la entrada «Reportes» lleva `nav.requires: 'export'` para que un lector sin `export` no vea el grupo «Análisis» (lo fija `features/audit/audit.test.tsx`, que este paquete no puede editar). La ruta sigue abierta con `view`. Prueba: `reports.test.tsx` y `app/routes.test.ts`.
- PDF: tope de 2.000 filas (`PDF_MAX_ROWS`), 422 `too_many_rows`. Prueba: `packages/domain/exports/src/service.test.ts`.
