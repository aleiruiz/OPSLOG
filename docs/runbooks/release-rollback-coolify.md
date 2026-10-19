# Runbook: despliegue y rollback en Coolify

Alcance: la pila de la etapa 0 (ADR-0016 §3): Docker Compose en un VPS con Coolify, una empresa por despliegue, una sola réplica de `api` con el worker dentro. Variables y alta inicial: `docs/operations/DEPLOY_COOLIFY.md`. Respaldo: `backup-restore.md`. Incidentes: `incident-response.md`.

Roles: **operador** (ejecuta), **responsable** (aprueba el despliegue y decide un rollback). Pueden ser la misma persona en una instalación pequeña; entonces se anota igualmente quién decidió.

## 0. Antes de empezar

1. Hay un commit o tag candidato con CI verde en `main`. Se despliega **un commit o tag concreto**, nunca «lo último de la rama» sin anotar cuál.
2. Anotar el commit actualmente desplegado (Coolify, pestaña Deployments) como `COMMIT_ANTERIOR`. Es el destino del rollback.
3. Si el cambio incluye migraciones, leer la sección «Migraciones expand/contract» y confirmar que son compatibles con `COMMIT_ANTERIOR`.
4. Si hay caída previsible, anunciarla con 72 h de antelación y fuera del horario operativo de la mayoría de las empresas (NFR-A4; ver `incident-response.md`). El despliegue normal de la etapa 0 reinicia `api` unos segundos; una instancia única no ofrece despliegue sin caída (pendiente de lanzamiento, `customer-aws.md`).

## 1. Respaldo previo (obligatorio)

No se despliega sin un respaldo completo reciente tomado **después** de anunciar la ventana y justo antes de desplegar.

```bash
docker compose exec backup /opt/opslog-ops/backup/backup.sh dump
docker compose exec backup /opt/opslog-ops/backup/backup.sh binlogs
docker compose exec backup sh -c 'ls -l /backups/dumps | tail -n 4'   # el dump nuevo y su .sha256
docker compose exec backup /opt/opslog-ops/backup/backup.sh health
```

Criterios: el dump nuevo existe con su `.sha256` y su `.meta`, `health` termina en 0 y `OPSLOG_PII_MASTER_KEY` está guardada fuera del VPS (sin ella la copia no devuelve datos personales legibles). Si `OPSLOG_BACKUP_PASSWORD` no está definida el servicio `backup` está inactivo: **parar**, definirla y repetir; no se despliega sin respaldo.

Anotar en el registro de cambios: fecha UTC, nombre del dump y quién lo comprobó.

## 2. Desplegar un commit o tag

1. En Coolify, la aplicación debe apuntar al commit o tag (campo de rama/commit del recurso) o desplegarse desde la pestaña Deployments con ese commit. Anotar el SHA.
2. Pulsar **Deploy**. El compose ejecuta en orden: `migrate` (trabajo único, idempotente) → `api` (solo arranca si `migrate` terminó bien) → `web`.
3. Vigilar los logs de `migrate` y `api` (una línea JSON por evento; filtrar por `msg`).

### Verificación posterior (obligatoria)

| Comprobación                                                                                                                  | Esperado                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `https://<dominio>/healthz`                                                                                                   | 200                                                                                    |
| `docker compose ps`                                                                                                           | `api` en estado healthy (su healthcheck usa `/readyz`); `mysql` y `backup` sanos       |
| `docker compose exec api node -e "fetch('http://127.0.0.1:8080/readyz').then(async r=>console.log(r.status,await r.text()))"` | `200 {"status":"ready"}`; un 503 trae el código de la causa (MySQL, migración, worker) |
| Logs de `api`                                                                                                                 | `api_listening`; ningún `readyz_failed` sostenido ni `worker_tick_failed` repetido     |
| Inicio de sesión de una cuenta de prueba y una lectura de lista                                                               | funciona                                                                               |
| `ops_stats` (una línea por minuto)                                                                                            | outbox y DLQ sin crecimiento anómalo                                                   |

`/readyz` no se publica hacia fuera (nginx); se consulta dentro de la pila. Si algo falla, pasar a la sección 4 sin improvisar.

## 3. Migraciones expand/contract

Las migraciones son aditivas y se aplican en cada despliegue antes de arrancar `api`. Para poder volver atrás **sin revertir datos**, un cambio de esquema se reparte en despliegues separados:

1. **Expand** (despliegue N): añadir tablas, columnas nulas o con valor por defecto e índices. La versión N-1 del código sigue funcionando con el esquema nuevo. La versión N escribe en ambos lugares si hace falta.
2. **Migrar datos**: rellenar lo nuevo (trabajo idempotente, por lotes).
3. **Contract** (despliegue N+k, solo cuando N ya lleva estable un periodo acordado): eliminar lo antiguo, volver obligatoria una columna o borrar el código de compatibilidad.

Reglas:

- Nunca renombrar ni eliminar una columna o tabla en el mismo despliegue que deja de usarla. Un contract es irreversible por rollback de aplicación: lleva su propio respaldo previo y su propio anuncio.
- `readyz` acepta una última migración **igual o posterior** a la esperada por la imagen. Por eso una imagen anterior sigue «lista» sobre un esquema más nuevo (necesario para el rollback de aplicación).
- Las cuentas de la API no ejecutan DDL: el esquema solo cambia desde `migrate`.
- Si el cambio no puede ser expand/contract (una conversión que rompe la lectura anterior), no hay rollback de aplicación posible: el plan es restaurar (sección 5). Declararlo en la solicitud de despliegue y exigir ventana anunciada.

## 4. Rollback de aplicación (sin revertir datos)

Cuándo: el despliegue arranca pero se comporta mal (errores, `readyz` en 503 sostenido, regresión funcional) y **no se perdieron ni corrompieron datos**.

1. El responsable decide el rollback. Anotar hora UTC y motivo.
2. En Coolify desplegar `COMMIT_ANTERIOR` (Deployments → redeploy de ese commit, o fijar el commit/tag anterior y Deploy).
3. `migrate` vuelve a correr con el código anterior: es idempotente y **no revierte** el esquema nuevo ni los datos. La imagen anterior arranca porque `readyz` acepta migraciones posteriores.
4. Repetir la verificación posterior de la sección 2.
5. Los datos escritos por la versión mala permanecen. Si esa versión escribió datos que la anterior no entiende, no seguir: ir a la sección 5.

El rollback no ejecuta `DROP` ni restaura dumps. Una columna nueva queda sin uso hasta el siguiente intento.

## 5. Cuándo restaurar (en lugar de hacer rollback)

Restaurar solo si hay pérdida o corrupción de datos, un contract aplicado que debe deshacerse, o la base no arranca. Es una decisión del responsable, con aviso a los clientes (`incident-response.md`).

1. Parar escrituras: `docker compose stop api web`. Se mantiene `mysql`.
2. Seguir `backup-restore.md` (restauración a un instante en instancia temporal, verificación de conteos y sumas, copia manual a la principal con la copia previa de la base actual).
3. Desplegar el commit compatible con el esquema restaurado (normalmente `COMMIT_ANTERIOR`).
4. Verificación posterior (sección 2) y comunicación del RPO real: lo escrito después del último instante restaurado se perdió.

## 6. Reglas de oro

- Respaldo antes, verificación después, ambos anotados.
- Un commit o tag concreto; el anterior siempre conocido.
- Rollback de aplicación primero; restauración solo con motivo de datos.
- Nada de `docker compose down -v` ni borrar volúmenes (`mysql-data`, `opslog-backups`).
- No escalar `api` a más de una réplica.
