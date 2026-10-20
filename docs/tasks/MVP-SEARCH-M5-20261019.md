# MVP-SEARCH-M5-20261019: búsqueda global, vistas guardadas, filtros en URL y columnas

```yaml
id: MVP-SEARCH-M5-20261019
baseline: [SPEC-1.4, ORCH-1.4, inherited: SPEC/ORCH 1.0-1.3 not superseded]
active_provider: anthropic
model: pin de código vigente según ADR-0007, sin fallback
milestone: M5
kind: implementation
wave: 1 (PR 1 con lease compartido tras MVP-AUDIT-UI; PR 2 tras MVP-ANALYTICS PR 1)
base_sha: el main vigente al asignar (registrarlo); PR 2 sobre el SHA con PR 1 fusionado
depends_on:
  - G4 aceptado por el propietario el 2026-10-14 sobre 64bd116 (transcrito, no verificable)
  - ADR-0016 §4 (proyección indexada y prueba de 1 M como paso manual)
requirements:
  [
    FR-160,
    FR-161,
    FR-162,
    BRD §14.1,
    BRD §14.2,
    BRD §14.3,
    NFR-P4,
    SPECS §2.3 D23 (búsqueda exacta de PII por índice HMAC),
    SPECS §4.3 (índices,
    cursores y cache con tenantId),
    SPECS §4.4 (búsqueda en la matriz A/B),
    SPECS §7 (paginación 25/50/100,
    allowlist),
    SPECS §9.3 (búsqueda p95 ≤ 700 ms con 1 M),
  ]
write_paths:
  - packages/domain/search/**
  - packages/domain/saved-views/**
  - packages/persistence/search/**
  - packages/persistence/saved-views/**
  - apps/api/search/**
  - apps/api/saved-views/**
  - apps/web/features/search/**
  - packages/contracts/src/bff/search.ts y packages/contracts/src/bff/saved-views.ts (nuevos)
  - apps/api/bff/src/routes/search.ts, apps/api/bff/src/routes/saved-views.ts y sus pruebas (nuevos)
  - apps/api/composition/src/platform/search-apis.ts y apps/api/composition/src/search-source.ts (nuevos)
  - tests/integration/platform/search.test.ts y tests/integration/platform/mysql-search.test.ts (nuevos)
  - tests/performance/search/** (generador y medición; MVP-OPS reutiliza el generador)
  - docs/tasks/MVP-SEARCH-M5-20261019.md
shared_paths_owned_in_wave_1:
  - packages/contracts/src/index.ts, packages/contracts/src/bff.ts y el registro de rutas BFF
  - apps/api/composition/src/** y apps/worker/composition/** (consumidor del outbox para la proyección)
  - tests/e2e/fleet/mysql.ts y e2e/real-api/harness.ts (cuenta runtime y migraciones del módulo)
  - apps/web/app/AppShell.tsx (caja de búsqueda en la barra superior) y las rutas web de «Buscar»
  - PR 2: pantallas de listado de módulos, solo para montar el selector de vistas, sincronizar filtros con la URL y añadir filtros de §14.2 (apps/web/vehicles, apps/web/employees, apps/web/documents, apps/web/insurance, apps/web/features/maintenance, apps/web/features/incidents) y la allowlist de filtros de sus contratos de lista
  - package.json, tsconfig.json, pnpm-lock.yaml
forbidden_paths:
  - SPECS.md, Orchestrator.md, docs/baselines/**, Tasks.md, .env*, AWS, producción y datos reales
  - reglas de negocio de los módulos (packages/domain/<módulo>/** salvo filtros de lectura en PR 2)
  - tablas privadas de otros módulos: la proyección se llena por puertos de lectura, nunca por SQL entre módulos
status: planned
```

## Encargo

Búsqueda global en la barra superior (FR-160) con resultados agrupados por entidad y respetando permisos; filtros avanzados, orden y paginación del servidor en los listados de BRD §14.2 (FR-161); filtros guardados por usuario y compartibles en la empresa, filtros reflejados en la URL y columnas visibles persistidas (FR-162, §14.3). Orden y dueños: ADR-0016 §1.

## Diseño de búsqueda (PR 1)

- **Proyección propia** `opslog_search_entries` en la base de la empresa: `company_id`, `entity_type` (`vehicle`, `driver`, `dispatcher`, `incident`, `work_order`, `policy`), `entity_id`, `area_id`, `key_kind` (`economic_number`, `plate`, `vin`, `name`, `employee_number`, `license`, `folio`, `claim_number`, `policy_number`, `identification_hmac`), `normalized`, `display` (texto visible sin PII sensible), `required_permission`, `updated_at`. PK `(company_id, entity_type, entity_id, key_kind, normalized)`.
- **Normalización:** minúsculas, sin acentos (NFD), sin guiones, espacios ni puntos (BRD §14.1). Índice B-tree `(company_id, normalized)` para prefijo y FULLTEXT `ngram` (n = 3) sobre `normalized` para «contiene» de nombres y folios. Términos de menos de 3 caracteres solo por prefijo.
- **PII cifrada (D23):** identificación y licencia solo por coincidencia exacta mediante el índice HMAC por empresa que ya existe en empleados (`packages/platform/pii`); nunca parcial, nunca en `display` y solo con `view_pii`. La proyección no guarda el valor en claro.
- **Alimentación:** consumidor del outbox (`vehicle.*`, `employee.*`/`driver.*`, `incident.*`, `maintenance.*`, pólizas) que relee la entidad por el puerto del módulo con actor de sistema y reescribe sus filas; idempotente por empresa y `eventId`. Comando de reconstrucción completa por empresa para el primer despliegue y tras restaurar.
- **Lectura:** `GET /api/v1/search?q=&types=` hasta 10 resultados por tipo, con total por tipo, en ≤ 700 ms p95. El resultado se filtra por el permiso actual del lector (`view` para flota y plantilla, `incidents:view` para siniestros, alcance de mecánico falla cerrado como en M4) y cada fila trae el enlace al detalle correcto. Nada de conteos de entidades que el lector no puede ver.
- **Rendimiento:** `tests/performance/search` genera un dataset sintético escalable por la composición y los builders de persistencia (sin SQL manual): 100.000 filas por defecto, opcional en CI (`OPSLOG_PERF=1`), y **1 M como paso manual documentado** con el comando exacto; el resultado de la corrida manual se registra aquí.

## Vistas guardadas, URL y columnas (PR 2)

- `SavedView`: `id`, `companyId`, `ownerId`, `module`, `name`, `filters` (JSON validado contra la allowlist del módulo), `sort`, `columns`, `shared` (empresa), `version`. Límite 50 por usuario y módulo. Solo el dueño o `manage_config` edita o borra una vista compartida.
- **Invalidación de vista ajena:** al aplicar una vista se revalidan filtros y columnas contra la allowlist y los permisos del lector; un filtro o columna que el lector no puede usar (costos, PII) se descarta con aviso, nunca se ejecuta. Una vista de otro usuario no compartida da 404.
- **URL:** cada listado de §14.2 serializa filtros, orden, página y tamaño en la query string con claves documentadas en el contrato; abrir la URL reproduce la vista. MVP-ANALYTICS PR 2 usa estas claves para el drill-down.
- **Columnas** visibles por usuario y módulo persistidas en el servidor (no `localStorage`).
- **Filtros de §14.2:** inventario por módulo de los filtros existentes contra BRD §14.2; los que falten se añaden como filtros de servidor en la allowlist del listado del módulo, con índice cuando el volumen lo pida. Lo que no quepa en este PR queda en el inventario como pendiente, no como hecho.

## Pruebas de aceptación

1. **Tenant A/B.** Given placas, folios y nombres iguales en A y B, When A busca, Then solo resultados de A; un cursor o una vista de B usados en A dan 400/404.
2. **Permisos.** Given un lector sin `incidents:view`, Then no hay grupo de siniestros ni su conteo; con alcance de mecánico, falla cerrado.
3. **PII exacta.** Given un número de licencia, Then con `view_pii` y el valor exacto se encuentra al conductor; un prefijo del número no encuentra nada; sin `view_pii`, nada. Ninguna respuesta ni log contiene el número.
4. **Tolerancia.** Given «ÁBC-123», Then «abc123», «abc 1» y «bc12» (contiene) lo encuentran; «Pérez» encuentra «perez».
5. **Frescura.** Given un vehículo cuyas placas cambian, When el outbox se procesa, Then la placa vieja ya no lo encuentra; repetir el evento no duplica filas.
6. **Reconstrucción.** Given la proyección borrada por fixture, When se reconstruye, Then el resultado es idéntico al incremental.
7. **Enlaces.** Given cada tipo de resultado, Then el enlace abre el detalle correcto de esa entidad.
8. **Rendimiento.** Given 100.000 filas, Then p95 ≤ 700 ms en la máquina de CI o local registrada; given 1 M (manual), resultado registrado con el plan `EXPLAIN` usado.
9. **Vistas.** Given una vista compartida con filtro de costo, When la abre un lector sin `view_costs`, Then el filtro se descarta con aviso y no se envía; editar la vista compartida de otro sin `manage_config` da 403; versiones concurrentes dan 409.
10. **URL.** Given un listado filtrado, When se copia la URL en otra sesión con los mismos permisos, Then se ve el mismo resultado.
11. **Accesibilidad.** Caja de búsqueda y resultados navegables por teclado (combobox accesible); axe sin violaciones.

## Decisiones por defecto

- Sin motor externo de búsqueda (OpenSearch u otro): costo de etapa 0 (ADR-0012).
- Acciones masivas sobre selección (§14.3) fuera de MVP salvo exportar, que es de MVP-REPORTS.
- Orden por una columna; multi-columna (opcional en el BRD) fuera.

## Tamaño

PR 1 (proyección, consumidor, API, caja global, rendimiento) unas 2.200 líneas; PR 2 (vistas, URL, columnas, filtros) unas 2.000. Ningún archivo de producción supera 400 líneas.

## Fuera de alcance

Dashboard (MVP-ANALYTICS), exportación (MVP-REPORTS), búsqueda por API pública (fase 1.5), alcance por área (fase 1.5, D6).

## Comandos y evidencia

```text
pnpm quality
pnpm test:integration
OPSLOG_PERF=1 pnpm exec vitest run tests/performance/search
pnpm exec prettier --check docs/tasks/MVP-SEARCH-M5-20261019.md
git diff --check
```

Registrar SHA, MySQL exacto, tamaño del dataset, p95 y la matriz requisito → contrato → implementación → prueba → evidencia. PR listo, CI verde y la única revisión Opus por PR/SHA. El autor no fusiona ni declara G5.

## Evidencia de rendimiento (PR 1)

Corrida local del 2026-10-19, MySQL 8.0.46 en loopback, una empresa, 100.000 entidades (70 % vehículos,
30 % conductores), `OPSLOG_PERF=1 pnpm test:perf`. Presupuesto: p95 <= 700 ms.

| Escenario        | p95 (corrida 1) | p95 (corrida 2) |
| ---------------- | --------------- | --------------- |
| Prefijo          | 160,8 ms        | 245,4 ms        |
| Contiene (ngram) | 277,5 ms        | 433,7 ms        |
| Sin resultados   | 6,1 ms          | 12,3 ms         |

Reconcile completo (fuentes en memoria): carga inicial 22,8 s, estado estable 1,2 s. EXPLAIN del
prefijo: `range` sobre `ix_search_prefix`, `Using index`. Detalle en `docs/operations/SEARCH_PERFORMANCE.md`.
La corrida de 1 M sigue como paso manual pendiente.
