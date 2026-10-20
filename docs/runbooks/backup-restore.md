# Runbook: respaldo, restauración y exportación de empresa

Detalle técnico de los scripts: `infra/operations/README.md`. Aquí, el procedimiento operativo. Despliegues: `release-rollback-coolify.md`.

Objetivos de SPECS §9.3: RPO ≤ 15 min, RTO ≤ 4 h. Diseño: dump diario más binlogs cerrados cada 900 s, retención 35 días, volumen `opslog-backups` en el mismo VPS. Las cifras del simulacro (`pnpm ops:drill`, ver el paquete `MVP-OPS-M5-20261019`) se midieron con datos sintéticos y MySQL 8.0.46; no son el RTO de una instalación real.

## 1. Qué hay que proteger

| Elemento                                                                      | Dónde                                                  | Nota                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| Dumps y binlogs                                                               | volumen `opslog-backups`                               | mismo VPS que la base: no protege de perder el VPS                 |
| `OPSLOG_PII_MASTER_KEY`                                                       | secretos de Coolify **y** gestor de secretos aparte    | sin ella, los datos personales restaurados no se pueden leer       |
| `OPSLOG_MYSQL_SECRET`, `OPSLOG_MYSQL_ROOT_PASSWORD`, `OPSLOG_BACKUP_PASSWORD` | gestor de secretos                                     |                                                                    |
| `OPSLOG_EXPORT_KEY`                                                           | solo en el entorno del shell mientras corre el comando | cifra los archivos de exportación; no va en argumentos ni en disco |

Una copia fuera del host (por ejemplo un bucket S3 con prefijo e IAM nuevos) es decisión del propietario y no está hecha: hoy perder el VPS es perder datos y copias a la vez.

## 2. Comprobación periódica (semanal)

```bash
docker compose exec backup /opt/opslog-ops/backup/backup.sh health   # 0 = binlogs al día
docker compose exec backup sh -c 'ls -l /backups/dumps | tail -n 3'
```

La salud del contenedor `backup` también la vigila Coolify (alerta de contenedor en mal estado, ver `incident-response.md`). Un simulacro de restauración completo (sección 3) se ejecuta al menos una vez por trimestre y tras cada cambio de versión de MySQL; se anota el tiempo real.

## 3. Restaurar a un instante

Nunca sobre la instancia principal. Se restaura en una instancia temporal, se verifica y solo entonces se decide copiar.

1. Anotar el instante objetivo en UTC (justo antes del daño) y el motivo. Si hay un incidente, el responsable lo aprueba (`incident-response.md`).
2. Localizar el volumen: `docker volume inspect <proyecto>_opslog-backups`.
3. Instancia temporal, restauración y verificación:

```bash
eval "$(infra/operations/restore/temp-instance.sh start restore 3390 docker)"
infra/operations/restore/restore.sh --backup-dir /ruta/al/volumen \
  --host 127.0.0.1 --port 3390 --until '2026-10-19 14:30:00' --report restauracion.txt
```

El informe lista dump, binlogs aplicados, tablas, filas y `verified`. `restore.sh` se niega con un binlog faltante o alterado y con un destino que ya tenga bases `opslog_t_*`. 4. Humo con la API en solo lectura contra la copia (usa las claves de la instalación de origen):

```bash
OPSLOG_MYSQL_SECRET=... OPSLOG_PII_MASTER_KEY=... \
  node infra/operations/restore/smoke.mjs --temporary --bundle apps/api/server/bundle --port 3390 --database opslog_t_main
```

5. Si la copia es correcta y hay que volver a producción, aplicar el procedimiento «Copiar una empresa restaurada a la instancia principal» de `infra/operations/README.md`: dump de la temporal, copia de la base actual (`previa.sql`) y carga con la API detenida; si la carga falla, se vuelve a `previa.sql`.
6. Detener y borrar la instancia temporal: `infra/operations/restore/temp-instance.sh stop restore`.
7. Registrar RPO real (instante restaurado contra último dato conocido) y RTO real (inicio a verificación).

Una restauración de empresa es la restauración de su base: con una empresa por despliegue, la instancia temporal contiene solo esa empresa.

## 4. Exportación completa de empresa (NFR-B5)

Bajo demanda y al terminar el contrato. Produce un archivo `.opsx` con JSON y CSV por entidad, los objetos (archivos) liberados y un manifiesto de sumas SHA-256. Los datos personales aparecen en claro **solo dentro** de ese archivo, que está cifrado (AES-256-GCM) con una clave que da el operador.

Autorización: el responsable aprueba por escrito con un identificador de ticket. El operador es una persona nombrada (no una cuenta compartida).

**Paso 1. Clave del archivo.** Generarla fuera del VPS y guardarla en el gestor de secretos del operador: `openssl rand -base64 32` (base64 canónico de exactamente 32 bytes; otra forma se rechaza). Hace falta para exportar y para verificar o extraer. Perderla vuelve inservible el archivo.

**Paso 2. Exportar.** Se ejecuta dentro de la imagen de `api` (lleva el paquete en `./tenant-export`). Las variables del compose ya dan host, base y clave de PII. La clave del archivo y la contraseña de respaldo **no se escriben en la línea de comandos**: `-e NOMBRE` sin valor las toma del entorno del shell, de modo que no aparecen en los argumentos del proceso (`ps`, historial). Cargarlas en el shell sin eco, solo mientras corre el comando:

```bash
read -rs OPSLOG_EXPORT_KEY && read -rs OPSLOG_BACKUP_PASSWORD && export OPSLOG_EXPORT_KEY OPSLOG_BACKUP_PASSWORD
docker compose exec api mkdir -p /tmp/export
docker compose exec -T -e OPSLOG_EXPORT_KEY -e OPSLOG_BACKUP_PASSWORD \
  api node tenant-export/tenant-export.mjs export \
  --out /tmp/export --operator <identificador-operador> --reason <ticket>
echo "salida=$?"
unset OPSLOG_EXPORT_KEY OPSLOG_BACKUP_PASSWORD
```

Se lee con la cuenta `opslog_backup` (solo SELECT) dentro de una instantánea consistente. Con `OPSLOG_OBJECT_STORAGE=s3` se incluyen los archivos liberados y verificados por SHA-256; con `memory` el archivo no contiene objetos y el resumen lo dice.

**Paso 3. Resultado.** La salida son líneas JSON con la ruta del archivo, su SHA-256 y un resumen **sin datos personales**. Código de salida: **0** = completa; **3** = **incompleta** (un objeto faltante o corrupto; el archivo existe pero no se entrega como exportación completa: corregir la causa y repetir); **1** = error (no queda archivo); **2** = argumentos incorrectos.

**Paso 4. Sacar del contenedor, antes de borrar nada.** Copiar el archivo, su resumen y la auditoría (`export-audit.jsonl`, que es la única copia de la auditoría de la ejecución):

```bash
docker compose cp api:/tmp/export ./export-<ticket>
ls export-<ticket>   # opslog-export-<fecha>-<id>.opsx, .summary.json y export-audit.jsonl
```

Solo con los tres archivos copiados y el SHA-256 coincidente (`sha256sum` del `.opsx` contra el de la salida), borrar el directorio del contenedor: `docker compose exec api rm -rf /tmp/export`.

**Paso 5. Verificar antes de entregar**, en la máquina del operador. `verify` necesita el programa: copiarlo de la imagen y ejecutarlo con la clave en el entorno:

```bash
docker compose cp api:/app/tenant-export ./tenant-export
read -rs OPSLOG_EXPORT_KEY && export OPSLOG_EXPORT_KEY
node tenant-export/tenant-export.mjs verify --archive export-<ticket>/opslog-export-<fecha>-<id>.opsx
unset OPSLOG_EXPORT_KEY
```

`verify` descifra, comprueba cada suma del manifiesto, el conteo de filas contra el manifiesto y que no haya entradas sin listar. Una clave equivocada, un archivo truncado o reordenado se rechazan.

**Paso 6. Entrega.** Transferir el archivo por un canal acordado con el cliente y **entregar la clave por un canal distinto**.

**Paso 7. Auditoría.** `export-audit.jsonl` recoge los eventos iniciado, completado, incompleto o fallido (con referencias opacas del operador y del ticket, sin datos personales). Conservarlo con el ticket.

**Paso 8. Extraer (opcional).** `extract --archive ... --out <directorio nuevo>` descomprime a archivos planos con datos personales en claro: solo en una máquina de confianza, con permisos mínimos y borrado al terminar. Verifica el archivo y exige que el archivo extraído sea el mismo que se verificó.

Exclusiones por diseño: secretos de webhooks sellados, credenciales y tokens no se exportan. El formato propio del contenedor es una desviación documentada en el paquete (no es ZIP).

## 5. Fallos frecuentes

| Síntoma                                   | Causa probable                                                  | Acción                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `health` falla                            | el binlog no se copia hace más de 3 intervalos                  | revisar logs de `backup`, espacio del volumen y conectividad con `mysql`; ejecutar `backup.sh binlogs` |
| `restore.sh` rechaza un binlog            | hueco o suma alterada                                           | usar un instante anterior al hueco; investigar como incidente                                          |
| Datos personales ilegibles tras restaurar | `OPSLOG_PII_MASTER_KEY` distinta                                | recuperar la clave original del gestor de secretos                                                     |
| Exportación `missing_setting`             | falta una variable (clave del archivo o contraseña de respaldo) | revisar el entorno del comando                                                                         |
| Exportación `unclassified_table`          | tabla nueva sin disposición                                     | corregir `catalog.ts` del exportador; no exportar parcialmente                                         |
