# Demo en Coolify (staging, datos sintéticos)

> **Solo demo.** OPSLOG no se opera como servicio propio: esta pila existe para enseñar el producto en un subdominio de prueba. No es producción (`OPSLOG_ENV=staging`, el proceso se niega a arrancar con `NODE_ENV=production`).

## Qué se despliega

`docker-compose.yml` (raíz) define cinco servicios; las imágenes salen de `deploy/Dockerfile`.

| Servicio  | Qué es                                                                                               | Notas                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `web`     | nginx con la web compilada. Reenvía `/api/` a `api` (mismo origen: cookie de sesión y CSRF del BFF). | Único servicio con dominio público, puerto 80.                              |
| `api`     | BFF HTTP + plataforma + worker, en un solo proceso (`apps/api/server`).                              | Sin puerto público. Health check: `GET /healthz`.                           |
| `mysql`   | MySQL 8.4 con volumen `mysql-data`, sin puerto publicado.                                            | Guarda todos los datos con `OPSLOG_PERSISTENCE=mysql` (por defecto).        |
| `migrate` | Trabajo de una sola ejecución (misma imagen que `api`, `node migrate.mjs`).                          | Se ejecuta en cada despliegue antes de `api` y termina; ver «Persistencia». |
| `landing` | Página de ventas con el formulario «Solicitar demo» (`apps/landing`).                                | Dominio propio; ver [LANDING.md](LANDING.md).                               |

El worker sigue dentro de `api`: la cola de escaneos y el relevo de auditoría comparten proceso con la API y se coordinan con las tablas de MySQL (outbox y auditoría duraderos), así que una réplica única basta. Separarlo en otro contenedor queda para cuando haga falta. Los planes de mantenimiento se escanean cada hora en ese mismo proceso (`worker.planScanIntervalMs`), lo que genera las órdenes preventivas vencidas.

## Variables de entorno

Se definen en Coolify (Environment Variables de la aplicación) o en un `.env` local (`deploy/variables.example`). Nunca se versionan valores reales.

| Variable                                                                                         | Obligatoria   | Qué es                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPSLOG_PUBLIC_ORIGIN`                                                                           | sí            | Origen público con https, sin ruta: `https://opslog.northsoftmx.com`. El BFF solo acepta peticiones de ese origen.                                                                                |
| `OPSLOG_BFF_SECRET`                                                                              | sí            | Secreto de CSRF y cursores, 32+ caracteres (`openssl rand -base64 48`).                                                                                                                           |
| `OPSLOG_GRANT_SECRET`                                                                            | sí            | Secreto de las descargas firmadas, 32+ caracteres. Distinto del anterior.                                                                                                                         |
| `OPSLOG_MYSQL_ROOT_PASSWORD`                                                                     | sí            | Contraseña root de MySQL. Solo la usa `migrate`; la API nunca recibe credenciales de administrador.                                                                                               |
| `OPSLOG_PERSISTENCE`                                                                             | no            | `mysql` (por defecto en el compose) o `memory`. Con `memory` se pierde todo al reiniciar (solo pruebas desechables).                                                                              |
| `OPSLOG_MYSQL_SECRET`                                                                            | con `mysql`   | Secreto raíz, 32+ caracteres (`openssl rand -base64 48`), del que se derivan (HMAC-SHA256) las contraseñas de las cuentas restringidas de MySQL.                                                  |
| `OPSLOG_PII_MASTER_KEY`                                                                          | con `mysql`   | Clave maestra del KMS local que sella datos personales: base64 de 32+ bytes (`openssl rand -base64 32`). **Hacer copia: ver «Persistencia».**                                                     |
| `OPSLOG_MYSQL_DATABASE`                                                                          | no            | Base de datos de la empresa, con nombre `opslog_t_<nombre>` (por defecto `opslog_t_main`). `OPSLOG_MYSQL_HOST` (por defecto `mysql`) y `OPSLOG_MYSQL_PORT` (3306) solo cambian fuera del compose. |
| `OPSLOG_OBJECT_STORAGE`                                                                          | no            | `memory` (por defecto) o `s3`. Con `s3` son obligatorias las cuatro siguientes.                                                                                                                   |
| `OPSLOG_S3_BUCKET`, `OPSLOG_S3_REGION`, `OPSLOG_S3_ACCESS_KEY_ID`, `OPSLOG_S3_SECRET_ACCESS_KEY` | solo con `s3` | Bucket privado de staging y credenciales de la aplicación (usuario IAM acotado a `tenants/*`). Se cargan como secretos en Coolify; nunca se versionan.                                            |
| `OPSLOG_AUTH_MODE`                                                                               | no            | `cognito` (por defecto en el compose: inicio de sesión real, exige las `OPSLOG_OIDC_*`) o `synthetic` (solo local: nadie puede entrar de verdad). El servidor solo arranca con valores válidos.   |
| `OPSLOG_OIDC_ISSUER`                                                                             | con `cognito` | `https://cognito-idp.<región>.amazonaws.com/<id del user pool>`.                                                                                                                                  |
| `OPSLOG_OIDC_DOMAIN`                                                                             | con `cognito` | Dominio del Hosted UI: `https://<prefijo>.auth.<región>.amazoncognito.com`. También se usa al compilar la web (`VITE_OIDC_DOMAIN`).                                                               |
| `OPSLOG_OIDC_CLIENT_ID`                                                                          | con `cognito` | Id del app client. También se usa al compilar la web (`VITE_OIDC_CLIENT_ID`); no es secreto.                                                                                                      |
| `OPSLOG_OIDC_CLIENT_SECRET`                                                                      | con `cognito` | Secreto del app client (cliente confidencial). Solo lo lee la API; cargarlo como secreto en Coolify.                                                                                              |
| `OPSLOG_OIDC_REDIRECT_URI`                                                                       | con `cognito` | Exactamente `OPSLOG_PUBLIC_ORIGIN` + `/auth/callback` (`https://opslog.northsoftmx.com/auth/callback`).                                                                                           |
| `OPSLOG_BOOTSTRAP_COMPANY`, `OPSLOG_BOOTSTRAP_ADMIN_SUB`                                         | opcionales    | Nombre de la primera empresa y `sub` de Cognito de su administrador. Se definen las dos o ninguna. Ver «Primer administrador».                                                                    |

`OPSLOG_ENV=staging` ya está fijo en el compose. No definir `AWS_*` ni `NODE_ENV=production`: la guarda de arranque lo rechaza. Las claves de S3 van como `OPSLOG_S3_*`, no `AWS_*`.

## Pasos en Coolify

1. **DNS (GoDaddy):** en el dominio `northsoftmx.com`, crear un registro **A**: Nombre `opslog`, Valor = IP pública del VPS, TTL 600. Comprobar con `nslookup opslog.northsoftmx.com`.
2. **Nueva aplicación:** Projects → New Resource → Public/Private Repository (GitHub) → repositorio `aleiruiz/OPSLOG`, rama `main` → **Build Pack: Docker Compose**, archivo `/docker-compose.yml`.
3. **Dominio:** en el servicio `web`, Domains = `https://opslog.northsoftmx.com` (Coolify pide el certificado a Let's Encrypt; el VPS debe tener abiertos 80 y 443). Los demás servicios sin dominio, salvo `landing` (ver [LANDING.md](LANDING.md)).
4. **Variables:** cargar las obligatorias de la tabla: los dos secretos del BFF, `OPSLOG_MYSQL_ROOT_PASSWORD`, `OPSLOG_MYSQL_SECRET` y `OPSLOG_PII_MASTER_KEY` (generados con `openssl rand`, ver `deploy/variables.example`). Guardar `OPSLOG_PII_MASTER_KEY` y `OPSLOG_MYSQL_ROOT_PASSWORD` en un gestor de secretos.
5. **Deploy.** La primera construcción es lenta y usa unos 3 GB de RAM mientras compila la web; conviene hacerla cuando el VPS (compartido con otras apps) esté tranquilo.
6. Comprobar `https://opslog.northsoftmx.com/healthz` (nginx) y `https://opslog.northsoftmx.com/api/auth/csrf` (JSON con `csrfToken`, llega hasta la API).

## Inicio de sesión con Cognito

1. En el app client de Cognito (cliente confidencial, flujo authorization code con PKCE, scopes `openid email`) registrar:
   - Callback URL: `https://opslog.northsoftmx.com/auth/callback`
   - Sign-out URL: `https://opslog.northsoftmx.com/`
2. Cargar en Coolify las variables `OPSLOG_OIDC_*` de la tabla anterior. `OPSLOG_OIDC_DOMAIN` y `OPSLOG_OIDC_CLIENT_ID` deben estar disponibles **en tiempo de build** (en Coolify, marcar «Available at Buildtime»): el compose las pasa como build args `VITE_OIDC_DOMAIN` y `VITE_OIDC_CLIENT_ID` a la imagen `web`. Si faltan, la web de producción falla cerrada («El inicio de sesión no está disponible»). Cambiarlas exige reconstruir `web`.
3. Cognito es solo por invitación y la pila arranca vacía, por lo que hace falta el primer administrador.

### Primer administrador

1. Crear el usuario en el user pool (Cognito invita por correo) y obtener su `sub`:

   ```sh
   aws cognito-idp admin-get-user --user-pool-id <id del pool> --username <correo> \
     --query "UserAttributes[?Name=='sub'].Value" --output text
   ```

2. Definir `OPSLOG_BOOTSTRAP_COMPANY` (nombre de la empresa) y `OPSLOG_BOOTSTRAP_ADMIN_SUB` (ese `sub`) y redesplegar. Al arrancar, la API crea la empresa y le da rol administrador; escribe una línea `bootstrap_created …` (o `bootstrap_skipped …` si ese sub ya tiene membresía activa) sin datos personales. Es idempotente, así que puede dejarse configurado: con `OPSLOG_PERSISTENCE=mysql` el administrador sigue pudiendo entrar tras un reinicio y no se crea otra empresa; con `memory` se repite en cada reinicio.
3. Entrar en `https://opslog.northsoftmx.com`; desde ahí el administrador invita al resto.

## Persistencia (MySQL)

Con `OPSLOG_PERSISTENCE=mysql` la API conserva en MySQL, tras `docker compose restart api` o un redespliegue: la empresa, las personas con acceso y sus roles, las sesiones abiertas, los ajustes de la empresa (nombre, MFA, horas de inactividad), la auditoría y los datos de negocio (áreas, vehículos, empleados, documentos, seguros, asignaciones, importaciones, mantenimiento, siniestros y los metadatos de archivos).

- **Una empresa por despliegue.** Es el modelo «una base por empresa»: la primera vez que arranca, la API reserva el identificador de la empresa y fija su base (`opslog_t_main`). La empresa se crea con el primer alta (`bootstrapTenant`); una segunda se rechaza. Si un alta falla a medias, la misma empresa se puede reintentar.
- **`migrate` (trabajo único, idempotente).** Con la cuenta root crea la base si falta, aplica todas las migraciones (vehículos, áreas, empleados, documentos, seguros, asignaciones, ajustes, importaciones, archivos, mantenimiento, siniestros, auditoría, identidad y plano de control) y crea las cuentas de ejecución con permisos por tabla. Se vuelve a ejecutar en cada despliegue sin riesgo; `api` solo arranca si terminó bien (`service_completed_successfully`). Las cuentas de la API nunca ejecutan DDL.
- **Cuentas.** Hay unas 16 cuentas de MySQL (`opslog_<módulo>_app`, `opslog_identity_app`, …) porque cada módulo exige su propia cuenta restringida. Sus contraseñas salen de `OPSLOG_MYSQL_SECRET`; si se rota el secreto, el siguiente despliegue (`migrate`) vuelve a fijarlas y `api` arranca con las nuevas.
- **Cuentas migradoras bloqueadas.** Las cuentas con DDL (`opslog_*_migrator_*`) quedan con `ACCOUNT LOCK` al terminar `migrate`; solo se desbloquean mientras corre, para que una API comprometida (que conoce `OPSLOG_MYSQL_SECRET`) no pueda iniciar sesión con ellas.
- **Una sola réplica de `api`.** Las sesiones, el directorio de accesos y el trabajo en segundo plano viven en el proceso: no escalar `api` a más de una réplica.
- **Actualizar un despliegue existente.** Antes de redesplegar una app ya creada, definir `OPSLOG_MYSQL_SECRET` y `OPSLOG_PII_MASTER_KEY` (sin ellas `api` no arranca con `mysql`), o fijar `OPSLOG_PERSISTENCE=memory` para conservar el comportamiento anterior.
- **Reinicio.** Al arrancar, la API vuelve a cargar la empresa, las membresías y los roles; quien tenía sesión sigue con ella (la sesión también está en la base) y quien no, vuelve a iniciar sesión con la misma identidad. El alta inicial (`OPSLOG_BOOTSTRAP_COMPANY` / `OPSLOG_BOOTSTRAP_ADMIN_SUB`) sigue siendo idempotente: tras un reinicio el inicio de sesión del administrador funciona y no se vuelve a crear la empresa. Si la empresa ya existe pero el `sub` configurado ya no puede entrar (se le quitó la membresía o se cambió el `sub`), la API arranca igual y escribe `bootstrap_skipped company already exists (configured admin cannot sign in)`.
- **Copia de seguridad.** Respaldar el volumen `mysql-data` (por ejemplo `mysqldump` de `opslog_t_main`) **y** `OPSLOG_PII_MASTER_KEY`. Sin esa clave, los datos personales ya guardados (empleados, terceros de siniestros) no se pueden volver a leer; no hay forma de recuperarlos. Esa clave es del KMS local de desarrollo: sirve para esta demo (se niega a arrancar en producción), no para producción.
- **Conexiones.** La API abre 2 conexiones por módulo (unas 32 en total), pensado para la VPS pequeña y compartida; MySQL arranca con un buffer de 128 MB.

Lo que sigue en memoria (y su consecuencia):

- **Invitaciones pendientes:** tras reiniciar `api`, un enlace de invitación sin aceptar deja de funcionar (falla cerrado: «no encontrado»); el administrador debe volver a invitar. Las personas ya incorporadas no se ven afectadas, y los miembros dados de baja dejan de aparecer en el listado de miembros.
- **Borradores de formularios** (`DraftStore`): se pierden al reiniciar.
- **Contenido de los archivos:** con `OPSLOG_OBJECT_STORAGE=memory` se pierde (los metadatos sí se conservan y quedarían apuntando a nada). Para conservar archivos, usar `s3`.
- **Escáner de virus y correo de avisos:** siguen siendo los sintéticos de staging.

## Prueba local

Aviso para una app de Coolify ya creada: el compose usa `cognito` por defecto, así que sin las `OPSLOG_OIDC_*` la API no arranca y el error nombra la variable que falta.

```sh
cp deploy/variables.example .env   # rellenar los secretos; trae OPSLOG_AUTH_MODE=synthetic
docker compose -f docker-compose.yml -f deploy/compose.local.yml up --build
# http://localhost:8081/healthz  y  http://localhost:8081/api/auth/csrf
```

Para construir detrás de un proxy que inspecciona TLS: `docker build --secret id=extra-ca,src=ca.pem ...`.

## Limitaciones actuales (honestas)

- **Inicio de sesión:** real con Cognito cuando `OPSLOG_AUTH_MODE=cognito` y las variables `OPSLOG_OIDC_*` están completas (también como build args de la web). Con `synthetic` nadie puede entrar de verdad.
- **Estado en memoria solo con `OPSLOG_PERSISTENCE=memory`:** en ese modo reiniciar `api` borra empresas, usuarios y datos. Con `mysql` (por defecto) persiste lo descrito en «Persistencia», salvo lo que allí se lista como memoria.
- **Archivos:** en memoria salvo que se active `OPSLOG_OBJECT_STORAGE=s3` (adaptador S3 ya disponible; no probado contra AWS real desde aquí).
