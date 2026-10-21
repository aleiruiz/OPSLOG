# Evidencia de la etapa 2 de MVP-QA (ejecución sobre el candidato)

Paquete `docs/tasks/MVP-QA-M5-20261019.md`, etapa 2. Ejecución de las suites acumulativas sobre el candidato de MVP-INTEGRATE, con datos sintéticos solamente. No corrige defectos de producción, no declara G5 y no regenera líneas base visuales (lo prohibió el propietario). La matriz de la etapa 1 es `docs/traceability/final.md`; este documento solo agrega lo ejecutado.

## 1. Candidato y entorno

| Dato                   | Valor                                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SHA del candidato      | `e189041015c477a3b06cc4c678bd46211c5f79f2`, fusión de #150 en `main` (rama de trabajo `claude/m5-qa-stage2`)                                                                                                                       |
| Fecha de la corrida    | 2026-10-20 a 2026-10-21                                                                                                                                                                                                            |
| Máquina                | 4 vCPU, 15,7 GiB, Linux 6.18.44, Node 22.22.0, pnpm 11.25.0                                                                                                                                                                        |
| MySQL de la corrida    | **8.4.11**, la imagen del CI (`mirror.gcr.io/library/mysql:8.4.11@sha256:80f4933e3835f9dc4d35a28ec500d7986cb4414e6c6821c5461239cb7beb8995`), en un contenedor local con `max_connections = 500`, sin contraseña y solo en loopback |
| MySQL local del equipo | 8.0.46-0ubuntu0.24.04.4 (`max_connections = 500`). Se usó solo en una primera corrida parcial de `pnpm quality` (ver §2)                                                                                                           |
| Navegador y axe        | Playwright 1.56.1 con Chromium 141.0.7390.37; `@axe-core/playwright` 4.10.2 (`axe-core` 4.10.2)                                                                                                                                    |
| k6                     | 1.0.0 (`go1.24.2`, linux/amd64), binario oficial de GitHub Releases, tarball `sha256:5eb2236bc76a3c5cced12aaf0fd76c4b1ceac5ea040c70388a3d272b46595b59`; no se usó la imagen Docker                                                 |

Evidencia de CI en MySQL 8.4 para el mismo SHA: corrida `quality` 39516373116 (<https://github.com/aleiruiz/OPSLOG/actions/runs/39516373116>), en `main` sobre `e189041`, **éxito**. Trabajos: `static` (3 min 2 s), `unit` (9 min 13 s), `integration` (8 min 41 s, `pnpm test:integration`), `e2e` (8 min 36 s, `pnpm test:e2e`), `terraform` y `quality` en éxito; `docs` omitido. Los servicios MySQL de `integration` y `e2e` son la imagen 8.4.11 fijada en `.github/workflows/quality.yml`.

## 2. Resultados de las suites acumulativas

Todas sobre `e189041` más los archivos nuevos de este PR, con MySQL 8.4.11 (`OPSLOG_TEST_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:3307/mysql`). Los comandos corrieron uno tras otro, sin reintentos.

| Comando                       | Resultado | Duración    | Detalle                                                                                                                                                                                |
| ----------------------------- | --------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm quality`                | verde     | 13 min 53 s | `baseline:check`, `leak:scan`, `lint`, `format:check`, `typecheck`, `test:unit`, `test:integration` y `build`. 467 archivos de prueba y 5.562 pruebas en verde, 3 omitidas (ver abajo) |
| `pnpm test:integration`       | verde     | 5 min 37 s  | 119 archivos y 1.090 pruebas en verde, 2 omitidas                                                                                                                                      |
| `pnpm test:platform`          | verde     | 4 min 31 s  | 91 archivos, 741 pruebas en verde y 2 omitidas; umbrales de cobertura de composición cumplidos                                                                                         |
| `pnpm test:fleet-integration` | verde     | 2 min 44 s  | 31 archivos, 139 pruebas en verde                                                                                                                                                      |
| `pnpm test:acceptance`        | verde     | 1 min 4 s   | 9 archivos, 50 pruebas en verde, sin `.only`, sin omitidas, `--retry=0`. Incluye la prueba nueva de §3                                                                                 |
| `pnpm test:e2e` (Chromium)    | verde     | 7 min 52 s  | 163 pruebas en verde, ninguna omitida ni repetida. Incluye `e2e/mvp-journeys.spec.ts` (3) y `e2e/mvp-axe.spec.ts` (13, §4)                                                             |

Pruebas omitidas, todas de los autores y con condición propia (no son omisiones de esta suite): `tests/integration/platform/reports.test.ts` (rendimiento de la exportación directa, solo con `OPSLOG_PERF=1`), la medición de p95 de `mysql-audit-query.test.ts` (solo con `OPSLOG_PERF=1`) y `tests/performance/k6/load.test.ts` (solo con `OPSLOG_LOAD=1`, es `pnpm ops:load`, §5). Los totales de `quality` y `test:integration` suman los resúmenes de cada invocación de Vitest del log.

**Corrida parcial en MySQL 8.0.46 (local).** Antes de levantar el 8.4.11, `pnpm quality` se ejecutó contra el MySQL 8.0.46 del equipo: pasó la parte estática, `test:unit` completo y 695 pruebas de integración, y se detuvo en `test:platform` con 7 archivos que **se niegan a correr fuera de 8.4** por diseño (`MNT-ORDERS integration requires MySQL 8.4; found 8.0.46…`, `INC-CASES integration requires MySQL 8.4…`): `tests/e2e/maintenance/qa-{alerts,evidence,idempotency,orders,plan-lifecycle}.integration.test.ts`, `tests/integration/platform/mysql-analytics.test.ts` y `mysql-reports.test.ts`. No es un defecto del candidato; es el entorno. Esa corrida no cuenta como evidencia del candidato y se descartó a favor de la de 8.4.11.

## 3. FIX-QA-24: cambio de permiso con una exportación pendiente

Archivo nuevo: `tests/acceptance/permission-change-export.test.ts` (3 pruebas, en la suite `pnpm test:acceptance`).

Escenario, por la API real sobre MySQL 8.4.11 con dos bases (A y B):

1. Una segunda administradora de la empresa A pide una exportación del informe de seguros (`insurance`, con las columnas de deducible, que exigen `view_costs`) con 5.001 pólizas sintéticas de la empresa. Como pasa del límite directo de 5.000 filas, el trabajo queda `queued`, `mode: job`. La administradora principal pide el mismo informe: otro trabajo en cola, que sirve de control.
2. Antes de que corra el worker, la administradora principal baja a la primera al rol `editor` (`changeRole`), que no tiene `export` ni `view_costs`.
3. El worker corre (`exports.run`). Resultado: el trabajo de la persona degradada queda `failed` con `permission_revoked` o `session_ended` (el cambio de rol termina sus sesiones), sin `file_name` ni `row_count`, y no existe ningún trabajo `completed` a su nombre. El de la administradora principal termina con 5.001 filas y su descarga contiene el deducible (`1234.56`).
4. La persona degradada: su sesión anterior responde 401; con un ingreso nuevo, pedir una exportación responde 403, no lista ningún trabajo `completed`, no recibe el aviso `export_ready` y no puede descargar el archivo de la administradora.
5. El cambio de rol (`membership.role_changed`) consta en audit y ninguna entrada contiene el contenido de las filas.

Comprobación por mutación (local, no fusionada): con `exportAuthority.check` de `apps/api/composition/src/platform/report-apis.ts` devolviendo siempre los permisos de administrador, dos de las tres pruebas fallan (`expected 'completed' to be 'failed'`); el archivo de producción se restauró después. La prueba comprueba la regla.

Alcance: las plantillas de rol sintéticas de la composición solo dan `export` y `view_costs` juntas (administrador), así que la pérdida aislada de `view_costs` con `export` conservada no se puede expresar por la API; esa rama (columna sensible que se pierde: `missingPermission`) la cubre `packages/domain/exports/src/service.test.ts`. Queda como observación, no como hueco nuevo. Las filas se insertan con la conexión de administración de la prueba (fixture sintético), igual que `tests/e2e/mvp/export-job.integration.test.ts`.

## 4. FIX-QA-23: axe WCAG 2.1 AA sobre las pantallas integradas

Archivo nuevo: `e2e/mvp-axe.spec.ts` (13 pruebas), con la shell web real contra el BFF compuesto y una base MySQL sintética (`e2e/real-api/harness.ts`), sin mocks. Hay datos reales: un vehículo, un conductor y un aviso de fuera de servicio entregado por el worker. Reglas: etiquetas `wcag2a`, `wcag2aa`, `wcag21a` y `wcag21aa`. Cada prueba exige el encabezado de nivel 1 visible y distinto de «Iniciar sesión» (para no analizar la pantalla de acceso por error), espera la red inactiva y exige que axe haya aplicado reglas (`passes > 5`).

| Grupo                       | Pantallas (ruta bajo `/real`)                                                                                                                                                                          | Violaciones |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| M5 (8)                      | Inicio (dashboard) `/`, Búsqueda `/buscar`, Notificaciones, Preferencias de notificaciones, Reportes (catálogo), Reporte con datos (`?reporte=vehicle_inventory`), Auditoría, Integraciones (webhooks) | 0           |
| M1 a M4 representativas (5) | Vehículos, Documentos, Mantenimiento, Siniestros, Configuración · Usuarios                                                                                                                             | 0           |

Límites declarados: sesión de administradora (ve todo); no se recorren los estados de error ni de modal de cada pantalla; el ancho es el de escritorio de Chromium (el desbordamiento a 360 px lo cubren `e2e/web-shell.spec.ts` y `e2e/incidents-real.spec.ts`); la pantalla de webhooks se analiza sin webhooks creados. **No se ejecutó la regresión visual de M5 ni la mutación sistemática con herramienta** (siguen abiertas en FIX-QA-23): el propietario prohibió regenerar líneas base, y la mutación dirigida a mano de la etapa 1 sigue siendo la única.

## 5. FIX-QA-15: k6 sobre el candidato

k6 se obtuvo sin costo (binario oficial de GitHub Releases, v1.0.0, la versión fijada en `tests/performance/k6/scenarios.json`) y se ejecutó con `pnpm ops:load` (`OPSLOG_LOAD=1 OPSLOG_PERF=1`) contra `startServer` real sobre MySQL 8.4.11: una empresa, 500 vehículos, 1.000 empleados, 100.000 entidades en la proyección de búsqueda, 50 usuarios virtuales durante 69 s y una referencia de 1 usuario. Dos corridas, A y B. Es la **primera ejecución real del guion con k6** (hasta ahora solo se había medido con el controlador Node). Máquina de 4 vCPU en la misma máquina que el servidor, sin red: no representa el VPS de 2 vCPU y 8 GB y **no es una validación de producción**.

| Escenario                               | Objetivo  | p95 A, 50 usuarios | p95 B, 50 usuarios | p95 de 1 usuario (A / B) |
| --------------------------------------- | --------- | ------------------ | ------------------ | ------------------------ |
| Lista de vehículos (100 filas)          | 500 ms    | 32,9 ms            | 30,6 ms            | 15,1 / 13,9 ms           |
| Detalle de vehículo                     | 500 ms    | 28,0 ms            | 33,7 ms            | 12,4 / 9,4 ms            |
| Lista de empleados (100 filas)          | 500 ms    | 37,6 ms            | 33,7 ms            | 14,9 / 14,2 ms           |
| Alta de vehículo                        | 800 ms    | 72,0 ms            | 64,4 ms            | 23,1 / 24,0 ms           |
| Dashboard de Inicio                     | 1.000 ms  | 34,1 ms            | 33,7 ms            | 19,4 / 12,4 ms           |
| Búsqueda por prefijo de placa           | 700 ms    | 410,6 ms           | 445,0 ms           | 103,3 / 98,7 ms          |
| Búsqueda «contiene»                     | 700 ms    | 424,4 ms           | 459,6 ms           | 123,5 / 149,4 ms         |
| Exportación pequeña (CSV de inventario) | 10.000 ms | 110,5 ms           | 115,6 ms           | 66,3 / 56,6 ms           |

Lectura: todos los p95 de 50 usuarios están muy por debajo del objetivo absoluto. **NFR-P5 no se cumple** como degradación relativa: la búsqueda por prefijo pasó de 103 a 411 ms (297 %) en A y de 99 a 445 ms (351 %) en B frente al umbral de 20 %; el informe de MVP-OPS ya lo declaraba «no cumplido» y no hay motivo para cambiarlo. No se midieron NFR-P3, el millón de registros ni las 20 empresas y 500 sesiones, que siguen pendientes de lanzamiento (ver el manifiesto, §5).

**Fallo registrado (FIX-QA-25).** Ambas corridas de `pnpm ops:load` terminan en rojo: `AssertionError: list_vehicles has data: expected 'no_data' not to be 'no_data'`. El informe generado muestra 0 muestras y «sin datos» en las ocho filas aunque los p95 sí llegan. Causa: `handleSummary` de `tests/performance/k6/scenarios.js` lee `count` de métricas `Trend`, y k6 1.0.0 solo entrega `min`, `max`, `avg`, `med`, `p(90)` y `p(95)` en ese tipo (el `count` es de los `Counter`). Reproducción:

```text
export OPSLOG_TEST_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:3306/mysql   # MySQL 8.4 local, sintético
PATH=<directorio con k6 1.0.0>:$PATH pnpm ops:load
# informe: Muestras 0 y «sin datos» en cada fila; vitest: «list_vehicles has data»
```

Es un defecto del guion de prueba, no del producto, y `tests/performance/**` está fuera de las rutas de escritura de este paquete: no se corrigió. Por eso los p95 de esta sección se citan como lectura directa del guion de k6, sin el visto bueno del informe: no hay conteo de muestras que respalde el percentil, y el 0,0 % de fallos del informe tampoco se da por verificado (la prueba imprime `server errors: {}`, sin errores del servidor). FIX-QA-15 queda **parcialmente cerrado**: hay corrida sobre el candidato y sobre 8.4.11, falta que el guion valide sus propias muestras. Condición para cerrarlo: corregir el guion (FIX-QA-25), repetir `pnpm ops:load` en verde y registrar las muestras.

## 6. Huecos nuevos y estado de los pedidos

| Pedido    | Estado tras la etapa 2                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| FIX-QA-15 | Parcial: k6 1.0.0 ejecutado sobre `e189041` y MySQL 8.4.11 (§5); queda por FIX-QA-25                                                        |
| FIX-QA-23 | Parcial: axe ejecutado y sin violaciones (§4); regresión visual y mutación sistemática no ejecutadas                                        |
| FIX-QA-24 | Cerrado: `tests/acceptance/permission-change-export.test.ts` (§3)                                                                           |
| FIX-QA-25 | **Nuevo.** El guion de k6 no cuenta muestras con k6 1.0.0 (§5). Solicitud: leer `http_reqs` por etiqueta de escenario o un `Counter` propio |

Ningún otro fallo en las suites acumulativas del candidato: todas pasaron a la primera con MySQL 8.4.11.

## 7. Cómo repetirlo

```text
docker run -d --name mysql84 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -p 3306:3306 \
  mirror.gcr.io/library/mysql:8.4.11@sha256:80f4933e3835f9dc4d35a28ec500d7986cb4414e6c6821c5461239cb7beb8995 --max_connections=500
export OPSLOG_TEST_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:3306/mysql
pnpm install --frozen-lockfile
pnpm quality && pnpm test:integration && pnpm test:platform && pnpm test:fleet-integration
pnpm test:acceptance
pnpm exec playwright install chromium && pnpm test:e2e
PATH=<k6 1.0.0>:$PATH pnpm ops:load        # rojo hasta corregir FIX-QA-25
```
