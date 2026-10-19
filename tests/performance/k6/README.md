# Prueba de carga (k6)

Paquete `MVP-OPS-M5-20261019`, PR 2. Mide el p95 de lecturas, escritura simple, dashboard, búsqueda y exportación pequeña con 50 usuarios virtuales de **una** empresa contra el servidor real de la API (`startServer`, con su worker) sobre MySQL local. **Nunca contra la demo de Coolify** (VPS compartida) ni contra un entorno con datos reales. Ninguna cifra es una validación de producción.

## Qué hay

| Archivo                               | Para qué                                                                                                 |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `scenarios.json`                      | los 8 escenarios, su presupuesto (SPECS §9.3, NFR-P1 a P5), la espera entre peticiones y la imagen de k6 |
| `scenarios.js`                        | el guion de k6 (umbral p95 por escenario, salida `handleSummary` en JSON)                                |
| `scenario-lib.js`                     | utilidades compartidas por k6 y por el controlador Node                                                  |
| `seed.ts`, `stack.ts`                 | siembra de una empresa y arranque de la API con sesiones ya abiertas                                     |
| `driver.ts`                           | controlador Node con `fetch` (mismos escenarios y esperas) para máquinas sin k6 ni Docker                |
| `k6-runner.ts`, `run.ts`, `report.ts` | ejecución (k6 local o contenedor), línea base de 1 usuario e informe                                     |

## Ejecutar

Requiere MySQL (8.4 en la pila; las medidas del paquete usan 8.0.46) con una cuenta administradora local y no tocar nada ajeno: la prueba crea bases `opslog_t_*` propias.

```bash
export OPSLOG_TEST_MYSQL_ADMIN_URL='mysql://root@127.0.0.1:3306/mysql'   # solo local
OPSLOG_LOAD_OUT=informe-carga.md pnpm ops:load
```

`pnpm ops:load` activa `OPSLOG_LOAD=1` y `OPSLOG_PERF=1`: con PERF fallan los presupuestos y los errores; sin PERF el informe se escribe igualmente y la prueba solo comprueba que hay datos.

Variables: `OPSLOG_LOAD_DRIVER` (`auto`, `k6` o `node`), `OPSLOG_LOAD_DURATION` (s, 60), `OPSLOG_LOAD_BASELINE` (s, 20), `OPSLOG_LOAD_THINK_MS`, `OPSLOG_LOAD_VEHICLES` (500), `OPSLOG_LOAD_EMPLOYEES` (1000), `OPSLOG_LOAD_ENTITIES` (100000, entidades de la proyección de búsqueda), `OPSLOG_LOAD_JSON` (volcado de filas).

### Generador

1. `auto`: usa k6 si el ejecutable local existe; si no, la imagen **`grafana/k6:1.0.0`** con Docker (versión fijada en `scenarios.json`; para producción de resultados, fijar además el digest `sha256` de esa imagen al verificarla). En Linux el contenedor usa `--network host` para llegar a `127.0.0.1`; en otros sistemas ajuste el anfitrión.
2. Sin k6 ni Docker, el controlador Node. **El informe nombra qué generador se usó.** El guion `scenarios.js` solo se ha comprobado de forma estática donde k6 no existe; la primera ejecución real con k6 es un paso pendiente.

### Qué mide

Cada usuario recorre los escenarios en orden con una espera de 0,5 a 1,5 veces `thinkMs` (arranque desfasado), con la sesión ya abierta (el inicio de sesión no es parte de la medida). Se mide también una línea base de 1 usuario para la degradación de NFR-P5. Los datos son sintéticos; la escritura crece la base durante la corrida.

### Límites

Las 20 empresas y 500 sesiones de SPECS §9.3, la búsqueda sobre 1 M de registros (`docs/operations/SEARCH_PERFORMANCE.md`) y NFR-P3 (archivo de 10 MB en 4G) se miden en la cuenta del cliente. Una máquina de desarrollo no representa el VPS de 2 vCPU y 8 GB.
