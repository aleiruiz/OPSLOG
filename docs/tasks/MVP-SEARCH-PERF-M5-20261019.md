# MVP-SEARCH-PERF-M5-20261019: búsqueda global en una sola sentencia y 503 ante saturación

```yaml
id: MVP-SEARCH-PERF-M5-20261019
baseline: [SPEC-1.4, ORCH-1.4, inherited: SPEC/ORCH 1.0-1.3 not superseded]
active_provider: anthropic
model: claude-sonnet-5-5, sin fallback (ADR-0007)
milestone: M5
kind: fix
base_sha: 2bca154 (claude/mvp-ops-pr2)
depends_on:
  - MVP-SEARCH-M5-20261019 (búsqueda global)
  - MVP-OPS-M5-20261019 PR 2 (hallazgos 1 y 2 de la medición de carga)
requirements: [NFR-P4, SPECS §9.3 (búsqueda p95 <= 700 ms), SPECS §4.4 (matriz A/B)]
write_paths:
  - packages/persistence/search/**
  - apps/api/search/**
  - apps/api/bff/**
  - packages/contracts/src/**
  - packages/platform/observability/**
  - apps/web/features/search/**
  - docs/tasks/MVP-OPS-M5-20261019.md
```

## Problema

Con 50 usuarios y 100.000 entidades, la búsqueda global llegaba a un p95 de unos 2,1 a 2,5 s frente a un objetivo de 700 ms, y con más carga respondía HTTP 500 «Queue limit reached.».

La causa principal estaba en `TypeOrmSearchStore.search`: emitía 12 sentencias por petición (una de resultados y una de total por cada uno de los 6 tipos). Cada sentencia paga la inicialización del FULLTEXT ngram (unos 50 a 110 ms), y el pool de la fuente de búsqueda tiene 2 conexiones (`CONNECTIONS_PER_SOURCE=2`, intencional en el host compartido), así que unas pocas búsquedas simultáneas llenaban la cola. Además, una cola llena se respondía como 500 en vez de una señal de reintento.

## Corrección

1. **Una sentencia por petición.** `searchSql(query)` reúne los tipos permitidos en una consulta: cada rama (prefijo, claves exactas, «contiene») se ejecuta una vez, acotada por empresa y por pares (tipo, permiso); agrupa por `(entity_type, entity_id)` y usa `ROW_NUMBER() OVER (PARTITION BY entity_type ...)` y `COUNT(*) OVER (PARTITION BY entity_type)` para los primeros `limit` resultados y el total de cada tipo. `store.ts` reparte las filas por tipo. Se conservan sin cambios el aislamiento por empresa, los permisos por tipo, el orden (`rnk, display, entity_id`) y el conteo de entidades distintas. Se eliminan `matchesSql`, `hitsSql` y `totalSql`.
2. **Saturación no es un 500.** El código `unavailable` (503) se añade al contrato de errores (`ApiErrorStatus`, `BFF_ERRORS`, cliente). `isPoolSaturation` (en `packages/platform/observability`) reconoce «Queue limit reached.», `POOL_ENQUEUELIMIT` y `POOL_ACQUIRETIMEOUT`, también cuando el controlador los envuelve. `SearchApi.fail` y la captura general del BFF responden 503 `unavailable` con `Retry-After: 2`; el mensaje es fijo y no repite nada del controlador. El cliente web muestra «La búsqueda está saturada en este momento. Espera unos segundos e intenta de nuevo.» ante un 503.
3. **El tamaño del pool no cambia.**

## Archivos

| Pieza                   | Dónde                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consulta y almacén      | `packages/persistence/search/src/{query,store}.ts`, `store.test.ts`                                                                               |
| Detección de saturación | `packages/platform/observability/src/saturation.ts`, `saturation.test.ts`                                                                         |
| Contrato y cliente      | `packages/contracts/src/{errors,client}.ts`, `packages/contracts/src/bff/shared.ts` y sus pruebas                                                 |
| API y BFF               | `apps/api/search/src/index.ts`, `apps/api/bff/src/{handler,http}.ts`, `apps/api/bff/src/routes/shared.ts`, pruebas; referencias en los `tsconfig` |
| Web                     | `apps/web/features/search/{labels.ts,SearchBox.tsx,SearchScreen.tsx}` y `search.test.tsx`                                                         |
| Medición                | `docs/tasks/MVP-OPS-M5-20261019.md` (Hallazgos 1 y 2)                                                                                             |

## Medición

`pnpm ops:load` con el controlador Node (sin k6 ni Docker), 50 usuarios, espera media de 1000 ms, 100.000 entidades, MySQL 8.0.46 local de 4 vCPU. Es una medición de desarrollo, no una validación de producción.

| Búsqueda           | Antes, p95 50 usuarios | Después, p95 50 usuarios (2 corridas) | Después, p95 1 usuario | Fallos antes → después |
| ------------------ | ---------------------- | ------------------------------------- | ---------------------- | ---------------------- |
| Prefijo de placa   | 2475,3 ms              | 314,3 ms y 318,7 ms                   | 111,6 ms y 104,9 ms    | 78,0 % → 0 %           |
| «Contiene» (ngram) | 2222,7 ms              | 324,5 ms y 302,4 ms                   | 138,7 ms y 153,9 ms    | 93,5 % → 0 %           |

Objetivo: 700 ms. Los demás escenarios no cambian de forma relevante y no hubo errores del servidor.

## Comandos y evidencia

```text
pnpm typecheck
pnpm lint
pnpm format:check
pnpm baseline:check
pnpm leak:scan
pnpm --filter @opslog/persistence-search test:unit
pnpm --filter @opslog/persistence-search test:integration
pnpm ops:load
git diff --check
```
