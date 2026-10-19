# MVP-ANALYTICS-M5-20261019: dashboard por permisos, indicadores y drill-down

```yaml
id: MVP-ANALYTICS-M5-20261019
baseline: [SPEC-1.4, ORCH-1.4, inherited: SPEC/ORCH 1.0-1.3 not superseded]
active_provider: anthropic
model: pin de código vigente según ADR-0007, sin fallback
milestone: M5
kind: implementation
wave: 1 (PR 1 con lease compartido tras MVP-SEARCH PR 1; PR 2 tras MVP-SEARCH PR 2)
base_sha: el main vigente al asignar (registrarlo)
depends_on:
  - G4 aceptado por el propietario el 2026-10-14 sobre 64bd116 (transcrito, no verificable)
  - ADR-0016
  - PR 2: MVP-SEARCH PR 2 fusionado (claves de filtro en la URL de cada listado)
requirements:
  [
    FR-140,
    FR-141,
    US-050,
    BRD §2.6 (KPIs sin integración),
    BRD §7.1,
    BRD S02,
    NFR-P1 (dashboard ≤ 1 s),
    SPECS §2.3 D5,
    SPECS §4.3 (estadísticas con la misma política que los listados),
    SPECS §4.4 (dashboard en la matriz A/B),
    SPECS §8 (estados de vista),
    SPECS §9.3 (dashboard p95 ≤ 1 s),
  ]
write_paths:
  - packages/domain/analytics/**
  - apps/api/analytics/**
  - apps/web/features/dashboard/**
  - packages/contracts/src/bff/analytics.ts (nuevo)
  - apps/api/bff/src/routes/analytics.ts y apps/api/bff/src/analytics.test.ts (nuevos)
  - apps/api/composition/src/platform/analytics-apis.ts (nuevo)
  - tests/integration/platform/analytics.test.ts y tests/integration/platform/mysql-analytics.test.ts (nuevos)
  - docs/tasks/MVP-ANALYTICS-M5-20261019.md
shared_paths_owned_in_wave_1:
  - registro de contratos, rutas BFF y composición (PR 1)
  - puertos de lectura agregada en los módulos fuente (solo consultas nuevas de conteo y agregación, sin cambiar reglas): packages/domain/{vehicles,employees,documents,insurance,maintenance,incidents}/**/ports o query
  - sus implementaciones en memoria y MySQL: packages/persistence/{vehicles,employees,documents,insurance,maintenance/orders,incidents/cases}/** (consultas nuevas, dos migraciones de solo índices en órdenes e incidentes y dobles de prueba)
  - registro en composición: apps/api/composition/src/{index.ts,platform.ts} y platform/{apis.ts,downstream-apis.ts,work-order-apis.ts} (líneas de registro y un tipo de retorno)
  - apps/web/app/HomeScreen.tsx y las rutas web de Inicio (PR 2)
  - package.json, tsconfig.json
forbidden_paths:
  - SPECS.md, Orchestrator.md, docs/baselines/**, Tasks.md, .env*, AWS, producción y datos reales
  - reglas de negocio de los módulos y sus tablas privadas (solo puertos)
  - apps/web/features/search/** (MVP-SEARCH)
status: planned
```

## Encargo

Convertir Inicio en el dashboard de S02: los widgets de BRD §7.1 y los indicadores de D5 calculados con datos reales, filtrables por área y rango de fechas, cada uno con drill-down al listado filtrado, y nada que el rol no pueda ver (FR-140, FR-141, US-050). Orden y dueños: ADR-0016 §1.

## Widgets e indicadores

Todas las fechas en la zona IANA de la empresa; «hoy» es el día de calendario de la empresa. El filtro de área incluye sus descendientes. Cada indicador declara fórmula, numerador, denominador, rango y permiso; si el denominador es 0 se muestra «sin datos», nunca 0 % ni 100 %.

| Widget / KPI                      | Fórmula y denominador                                                                                                      | Permiso               | Drill-down                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------- |
| Vehículos activos                 | Vehículos vivos en `active` hoy                                                                                            | `view`                | Vehículos `status=active`                |
| Fuera de servicio                 | Vehículos vivos en `out_of_service` o `maintenance` hoy                                                                    | `view`                | Vehículos con esos estados               |
| Conductores activos               | Empleados `kind=driver` en estatus activo                                                                                  | `view`                | Conductores activos                      |
| Mantenimientos próximos           | Planes con próxima ocurrencia en ≤ 15 días o ≤ 500 km (umbrales de SPECS §7)                                               | `view`                | Mantenimiento, próximos                  |
| Documentos por vencer             | Documentos vigentes que vencen en ≤ umbral de la empresa (30 días por defecto)                                             | `view`                | Documentos por vencer                    |
| Seguros por vencer                | Pólizas vigentes que vencen en ≤ umbral                                                                                    | `view`                | Seguros por vencer                       |
| Siniestros abiertos               | Casos en estado no terminal distinto de `draft`                                                                            | `incidents:view`      | Siniestros con esos estados              |
| Siniestros críticos               | Abiertos con severidad `high`/`critical` o SLA vencido (BRD §7.1)                                                          | `incidents:view`      | Siniestros críticos                      |
| Disponibilidad (D5)               | Promedio diario en el rango de vehículos `active` / vehículos vivos ese día, desde el historial de estado                  | `view`                | Estado de flota                          |
| % documentación vigente (D5)      | Documentos obligatorios vigentes / documentos obligatorios, por vehículo y por conductor, hoy                              | `view`                | Documentos vencidos                      |
| % seguros vigentes (D5)           | Vehículos activos con póliza que cubre hoy / vehículos activos                                                             | `view`                | Vehículos sin póliza vigente             |
| Mantenimiento a tiempo (D5)       | Preventivas cerradas en el rango con fecha real ≤ fecha prevista (o km real ≤ km previsto) / preventivas cerradas en rango | `view`                | Órdenes preventivas tardías              |
| Abiertos y cerrados (D5)          | Reportados en el rango y cerrados en el rango, por mes                                                                     | `incidents:view`      | Siniestros por fechas                    |
| Tiempo de resolución (D5)         | Mediana y p90 de días `reportedAt` → `resolvedAt` del primer ciclo, casos resueltos en el rango                            | `incidents:view`      | Reporte «Tiempo de resolución» (REPORTS) |
| Costo de mantenimiento (opcional) | Suma por moneda de órdenes cerradas en el rango, sin sumar monedas distintas                                               | `view` y `view_costs` | Reporte de costos                        |

«Utilización» y «tiempo de respuesta a alertas» de BRD §2.6 quedan fuera: dependen de integración o no tienen fuente fiable. Se declaran diferidos.

## Alcance

1. **PR 1, API.** `packages/domain/analytics` define el catálogo anterior y su cálculo sobre puertos de lectura agregada de cada módulo (`COUNT`/`GROUP BY` por el ORM, índices con `company_id` primero). `GET /api/v1/dashboard?areaId=&from=&to=` devuelve solo los widgets que el lector puede ver; un widget sin permiso **no aparece** en el payload (ni su conteo ni su nombre). Cache por empresa, versión de autorización del lector y filtros con vida de 5 minutos (US-050, «≤ 5 min»); `asOf` en la respuesta.
2. **PR 2, web.** `apps/web/features/dashboard` en `/` con `StatCard`, listas cortas y barras simples en SVG accesible (sin librería de gráficas nueva). Filtro de área y rango con atajos (hoy, 7 días, mes, trimestre, personalizado). Cada widget enlaza a la URL de listado con las claves de MVP-SEARCH PR 2. Estados de SPECS §8: cargando, sin datos, sin permiso para ningún widget (explica qué pedir), error recuperable. El panel «Siguiente paso» actual se conserva debajo.

## Implementación del PR 1

Decisiones y desviaciones, para que la revisión no las busque en el código.

- **Capas.** `packages/domain/analytics` (catálogo, fórmulas y puertos, sin dependencias de los módulos), `apps/api/analytics` (`DashboardApi`: autorización, cache y errores), `apps/api/composition/src/platform/analytics-apis.ts` (adaptadores de los puertos sobre los stores) y `apps/api/bff/src/routes/analytics.ts` (consulta estricta `areaId`, `from`, `to`, sin repetidos).
- **Puertos de lectura.** Cada módulo fuente implementa una interfaz opcional aparte (`VehicleAnalyticsReads`, `EmployeeAnalyticsReads`, `DocumentAnalyticsReads`, `PolicyAnalyticsReads`, `WorkOrderAnalyticsReads`, `IncidentAnalyticsReads`) además de su `Store`, en memoria y con TypeORM. Un store inyectado sin ellas hace que el dashboard responda 500 genérico, no un resultado parcial.
- **Índices.** Dos migraciones de solo índices: `ix_work_order_closure (company_id, status, closed_at)` en órdenes y `ix_incident_status`, `ix_incident_reported`, `ix_incident_closed`, `ix_incident_resolved (company_id, cycle, resolved_at)` en incidentes. Las demás consultas usan índices existentes con `company_id` primero.
- **Fórmulas, fechas y denominadores.** Cada widget lleva en el payload su fórmula, numerador y denominador. Los días son de la zona de la empresa; el fin del rango es exclusivo en UTC (inicio del día siguiente). Los percentiles son la mediana (media de los dos centrales si el conteo es par) y el p90 por rango más cercano. Los costos se suman por moneda en enteros exactos (`BigInt`), nunca entre monedas.
- **Mantenimiento a tiempo.** La orden no tiene km previsto propio: solo se juzga por fecha (real ≤ prevista); las preventivas sin alguna de las dos fechas se excluyen de ambos términos y se cuentan en `excluded`.
- **Fuera de servicio.** Cuenta los estados `out_of_service` e `in_maintenance` del módulo de vehículos (la tabla de arriba lo llama `maintenance`).
- **Siniestro crítico.** Abierto con severidad `high` o `critical`, o con el SLA en estado `breached` según `IncidentSlaReader`; abierto es todo estado salvo `draft`, `closed` y `cancelled`. Tiempo de resolución: la primera entrada `resolve` de la línea de tiempo para casos reabiertos y `resolved_at` para los de primer ciclo.
- **Cache.** Clave: empresa, huella SHA-256 de los permisos del lector y consulta resuelta (área, rango, hoy, zona y ventana de vencimiento). Vida de 5 minutos, 256 entradas como máximo, una sola ejecución para llamadas idénticas simultáneas y sin cachear fallos. La sesión y los permisos se resuelven en cada llamada, así que una revocación o un cambio de rol aplica de inmediato.
- **Ruta.** `GET /api/v1/dashboard`, kind `session`, error de área ajena o inexistente: 422 `invalid_area`, igual que el resto del BFF.

## Pruebas de aceptación

1. **Fórmulas.** Given un fixture con conteos conocidos por estado, área y fecha (incluido un cambio de estado a mitad del rango), Then cada indicador coincide con el cálculo a mano, también en el borde de medianoche de la zona de la empresa.
2. **Denominador 0.** Given una empresa vacía, Then cada indicador dice «sin datos» y la vista muestra un estado vacío útil.
3. **Permisos.** Given un despachador sin `incidents:view` ni `view_costs`, Then el payload no contiene widgets de siniestros ni costos (ni claves ni conteos) y el DOM tampoco.
4. **Tenant A/B.** Given datos en A y B con ids iguales, Then ningún conteo de A incluye B, también con cache caliente en las dos.
5. **Revocación.** Given un lector al que se le quita `incidents:view`, When recarga dentro de los 5 minutos de cache, Then ya no ve siniestros (la versión de autorización forma parte de la clave).
6. **Área.** Given un área padre con dos hijas, Then el filtro por el padre suma las hijas y por una hija solo esa.
7. **Drill-down.** Given cada widget, When se pulsa, Then el listado destino muestra exactamente las filas contadas.
8. **Rendimiento.** Given el dataset de SPECS §9.3 escalado para una empresa (500 vehículos, 1.000 empleados, 100.000 registros operativos), Then p95 ≤ 1 s sin cache.
9. **Accesibilidad.** axe sin violaciones; las barras tienen texto equivalente y el estado no depende solo del color.

## Decisiones por defecto

- Sin configuración de widgets por rol (BRD §7.1, fase 2): se muestran según permisos.
- Disponibilidad cuenta `active` como disponible; `restricted` no.
- Monedas distintas no se suman (SPECS §5.1).

## Tamaño

PR 1 unas 1.800 líneas con pruebas; PR 2 unas 1.200. Ningún archivo de producción supera 400 líneas.

## Fuera de alcance

Reportes y exportación (MVP-REPORTS), búsqueda (MVP-SEARCH), alcance por área de un usuario (fase 1.5), utilización (integración).

## Comandos y evidencia

```text
pnpm quality
pnpm test:integration
pnpm exec prettier --check docs/tasks/MVP-ANALYTICS-M5-20261019.md
git diff --check
```

Registrar SHA, MySQL exacto, dataset y p95, y la matriz requisito → contrato → implementación → prueba → evidencia. PR listo, CI verde y la única revisión Opus por PR/SHA. El autor no fusiona ni declara G5.
