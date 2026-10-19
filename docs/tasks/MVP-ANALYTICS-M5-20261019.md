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
- **Qué cuenta en SQL y qué se agrega en memoria.** `COUNT` en la base: documentos por vencer (`analyticsCountExpiring`, con la lista de dueños no archivados en trozos de entrada de `In`) y pólizas por vencer. Filas proyectadas (`select` de pocas columnas) que se agregan en memoria: vehículos del alcance (`analyticsVehicles`) y sus cambios de estado hasta el fin del rango, empleados, documentos requeridos vigentes (`analyticsValidRequired`, deduplicados por dueño y tipo), vehículos con póliza vigente (`analyticsCoveredVehicleIds`, en trozos de 500), órdenes cerradas del rango con sus costos (en trozos de 500), casos abiertos (más una consulta de SLA por caso) y la línea de tiempo de siniestros. Por eso el costo crece con el tamaño de la flota y no con el rango, salvo órdenes y siniestros. Los documentos por vencer excluyen dueños archivados con y sin filtro de área, de modo que la suma por área cuadra con el total de la empresa.
- **Límite de `analyticsTimeline` con casos reabiertos.** La consulta trae los casos reportados, cerrados o resueltos (primer ciclo) dentro del rango y, además, **todos** los casos con `cycle > 1` de la empresa o del área, estén o no en el rango, porque la primera resolución de un caso reabierto solo está en su línea de tiempo (`resolve` con menor secuencia, leída en trozos de 500). El volumen leído crece con el total histórico de casos reabiertos, no con el rango; es aceptable mientras sean una fracción pequeña (el dataset de p95 reabre 1 de cada 25 casos, 240 de 6.000). Si dejan de serlo, el remedio es guardar `first_resolved_at` en el caso al resolver por primera vez (migración y relleno) y consultar solo por rango.
- **Cache.** Clave: empresa, huella SHA-256 de los permisos del lector y consulta resuelta (área, rango, hoy, zona y ventana de vencimiento). Vida de 5 minutos, 256 entradas como máximo, una sola ejecución para llamadas idénticas simultáneas y sin cachear fallos. La sesión y los permisos se resuelven en cada llamada, así que una revocación o un cambio de rol aplica de inmediato.
- **Ruta.** `GET /api/v1/dashboard`, kind `session`, error de área ajena o inexistente: 422 `invalid_area`, igual que el resto del BFF.

## Implementación del PR 2

Decisiones y desviaciones, para que la revisión no las busque en el código.

- **Inicio.** `HomeScreen` conserva el encabezado, monta `DashboardScreen` (`apps/web/features/dashboard`) y deja debajo el resumen de vencimientos y «Siguiente paso». El dashboard aumenta Inicio, no lo sustituye; el resumen de vencimientos se queda porque ya existe y tiene pruebas.
- **Capas web.** `ports.ts` (`DashboardPort` sobre `dashboard.get`, sin tocar el cliente compartido de contratos), `useDashboard.ts` (una petición por consulta; la respuesta de una consulta anterior se descarta y las últimas cifras se quedan en pantalla, marcadas como «actualizando»), `DashboardFilters.tsx`, `DashboardBody.tsx`, un componente por tipo de widget, `links.ts` (drill-down) y `fakePorts.ts` (puerto del API simulado, registrado en `mockApi`).
- **Permisos.** Se pinta solo lo que llega en `widgets`: no hay marcadores de lugar para lo ausente. Sin ningún widget, la vista explica en general qué pedir («permiso para consultar la información de la flota o de siniestros») sin nombrar widgets concretos ni ocultar filtros que no existen.
- **Gráficas.** SVG propio (sin librería nueva): barras diarias de disponibilidad y barras agrupadas por mes (reportados sólidos, cerrados con contorno, además de leyenda). Cada SVG tiene `role="img"` con resumen y una tabla colapsable con los datos.
- **Periodo.** Atajos Hoy, 7 días, 30 días (el valor por omisión del servidor), mes en curso, trimestre en curso y personalizado. Se calculan con el día de la empresa (`today` de la respuesta), nunca con el reloj del navegador; por eso los atajos esperan a la primera respuesta. Un rango personalizado inválido no se envía.
- **Drill-down.** `links.ts` traduce los filtros semánticos del payload a las claves de cada listado con `listLink`, que descarta lo que el listado no acepta. Donde el listado no tiene una clave para la fórmula exacta, el enlace abre el listado más cercano y la tarjeta lo dice:
  - Fuera de servicio: dos enlaces (`out_of_service` y `in_maintenance`), porque `status` de vehículos admite un solo valor.
  - Mantenimientos próximos: órdenes `scheduled` (no hay clave de «próximos por fecha o km»).
  - Siniestros críticos: dos enlaces (`severity=critical` y `severity=high`); el SLA vencido no es filtro (pendiente en search.md).
  - Documentos y seguros por vencer: `status=expiring`, sin área (esos listados no tienen `areaId`).
  - Seguros vigentes: vehículos activos (no hay filtro «sin póliza»).
  - Mantenimiento a tiempo: preventivas cerradas (sin clave `onTime`). Abiertos y cerrados: fecha del evento (`occurredFrom/To`), no la de reporte.
  - Tiempo de resolución y costo: sin enlace hasta que existan los reportes de MVP-REPORTS.
    - **Filtro de área.** Con un área elegida, los listados de documentos, seguros, mantenimiento y siniestros no tienen clave `areaId` (en search.md, pendiente); el enlace abre el listado de toda la empresa y la tarjeta lo avisa: «El listado no filtra por área; muestra toda la empresa.» Vehículos y empleados sí llevan el área. El enlace de disponibilidad abre la flota de hoy y lo dice.
      Por eso la prueba de aceptación 7 («exactamente las filas contadas») queda parcial en esos casos; se cierra añadiendo las claves al catálogo de MVP-SEARCH.
- **Estados.** Cargando, sin permiso para ningún widget, error recuperable (sin cifras: pantalla de error con reintento; con cifras previas: aviso y reintento sobre las últimas cifras), sin datos (estado vacío con acción «Registrar un vehículo» si puede crear, y cada indicador dice «Sin datos» cuando su denominador es 0).
- **Accesibilidad.** Pruebas con axe; los enlaces repiten el título del widget en su nombre accesible para distinguirse; el énfasis (por vencer, críticos) lleva texto además del color; en 360 px la rejilla es de una columna y las tarjetas anchas no desbordan.
- **Archivos fuera de `write_paths`.** Registro mínimo de PR 2: `apps/web/app/HomeScreen.tsx` (autorizado), `apps/web/app/types.ts` (puerto `dashboard` en `ApiPorts`), `apps/web/app/mockApi.ts` y `apps/web/app/mockApiTypes.ts` (puerto simulado y operación `dashboard`), `apps/web/api/ports.ts` (puerto real).
- **Pruebas.** `dashboard.test.tsx` (permisos, vacío, error, filtros, rango personalizado, texto equivalente de las gráficas, Inicio), `links.test.ts`, `range.test.ts`.

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
