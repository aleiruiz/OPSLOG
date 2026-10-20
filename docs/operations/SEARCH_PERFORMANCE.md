# Rendimiento de la búsqueda global

Requisito: SPECS §9.3, búsqueda p95 <= 700 ms con 1 M. Paquete MVP-SEARCH, FR-160.

## Generador y medición

`tests/performance/search/generate.ts` construye entidades sintéticas con los mismos builders de
proyección del dominio (`vehicleProjection`, `employeeProjection`): 70 % vehículos y 30 % conductores,
placas deterministas. La carga entra por `TypeOrmSearchStore.apply`, sin SQL manual. MVP-OPS puede
reutilizar el generador.

`tests/performance/search/search.perf.test.ts` mide el p95 de 60 consultas por escenario (prefijo,
"contiene", sin resultados) contra MySQL real y registra el `EXPLAIN` del prefijo. Es opcional:
requiere `OPSLOG_PERF=1` y `OPSLOG_TEST_MYSQL_ADMIN_URL`; sin ellos se omite.

## Comandos

```text
# 100.000 entidades (por defecto)
OPSLOG_PERF=1 OPSLOG_TEST_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:3306/mysql pnpm test:perf

# 1 M de entidades (paso manual; varias decenas de minutos y varios GB de disco)
OPSLOG_PERF=1 OPSLOG_PERF_ENTITIES=1000000 OPSLOG_TEST_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:3306/mysql pnpm test:perf
```

Cada entidad genera varias filas de clave en `opslog_search_entries`.

## Resultados registrados

| Fecha      | MySQL  | Entidades | Prefijo p95 | Contiene p95 | Sin resultados p95 |
| ---------- | ------ | --------- | ----------- | ------------ | ------------------ |
| 2026-10-19 | 8.0.46 | 100.000   | 160,8 ms    | 277,5 ms     | 6,1 ms             |

Segunda corrida (misma máquina, con carga concurrente): prefijo 245,4 ms, contiene 433,7 ms, sin resultados 12,3 ms.

### Duración del reconcile (100.000 entidades)

Carga inicial 22,8 s; estado estable (sin cambios) 1,2 s. Las fuentes son en memoria: no incluye el costo de
leer los módulos dueños, que el reconcile pagina por tipo (solo conductores y despachadores en empleados).

Máquina local de desarrollo (mysqld en loopback, una sola empresa). Presupuesto: 700 ms.

Plan `EXPLAIN` del prefijo (100.000 entidades): `type=range`, `key=ix_search_prefix`,
`Extra=Using where; Using index` (cubre la consulta sin leer la tabla).

La corrida de 1 M queda pendiente como paso manual; su resultado se registra en esta tabla con el SHA
y el MySQL exacto.
