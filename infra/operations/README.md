# Operaciones: respaldo, restauración y simulacro

Paquete `MVP-OPS-M5-20261019`, PR 1. Contexto y alcance: ADR-0016 §3 (etapa 0: pila Docker Compose con MySQL 8.4 en un VPS, una empresa por despliegue). Todo corre sin AWS ni red externa; lo que solo existe en la cuenta del cliente queda como pendiente de lanzamiento en el paquete.

## Qué hay

| Ruta                       | Qué es                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup/backup.sh`         | `dump`, `binlogs`, `retention`, `run` (bucle del contenedor) y `health`.                                                                                                |
| `backup/entrypoint.sh`     | Entrada del servicio `backup` del compose: espera a que MySQL acepte la cuenta de respaldo y lanza `backup.sh run`.                                                     |
| `restore/restore.sh`       | Restaura dump más binlogs hasta un instante en una instancia **temporal** y verifica conteos y sumas por tabla.                                                         |
| `restore/fingerprint.sh`   | Conteo y `CHECKSUM TABLE` por tabla (TSV ordenado). Sirve para tomar la huella de la fuente y compararla con la restaurada.                                             |
| `restore/temp-instance.sh` | Instancia MySQL desechable: contenedor `mysql:8.4` (`docker`) o un `mysqld` aparte del anfitrión (`local`, el del simulacro).                                           |
| `restore/smoke.mjs`        | Arranca la API contra la copia restaurada en modo solo lectura y comprueba que sirve. Exige `--temporary` y un host de loopback: se niega a correr contra la principal. |
| `tenant-export/`           | Exportación completa de una empresa: JSON y CSV por entidad y archivos liberados en un `.opsx` cifrado con manifiesto de sumas (NFR-B5). Ver más abajo.                 |
| `lib/common.sh`            | Utilidades compartidas (registro JSON, sumas SHA-256).                                                                                                                  |

El simulacro y las pruebas de los scripts están en `tests/recovery` (`pnpm ops:drill`).

## Respaldo

El servicio `backup` del `docker-compose.yml` (imagen `deploy/Dockerfile`, destino `backup`, misma red que `mysql`, sin puerto publicado) escribe en el volumen `opslog-backups`:

```text
dumps/opslog-<UTC>.sql.gz  + .sha256     mysqldump --single-transaction --source-data=2 --routines --triggers
dumps/opslog-<UTC>.meta    + .sha256     posición del binlog, servidor, versión, bases incluidas, SHA-256 del dump
binlogs/<uuid del servidor>/<binlog>  + .sha256    binlogs cerrados, copiados una sola vez
status/                                  marcas de tiempo para el healthcheck
```

- **Frecuencia.** Un dump al arrancar y uno al día (03:00 UTC por defecto); los binlogs cerrados se copian cada 900 s (`OPSLOG_BACKUP_BINLOG_INTERVAL`). Si el binlog activo no creció desde la última copia no se rota, así que una pila ociosa no produce archivos vacíos.
- **RPO por diseño.** Lo que se pierde es lo escrito desde la última copia: como mucho el intervalo (15 min) más lo que tarde la copia. Lo escrito en el binlog activo y no copiado no está en el volumen.
- **Retención.** 35 días (`OPSLOG_BACKUP_RETENTION_DAYS`). Nunca se borra el dump más reciente ni lo posterior a él, aunque el respaldo se haya detenido más de 35 días.
- **Integridad.** Cada archivo lleva su `.sha256`; `restore.sh` lo comprueba antes de usarlo y se niega con un binlog faltante (hueco) o alterado.
- **Cuenta MySQL.** `opslog_backup`, creada por el trabajo `migrate` cuando existe `OPSLOG_BACKUP_PASSWORD` (24 caracteres como mínimo; se carga en Coolify como secreto). Privilegios globales `RELOAD`, `REPLICATION CLIENT`, `REPLICATION SLAVE`, `SHOW_ROUTINE`; sobre `opslog_t_%`: `SELECT`, `SHOW VIEW`, `TRIGGER`. No puede insertar, actualizar, borrar ni cambiar el esquema. `TRIGGER` lo exige `mysqldump --triggers` y es el único privilegio que permitiría crear un disparador; hoy el esquema no tiene ninguno.
- **Binlog en MySQL.** El compose arranca `mysql` con `--server-id=1 --log-bin=binlog --binlog-expire-logs-seconds=604800` (siete días locales; el volumen de respaldo guarda 35).
- **Claves.** `OPSLOG_PII_MASTER_KEY` y `OPSLOG_MYSQL_SECRET` **no** entran al volumen. Sin la primera, los datos personales restaurados no se pueden leer: guardarla en un gestor de secretos aparte del VPS. El volumen está en el mismo VPS que la base: una copia fuera del anfitrión (por ejemplo un bucket S3 con prefijo e IAM nuevos) es decisión del propietario y no se hace aquí.
- **Salud.** `backup.sh health` falla si la última copia de binlogs tiene más de tres intervalos; el healthcheck del contenedor lo usa y Coolify notifica el contenedor en mal estado.

Manual, desde el anfitrión: `docker compose exec backup /opt/opslog-ops/backup/backup.sh dump` (o `binlogs`, `retention`).

## Restaurar a un instante

Nunca sobre la instancia principal. `restore.sh` se niega a cargar en un destino que ya tenga bases `opslog_t_*` salvo `--allow-nonempty`.

```bash
# 1. Instancia temporal (contenedor desechable, publicada solo en 127.0.0.1)
eval "$(infra/operations/restore/temp-instance.sh start restore 3390 docker)"

# 2. Restaurar hasta el instante (UTC); sin --until, todo lo copiado. --database restaura una sola empresa.
#    Con la huella de la fuente (fingerprint.sh) la comparación de conteos y sumas queda automática.
infra/operations/restore/restore.sh --backup-dir /ruta/al/volumen/de/respaldos \
  --host 127.0.0.1 --port 3390 --until '2026-10-19 14:30:00' --report restauracion.txt

# 3. Humo: cuentas restringidas, API en solo lectura contra la copia (hace falta el bundle:
#    node apps/api/server/build.mjs) y las claves de la instalación de origen.
OPSLOG_MYSQL_SECRET=... OPSLOG_PII_MASTER_KEY=... \
  node infra/operations/restore/smoke.mjs --temporary --bundle apps/api/server/bundle --port 3390 --database opslog_t_main
```

El volumen se localiza con `docker volume inspect <proyecto>_opslog-backups`. El informe trae el dump usado, los binlogs aplicados, tablas, filas, `verified` y los segundos.

### Copiar una empresa restaurada a la instancia principal (paso manual)

Restaurar una empresa es restaurar la instancia completa (o solo su base con `--database`) en la temporal y extraer la base validada (SPECS §9.3). La copia a la principal es manual y se hace con la API detenida. Primero se valida y se guarda todo en archivos; la base principal solo se toca después, y una carga fallida se revierte con la copia de seguridad previa:

```bash
# 1. Archivos: el dump validado de la temporal y una copia de seguridad de la principal actual
mysqldump -h 127.0.0.1 -P 3390 -uroot --single-transaction --routines --triggers --databases opslog_t_main > restaurada.sql
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -uroot --single-transaction --routines --triggers --databases opslog_t_main' > previa.sql
test -s restaurada.sql && test -s previa.sql && tail -n 1 restaurada.sql | grep -q 'Dump completed'

# 2. Cargar en la principal solo con ambos archivos completos (el dump trae DROP/CREATE de la tabla)
docker compose stop api web
docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot' < restaurada.sql \
  || docker compose exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot' < previa.sql   # falló: volver a la copia previa

# 3. Cuentas restringidas y arranque
docker compose run --rm migrate                      # recrea las cuentas restringidas (idempotente)
docker compose up -d api web
```

El dump de `mysqldump --databases` ya incluye `DROP TABLE IF EXISTS` por tabla: no se ejecuta `DROP DATABASE` aparte. Si la carga falla a medias, `previa.sql` deja la base como estaba antes del intento.

Después, nuevo dump inmediato (`backup.sh dump`): el servidor restaurado tiene otro `server_uuid`, así que sus binlogs van a otra carpeta y los anteriores solo sirven para restaurar a instantes previos a la pérdida.

## Cuenta de respaldo y binlogs

- **`opslog_backup`** (la crea `migrate` si `OPSLOG_BACKUP_PASSWORD` está definida): `SELECT`, `SHOW VIEW` y `TRIGGER` sobre `opslog_t_%`, y `RELOAD`, `REPLICATION CLIENT`, `REPLICATION SLAVE`, `SHOW_ROUTINE` globales. `TRIGGER` lo exige `mysqldump --triggers` (sin él, el dump omite los triggers sin avisar). Con ese privilegio la cuenta podría crear un trigger; MySQL lo impide (error 1419) mientras el binlog esté activo y `log_bin_trust_function_creators=0`, que es la configuración del compose (`--log-bin`, sin `--log-bin-trust-function-creators`). Quien cambie esos ajustes debe revisar esta dependencia. Hoy el esquema no tiene triggers.
- **Estado de binlogs.** `backup.sh binlogs` cierra el binlog activo (`FLUSH BINARY LOGS`) y guarda su nombre y tamaño en `status/active-log` justo después, antes de copiar. Si no cambió desde la corrida anterior no cierra otro (un sistema ocioso no genera logs vacíos), pero fuerza el cierre si el último tiene más de 4 intervalos (`status/last-flush`). Una escritura que ocurra durante la copia cambia el tamaño y se copia en la siguiente corrida aunque el sistema quede ocioso: el RPO queda acotado por el intervalo.
- **Cuentas en pruebas.** `OPSLOG_MYSQL_ACCOUNT_TAG` (sufijo de las cuentas de ejecución, por defecto `app`) y `OPSLOG_BACKUP_USER` (por defecto `opslog_backup`) existen para que suites que comparten un MySQL no choquen; en un despliegue se dejan sin definir.

## Simulacro

`pnpm ops:drill` (local, sin Docker ni AWS; usa un segundo `mysqld` del anfitrión, mysqldump y mysqlbinlog; no corre en el CI ordinario). Con datos sintéticos: migra dos empresas, escribe marcas con hora, respalda, sigue escribiendo, copia binlogs, sigue escribiendo, mata el servidor y borra su directorio de datos, restaura en una instancia temporal, compara conteo y suma de cada tabla con la fuente, ejecuta el humo y mide RPO y RTO. Después restaura solo la empresa A en una segunda instancia temporal con la principal ya avanzada, copia A a mano y comprueba que la huella de B no cambia. Cifras y limitaciones: `docs/tasks/MVP-OPS-M5-20261019.md`.

Variables del simulacro: `OPSLOG_DRILL_FILLER_ROWS` (filas de relleno por empresa, 50000), `OPSLOG_DRILL_LOSS_WINDOW_MS` (escritura posterior a la copia, 4000), `OPSLOG_DRILL_OUT` (ruta de un JSON con las cifras).

## Exportación completa de empresa

`tenant-export` (PR 2): `export`, `verify` y `extract`. Lee con la cuenta `opslog_backup` (solo SELECT) dentro de una instantánea consistente, descifra los datos personales con el cifrador de la empresa (`OPSLOG_PII_MASTER_KEY`) y escribe un único archivo `opslog-export-<fecha>-<id>.opsx`: contenedor propio (entradas con marco, gzip, AES-256-GCM por fragmentos con clave derivada de `OPSLOG_EXPORT_KEY`) que detecta clave errónea, truncado y reordenación. Contiene `manifest.json` con la suma de cada entrada, JSON y CSV por entidad y los objetos liberados verificados por SHA-256; omite secretos y tokens. Una tabla sin clasificar en el catálogo detiene la exportación. Junto al archivo escribe `export-audit.jsonl` (eventos de auditoría con referencias opacas) y un resumen sin datos personales. Procedimiento operativo: `docs/runbooks/backup-restore.md` §4. El paquete se construye con `node infra/operations/tenant-export/build.mjs` y la imagen `api` lo trae en `./tenant-export`.
