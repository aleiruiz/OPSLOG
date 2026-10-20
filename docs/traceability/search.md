# Trazabilidad: búsqueda global (MVP-SEARCH PR 1)

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
- Los filtros, vistas guardadas y columnas son del PR 2.
