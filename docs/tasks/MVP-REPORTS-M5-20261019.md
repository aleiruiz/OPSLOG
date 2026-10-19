# MVP-REPORTS-M5-20261019: catálogo de reportes, exportación CSV/XLSX/PDF y jobs

```yaml
id: MVP-REPORTS-M5-20261019
baseline: [SPEC-1.4, ORCH-1.4, inherited: SPEC/ORCH 1.0-1.3 not superseded]
active_provider: anthropic
model: pin de código vigente según ADR-0007, sin fallback
milestone: M5
kind: implementation
wave: 2 (PR 1 primer dueño de la ola 2; PR 2 tras MVP-NOTIFY)
base_sha: el main vigente con la ola 1 fusionada (registrarlo)
depends_on:
  - ola 1 de M5 fusionada (MVP-AUDIT-UI, MVP-SEARCH, MVP-ANALYTICS)
  - ADR-0016 §5
requirements:
  [
    FR-145,
    FR-146,
    FR-147,
    FR-148,
    US-011,
    US-052,
    US-060 (PDF de cumplimiento; alcance por área diferido),
    BRD §13.1 (cada reporte),
    BRD §13.2,
    BRD §16.2 (exportaciones en audit),
    BRD S22,
    NFR-P6,
    NFR-PR1,
    NFR-PR5,
    SPECS §2.3 D10/D15,
    SPECS §4.3 (job con tenant y actor; revalidar al generar y al descargar),
    SPECS §5.1 (costos de reparación sin doble conteo; monedas),
    SPECS §7 (exports,
    neutralizar fórmulas),
    SPECS §9.3 (export ≤ 5.000 filas ≤ 10 s),
  ]
write_paths:
  - packages/domain/reports/**
  - packages/domain/exports/**
  - packages/platform/exports/** (escritores CSV, XLSX y PDF)
  - packages/persistence/exports/**
  - apps/api/reports/**
  - apps/api/exports/**
  - apps/worker/exports/**
  - apps/web/features/reports/**
  - packages/contracts/src/bff/reports.ts (nuevo)
  - apps/api/bff/src/routes/reports.ts y apps/api/bff/src/reports.test.ts (nuevos)
  - apps/api/composition/src/platform/report-apis.ts y apps/api/composition/src/exports-source.ts (nuevos)
  - tests/integration/platform/reports.test.ts y tests/integration/platform/mysql-exports.test.ts (nuevos)
  - docs/tasks/MVP-REPORTS-M5-20261019.md
shared_paths_owned_in_wave_2:
  - registro de contratos, rutas BFF, composición y arneses MySQL
  - apps/worker/composition/** y apps/api/server/src/worker-loop.ts (PR 1: el tick pasa a recorrer una lista de jobs registrados, para que NOTIFY y WEBHOOKS solo registren)
  - puertos de lectura de reportes en los módulos fuente (solo consultas nuevas, sin reglas)
  - rutas web del grupo «Análisis»
  - package.json, pnpm-lock.yaml (exceljs, pdfkit con versión exacta)
forbidden_paths:
  - SPECS.md, Orchestrator.md, docs/baselines/**, Tasks.md, .env*, AWS, producción y datos reales
  - reglas de negocio y tablas privadas de los módulos (solo puertos)
  - apps/web/features/audit/** (el enlace de S26 a este reporte es de MVP-INTEGRATE)
status: planned
```

## Encargo

Entregar **cada** reporte de BRD §13.1 con filtros, columnas seleccionables y orden (FR-145), su exportación CSV y XLSX respetando filtros, columnas, PII y costos (FR-146), PDF de fichas y cumplimiento (FR-147), jobs en segundo plano para más de 5.000 filas con aviso al terminar (FR-148) e historial de exportaciones (S22). No se sustituye el catálogo por una exportación genérica. Orden y dueños: ADR-0016 §1.

## Motor (PR 1)

- **Definición de reporte** (`packages/domain/reports`): `id`, familia, filtros allowlist con tipos, columnas con etiqueta y sensibilidad (`pii`, `costs`, `incident_costs`), orden permitido, permisos requeridos y puerto fuente. Las columnas sensibles se **excluyen de la consulta y del archivo** sin el permiso; nunca se ocultan después.
- **Permisos.** Ver un reporte exige el permiso de lectura del módulo (`view`, o `incidents:view` en siniestros); exportar exige además `export`. PII exige `view_pii`; costos de mantenimiento `view_costs`; costos de siniestros `incidents:view_costs` (ADR-0014).
- **Formatos** (`packages/platform/exports`, ADR-0016 §5): CSV propio RFC 4180 con BOM UTF-8 y cabeceras en español; XLSX con **ExcelJS** `WorkbookWriter` en streaming, celdas siempre tipadas (texto, número, fecha) y nunca fórmulas; PDF con **PDFKit**, IBM Plex autoalojada, paginado con nombre de la empresa, fecha de corte en su zona, autor y «página n de m».
- **Fórmulas.** Toda celda de texto que empiece con `=`, `+`, `-`, `@`, tabulador o retorno de carro (y sus variantes de ancho completo) se prefija con `'` en CSV y XLSX.
- **Síncrono o job.** Hasta 5.000 filas y con estimación dentro de 10 s, respuesta directa. Si no, `ExportJob` (`queued`, `running`, `completed`, `failed`, `expired`) con empresa, actor, reporte, filtros, columnas y formato; el job vuelve a comprobar sesión, membresía y permisos al empezar y no produce datos si ya no están (SPECS §4.3). Idempotente por `Idempotency-Key`. Límite de jobs simultáneos por empresa y por actor.
- **Artefacto.** Se guarda en el almacén de objetos bajo la ruta opaca de la empresa (`tenants/<id>/exports/<jobId>`), disponible 7 días; descarga por proxy autenticado que **revalida permisos** y audita; job de purga al vencer. Con almacenamiento `memory` el artefacto se pierde al reiniciar y el job queda `expired`.
- **Eventos y audit.** Outbox `export.completed {jobId, reportId, format, rowCount}` y `export.failed` para MVP-NOTIFY; audit de cada exportación con reporte, formato, filas y nombres de filtros (sin valores libres), BRD §13.2.
- **Web** (`apps/web/features/reports`): catálogo en `/analisis/reportes` agrupado por familia, vista previa paginada, selector de columnas, exportar y pestaña «Mis exportaciones» con estado.

## Inventario por reporte

| Familia       | Reporte (`id`)                                            | PR  | Fuente                                 | Notas                                                                         |
| ------------- | --------------------------------------------------------- | --- | -------------------------------------- | ----------------------------------------------------------------------------- |
| Plantilla     | Conductores (`drivers`)                                   | 1   | empleados, asignaciones, documentos    | Licencia solo con `view_pii`                                                  |
| Plantilla     | Despachadores (`dispatchers`)                             | 1   | empleados                              | Contacto solo con `view_pii`                                                  |
| Plantilla     | Áreas (`areas`)                                           | 1   | áreas, empleados, vehículos            | Conteos por área                                                              |
| Plantilla     | Cumplimiento documental de personas (`people_compliance`) | 1   | documentos                             | También PDF                                                                   |
| Vehículos     | Inventario (`vehicle_inventory`)                          | 1   | vehículos, asignaciones                |                                                                               |
| Vehículos     | Estado de flota (`fleet_status`)                          | 1   | historial de estado                    | Días en estado en la zona de la empresa                                       |
| Vehículos     | Seguros (`insurance`)                                     | 1   | seguros                                | Deducible solo con `view_costs`                                               |
| Vehículos     | Documentación (`vehicle_documents`)                       | 1   | documentos                             | También PDF                                                                   |
| Vehículos     | Historial de vehículo (`vehicle_history`, PDF)            | 2   | todos los módulos por puerto           | Timeline compuesto; sin PII ni costos sin permiso                             |
| Mantenimiento | Preventivo plan vs. real (`maintenance_plan_vs_actual`)   | 2   | planes, órdenes                        | Desvío en días y km                                                           |
| Mantenimiento | Correctivo (`maintenance_corrective`)                     | 2   | órdenes                                | Costo solo con `view_costs`; incidente origen por folio                       |
| Mantenimiento | Costos (`maintenance_costs`)                              | 2   | órdenes                                | Por moneda; costo/km solo con km válidos                                      |
| Mantenimiento | Frecuencia (`maintenance_frequency`)                      | 2   | órdenes                                |                                                                               |
| Siniestros    | Por período (`incidents_by_period`)                       | 2   | casos, costos                          | Costo total de INC-COSTS (sin doble conteo de reparaciones)                   |
| Siniestros    | Por vehículo / conductor (`incidents_by_subject`)         | 2   | casos, costos, timeline                |                                                                               |
| Siniestros    | Por tipo / severidad / estado (`incidents_distribution`)  | 2   | casos                                  | Tabla cruzada                                                                 |
| Siniestros    | Costos (`incident_costs`)                                 | 2   | costos                                 | Sin columna «a cargo del conductor» (D15); «otros» sí                         |
| Siniestros    | Tiempo de resolución (`incident_resolution`)              | 2   | timeline, SLA                          | Días por etapa, mediana, p90 y % SLA cumplido; ciclos de reapertura separados |
| Siniestros    | Abiertos / envejecimiento (`incident_aging`)              | 2   | casos, SLA                             |                                                                               |
| Transversal   | Vencimientos consolidados (`expirations`)                 | 2   | documentos, seguros, licencias, planes | Rangos 7/15/30/60/90                                                          |
| Transversal   | Audit log (`audit_log`)                                   | 2   | puerto de MVP-AUDIT-UI                 | `view_audit`; mismo enmascarado que S26                                       |
| Fichas PDF    | Vehículo, conductor, siniestro (`*_sheet`)                | 2   | puertos de cada módulo                 | FR-147; nombre de la empresa en texto (ADR-0016 pregunta 3)                   |

## Pruebas de aceptación

1. **Cada reporte.** Given un fixture por reporte, Then filtros, columnas y orden producen las filas esperadas; la prueba es individual por `id`, no genérica.
2. **PII y costos.** Given un lector sin `view_pii`, `view_costs` ni `incidents:view_costs`, Then ni la vista previa, ni el CSV, XLSX o PDF contienen esas columnas ni sus valores; los bytes del archivo se inspeccionan.
3. **Fórmulas.** Given textos `=1+1`, `+cmd`, `-2`, `@SUM`, tabulador y `＝1`, Then aparecen como texto prefijado en CSV y XLSX y ninguna celda XLSX es fórmula.
4. **Job.** Given 5.001 filas, Then se crea un job, termina `completed`, emite `export.completed` una vez y la descarga funciona; con 5.000 es síncrono si cabe en 10 s.
5. **Revocación.** Given un job encolado, When se revoca `export` o la sesión antes de ejecutar, Then termina sin datos; given un artefacto listo, When se revoca el permiso, Then la descarga da 403 y queda auditada la denegación.
6. **Tenant A/B.** Given un `jobId` de B, Then estado y descarga dan 404 en A; las rutas de objeto incluyen la empresa.
7. **Sin doble conteo.** Given un siniestro con una orden vinculada y gastos propios, Then el costo total del reporte coincide con los totales de INC-COSTS y no suma la orden dos veces; monedas distintas en filas separadas.
8. **PDF.** Given una ficha de 3 páginas, Then cada página trae empresa, fecha de corte en la zona de la empresa, autor y numeración; el texto se extrae y es legible.
9. **Expiración.** Given un artefacto de más de 7 días, Then la descarga da 410 y la purga lo borra del almacén.
10. **Rendimiento.** Given 5.000 filas de inventario, Then CSV y XLSX en ≤ 10 s y memoria acotada (streaming), registrado.

## Decisiones por defecto

- Reportes programados por correo (FR-149) fuera de MVP (SPECS §2.2).
- Sin columna de cargo al conductor (D15).
- Vistas de filtros de reporte guardadas con las vistas de MVP-SEARCH si el módulo `reports` se registra en su allowlist; no hay un segundo almacén.

## Tamaño

PR 1 (motor, formatos, jobs, descarga, web, 8 reportes de plantilla y vehículos) unas 2.800 líneas; PR 2 (los 13 reportes restantes del catálogo, fichas PDF, historial de vehículo) unas 2.600. Ningún archivo de producción supera 400 líneas: un archivo por familia de reportes.

## Fuera de alcance

Notificación «exportación lista» (la entrega MVP-NOTIFY a partir de `export.completed`), importación (ya en M2), exportación completa de empresa (MVP-OPS), programación de envíos.

## Comandos y evidencia

```text
pnpm quality
pnpm test:integration
pnpm exec prettier --check docs/tasks/MVP-REPORTS-M5-20261019.md
git diff --check
```

Registrar SHA, MySQL exacto, versiones exactas de ExcelJS y PDFKit, y la matriz por reporte individual requisito → contrato → implementación → prueba → evidencia. PR listo, CI verde y la única revisión Opus por PR/SHA. El autor no fusiona ni declara G5.

## Evidencia PR 1

- Rama `claude/mvp-reports-pr1`, apilada sobre `claude/mvp-analytics-pr1` (a7fd5c8) porque la CI no está disponible.
- MySQL exacto de las pruebas de integración: 8.0.46 local (`OPSLOG_TEST_MYSQL_ADMIN_URL`).
- Versiones exactas: ExcelJS 4.4.0 (`WorkbookWriter` en flujo, celdas tipadas, sin fórmulas), PDFKit 0.20.2 con IBM Plex Sans 5.3.0 autoalojada (`@fontsource/ibm-plex-sans`); `pdfjs-dist` 5.4.296 solo en pruebas, para extraer el texto de los PDF.
- Trazabilidad por reporte: `docs/traceability/reports.md`.

### Desviaciones y límites conocidos

- El modelo no tiene tipo de vehículo, propiedad, turno ni supervisor: los reportes no inventan esas columnas.
- El contacto de un despachador se trata como PII (`view_pii`).
- El motor carga las filas de la empresa (tope `MAX_REPORT_ROWS` = 50.000, después responde 422 `too_many_rows`) y filtra y ordena en memoria; la paginación SQL por reporte queda para el PR 2 si el rendimiento lo pide.
- Una exportación directa se ejecuta en la petición pero también deja su registro de trabajo; el cliente descarga por la ruta de descarga autenticada, no en la respuesta.
- La auditoría solo conserva `attempts` en `data` (lista blanca del almacén): reporte y formato viajan en la acción (`export.completed:<reporte>:<formato>`), el resto vive en el registro del trabajo.
- Los eventos `export.completed` y `export.failed` se publican en el outbox; hasta que MVP-NOTIFY los consuma, el worker registra un manejador que solo los reconoce (`registerExportEventHandlers`) para que no terminen en dead letter. MVP-NOTIFY debe sustituirlo.
- Cambiar el rol de una persona cierra sus sesiones: la descarga responde 401 antes de llegar al 403; el 403 con auditoría de la denegación está cubierto en las pruebas del servicio de exportaciones.
- Acceptance 7 (sin doble conteo) no aplica al PR 1: los reportes de siniestros son del PR 2.
