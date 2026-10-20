# Trazabilidad: búsqueda global, vistas guardadas, filtros en URL y columnas (MVP-SEARCH)

| Requisito                                       | Contrato                       | Implementación                                                          | Prueba                                                                                        |
| ----------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| FR-160 búsqueda tolerante a acentos, guiones    | `GET /api/v1/search`           | `packages/domain/search` (normalización), `packages/persistence/search` | `normalize.test.ts`, `mysql.integration.test.ts`, `tests/integration/platform/search.test.ts` |
| Aislamiento por empresa                         | `search.query`                 | toda sentencia filtra `company_id`                                      | `search.test.ts`, `mysql-search.test.ts`                                                      |
| Permisos por tipo, alcance de mecánico cerrado  | `BffSearchGroup` (sin conteo)  | `SearchService.typeAccess`                                              | `service.test.ts`, `search.test.ts`                                                           |
| PII solo por coincidencia exacta con `view_pii` | sin campos PII en la respuesta | índices ciegos de `employees`; `exactKeys` solo con `view_pii`          | `search.test.ts`, `mysql-search.test.ts`                                                      |
| Proyección idempotente y reconstruible          | n/a                            | `SearchIndexer.reconcile` / `rebuild`, trabajo `search.reconcile`       | `indexer.test.ts`, `search.test.ts`                                                           |
| Combobox accesible en la barra superior         | n/a                            | `apps/web/features/search`                                              | `search.test.tsx` (axe)                                                                       |
| p95 <= 700 ms                                   | n/a                            | índice B-tree de prefijo y FULLTEXT ngram                               | `tests/performance/search` (`docs/operations/SEARCH_PERFORMANCE.md`)                          |

## Alcance de mecánico

Los siniestros siguen la regla del módulo (`canView` / `isMechanicScoped`): `incidents:view` y, si el
miembro está ligado a un mecánico, solo con `incidents:edit` (quien gestiona casos no queda acotado).
La regla está replicada en `typeAccess` (el dominio de búsqueda no depende del de siniestros) y
probada en `service.test.ts`.

## Desviaciones del paquete

- Vehículos, empleados y pólizas no emiten eventos de outbox y su lógica no se modifica en este PR: la
  proyección se alimenta con un trabajo periódico `search.reconcile` (por empresa, cada minuto),
  idempotente por huella. Un `rebuild` completo usa el mismo camino con `full: true`.
- Las órdenes de trabajo quedan fuera: no tienen folio.
- Los filtros, vistas guardadas y columnas son del PR 2 (secciones siguientes).

# PR 2: vistas guardadas, filtros en la URL, columnas y filtros de §14.2

| Requisito                                                             | Contrato                                                                        | Implementación                                                                                                                      | Prueba                                                                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-162 vistas por usuario, compartibles en la empresa                 | `views.list/create/update/delete` (`packages/contracts/src/bff/saved-views.ts`) | `packages/domain/saved-views`, `packages/persistence/saved-views`, `apps/api/saved-views`, `apps/api/bff/src/routes/saved-views.ts` | `service.test.ts`, `store.test.ts`, `mysql.integration.test.ts`, `saved-views.test.ts` (BFF), `tests/integration/platform/saved-views.test.ts` |
| Límite de 50 por usuario y módulo                                     | 422 `rule_violation` (`view_limit`)                                             | `SavedViewService.create`, `GET_LOCK` por dueño y listado en el almacén                                                             | `service.test.ts`, `mysql.integration.test.ts` (concurrencia), `saved-views-scenarios.ts`                                                      |
| Revalidación al aplicar (allowlist y permisos)                        | `BffSavedView.dropped`                                                          | `sanitize` del dominio con el `ViewCatalog` construido desde `BFF_LIST_CATALOG`                                                     | `service.test.ts`, `saved-views-scenarios.ts` (lector sin `view_costs`), `views.test.tsx` (aviso)                                              |
| Vista privada ajena = 404; compartida ajena sin `manage_config` = 403 | n/a                                                                             | `SavedViewService.owned`                                                                                                            | `service.test.ts`, `saved-views-scenarios.ts`, `views.test.tsx`                                                                                |
| Versiones concurrentes = 409; nombre repetido = 409                   | `stale_version`, `duplicate`                                                    | `UPDATE ... WHERE version = ?`, clave única `(company_id, owner_id, module, name_key)`                                              | `store.test.ts`, `mysql.integration.test.ts`                                                                                                   |
| Aislamiento A/B                                                       | n/a                                                                             | toda sentencia filtra `company_id`; la empresa sale de la sesión, nunca de la petición                                              | `tenantIsolation` en `tests/integration/platform/saved-views.test.ts` y `mysql-saved-views.test.ts`                                            |
| Columnas visibles por usuario y módulo en el servidor                 | `views.columns`, `views.columnsSave`                                            | tabla `opslog_list_columns`; `useListColumns` y `ColumnPicker`                                                                      | `mysql.integration.test.ts`, `views.test.tsx` (persisten al volver a abrir)                                                                    |
| La URL refleja filtros, orden y tamaño                                | claves de `BFF_LIST_CATALOG` (tabla siguiente)                                  | `apps/web/features/search/views/urlState.ts` y `useListUrl.ts`; las pantallas leen y escriben con `router.navigate`                 | `urlState.test.ts`, `views.test.tsx`                                                                                                           |
| Filtros de §14.2 como filtros de servidor                             | consultas de `vehicles/employees/documents/insurance` con rangos                | puertos de lectura y almacenes de cada módulo; `catalogFilters` valida contra el catálogo                                           | pruebas de servicio, BFF y de integración MySQL de cada módulo                                                                                 |
| Accesibilidad                                                         | n/a                                                                             | `ViewsBar`, `ColumnPicker`, `ExtraFilters`                                                                                          | `apps/web/features/search/views/accessibility.test.tsx` (axe, seis listados)                                                                   |

## Claves de URL de los listados (estables)

Las claves son las mismas en la barra de direcciones, en la consulta de la API del listado y en `filters`
de una vista. Los valores son texto; una clave ausente significa «sin filtro»; una clave desconocida o un
valor inválido se ignoran, nunca se ejecutan. Fuente única: `BFF_LIST_CATALOG`
(`packages/contracts/src/bff/list-views.ts`). Para enlaces desde otras pantallas (drill-down de
MVP-ANALYTICS) se exporta `listLink(módulo, filtros, { sort, limit })` en
`apps/web/features/search/views/urlState.ts`, que descarta lo que el listado no aceptaría.

Claves comunes: `limit` (`25`, `50`, `100`; por omisión 25) y `sort` (`campo` ascendente o `-campo`
descendente; solo en listados con orden de servidor). La página es por cursor firmado y ligado a los
filtros (`Cargar más`), por lo que no se serializa.

| Listado (ruta)                              | Claves y valores                                                                                                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vehículos (`/flota/vehiculos`)              | `status` (`active`, `restricted`, `in_maintenance`, `out_of_service`, `inactive`, `decommissioned`), `areaId`, `includeArchived=true`, `yearFrom`, `yearTo` (1950-2100), `kmFrom`, `kmTo` (0-9999999)                                                   |
| Empleados (`/plantilla/empleados`)          | `kind`, `status`, `areaId`, `includeArchived=true`, `hiredFrom`, `hiredTo`, `licenseExpiresFrom`, `licenseExpiresTo` (fechas `AAAA-MM-DD`, extremos incluidos)                                                                                          |
| Documentos (`/flota/documentos`)            | `ownerType` (`vehicle`, `employee`), `ownerId` (con `ownerType`), `typeCode`, `status` (`valid`, `expiring`, `expired`), `includeArchived=true`, `expiresFrom`, `expiresTo` (un documento sin vencimiento no cae en ningún rango)                       |
| Seguros (`/flota/seguros`)                  | `vehicleId`, `coverageType`, `status`, `coversOn` (`AAAA-MM-DD`), `includeArchived=true`, `endsFrom`, `endsTo`                                                                                                                                          |
| Mantenimiento (`/flota/mantenimiento`)      | `status` (`scheduled`, `assigned`, `in_progress`, `completed`, `closed`, `cancelled`), `kind` (`preventive`, `corrective`), `vehicleId`, `month` (`AAAA-MM`), `overdue=true`, `costFrom`, `costTo` (unidades enteras de moneda; requieren `view_costs`) |
| Siniestros (`/incidents`, `incidents:view`) | `status` (lista separada por comas), `severity`, `type`, `vehicleId`, `responsible=me`, `createdBy=me`, `occurredFrom`, `occurredTo`; `sort` entre `occurredAt`, `createdAt`, `severity`, `folio` (por omisión `-occurredAt`)                           |

Columnas (clave del catálogo): las de identificación y `actions` son fijas y no se ofrecen; el resto se
puede ocultar. `cost` de mantenimiento requiere `view_costs`.

## Inventario de filtros de BRD §14.2

Hecho = filtro de servidor en la allowlist del listado (salvo donde se indica). Pendiente = no está en
este PR; no se declara hecho.

| Módulo        | Hecho                                                                                                        | Pendiente                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vehículos     | área, estado, año (rango), km (rango), archivados                                                            | tipo, marca/modelo, propiedad (el modelo no tiene esos campos), seguro vigente/vencido, documentos vencidos y conductor asignado (cruzan módulos: hoy se filtran desde Seguros, Documentos y Asignaciones) |
| Conductores   | área, estatus, tipo de vinculación, vigencia de licencia (rango), fecha de ingreso (rango), archivados       | tipo de licencia, vehículo asignado, documentos vencidos                                                                                                                                                   |
| Mantenimiento | estado, tipo, vehículo, mes programado, vencida, costo (rango)                                               | mecánico/taller, rango de fecha programada y fecha realizada                                                                                                                                               |
| Incidentes    | estado, tipo, severidad, vehículo, responsable, creados por mí, fecha del evento (rango), orden por 4 campos | conductor, área, aseguradora, fecha de reporte, SLA vencido, costo (rango), con terceros                                                                                                                   |
| Documentos    | entidad, registro, tipo, estado, vencimiento (rango), archivados                                             | usuario que cargó                                                                                                                                                                                          |

## Desviaciones y decisiones del PR 2

- **Mantenimiento filtra en el cliente.** `workOrders.list` no pagina ni filtra en el servidor (devuelve las
  órdenes de la empresa). Las claves, la validación de vistas y los permisos son los mismos del catálogo, pero
  `status`, `kind`, `vehicleId`, `month`, `overdue` y el rango de costo se aplican sobre la lista cargada. El
  costo es la suma de las líneas en unidades enteras de moneda (se redondea hacia abajo). Mover el filtro al
  servidor queda pendiente junto con la paginación de esa ruta.
- **Orden de servidor solo en siniestros** (único listado con `sort` en su contrato). Los demás listados tienen
  orden fijo; `sorts` está vacío en el catálogo y una vista no puede guardar un orden que el listado no tiene.
- **Sin atajos de fecha** (hoy, 7 días, mes actual, trimestre; BRD §14.3): los rangos usan selectores de fecha.
  Pendiente; no se declara hecho.
- **La página no va en la URL:** la paginación es por cursor firmado (SPECS §7), ligado a los filtros.
- **Compartir:** cualquier miembro puede compartir sus vistas con la empresa; editar o borrar una compartida
  ajena exige `manage_config` (403 si no).
- **Altas estrictas, lecturas tolerantes:** guardar una clave o valor fuera de la allowlist es 400; al leer, lo que
  el catálogo o los permisos del lector ya no admiten se descarta y se informa en `dropped`.
- **Credencial propia:** el almacén usa la cuenta MySQL de ejecución `opslog_views_*` (solo DML) con la migración
  `CreateSavedViews2026101900020`.
