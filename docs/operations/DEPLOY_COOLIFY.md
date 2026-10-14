# Demo en Coolify (staging, datos sintéticos)

> **Solo demo.** OPSLOG no se opera como servicio propio: esta pila existe para enseñar el producto en un subdominio de prueba. No es producción (`OPSLOG_ENV=staging`, el proceso se niega a arrancar con `NODE_ENV=production`).

## Qué se despliega

`docker-compose.yml` (raíz) define tres servicios; las imágenes salen de `deploy/Dockerfile`.

| Servicio | Qué es                                                                                               | Notas                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `web`    | nginx con la web compilada. Reenvía `/api/` a `api` (mismo origen: cookie de sesión y CSRF del BFF). | Único servicio con dominio público, puerto 80.                                 |
| `api`    | BFF HTTP + plataforma + worker, en un solo proceso (`apps/api/server`).                              | Sin puerto público. Health check: `GET /healthz`.                              |
| `mysql`  | MySQL 8.4 con volumen `mysql-data`, sin puerto publicado.                                            | **Preparado, todavía sin uso**: la API aún no se conecta (ver «Limitaciones»). |

El worker corre dentro de `api` porque hoy todos los adaptadores son en memoria: la cola, la auditoría y los escaneos viven en ese proceso y un contenedor aparte no los vería. Se separa cuando exista persistencia en MySQL.

## Variables de entorno

Se definen en Coolify (Environment Variables de la aplicación) o en un `.env` local (`deploy/variables.example`). Nunca se versionan valores reales.

| Variable                                                                                         | Obligatoria   | Qué es                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPSLOG_PUBLIC_ORIGIN`                                                                           | sí            | Origen público con https, sin ruta: `https://opslog.northsoftmx.com`. El BFF solo acepta peticiones de ese origen.                                                                              |
| `OPSLOG_BFF_SECRET`                                                                              | sí            | Secreto de CSRF y cursores, 32+ caracteres (`openssl rand -base64 48`).                                                                                                                         |
| `OPSLOG_GRANT_SECRET`                                                                            | sí            | Secreto de las descargas firmadas, 32+ caracteres. Distinto del anterior.                                                                                                                       |
| `OPSLOG_MYSQL_ROOT_PASSWORD`                                                                     | sí            | Contraseña root de MySQL.                                                                                                                                                                       |
| `OPSLOG_OBJECT_STORAGE`                                                                          | no            | `memory` (por defecto) o `s3`. Con `s3` son obligatorias las cuatro siguientes.                                                                                                                 |
| `OPSLOG_S3_BUCKET`, `OPSLOG_S3_REGION`, `OPSLOG_S3_ACCESS_KEY_ID`, `OPSLOG_S3_SECRET_ACCESS_KEY` | solo con `s3` | Bucket privado de staging y credenciales de la aplicación (usuario IAM acotado a `tenants/*`). Se cargan como secretos en Coolify; nunca se versionan.                                          |
| `OPSLOG_AUTH_MODE`                                                                               | no            | `cognito` (por defecto en el compose: inicio de sesión real, exige las `OPSLOG_OIDC_*`) o `synthetic` (solo local: nadie puede entrar de verdad). El servidor solo arranca con valores válidos. |
| `OPSLOG_OIDC_ISSUER`                                                                             | con `cognito` | `https://cognito-idp.<región>.amazonaws.com/<id del user pool>`.                                                                                                                                |
| `OPSLOG_OIDC_DOMAIN`                                                                             | con `cognito` | Dominio del Hosted UI: `https://<prefijo>.auth.<región>.amazoncognito.com`. También se usa al compilar la web (`VITE_OIDC_DOMAIN`).                                                             |
| `OPSLOG_OIDC_CLIENT_ID`                                                                          | con `cognito` | Id del app client. También se usa al compilar la web (`VITE_OIDC_CLIENT_ID`); no es secreto.                                                                                                    |
| `OPSLOG_OIDC_CLIENT_SECRET`                                                                      | con `cognito` | Secreto del app client (cliente confidencial). Solo lo lee la API; cargarlo como secreto en Coolify.                                                                                            |
| `OPSLOG_OIDC_REDIRECT_URI`                                                                       | con `cognito` | Exactamente `OPSLOG_PUBLIC_ORIGIN` + `/auth/callback` (`https://opslog.northsoftmx.com/auth/callback`).                                                                                         |
| `OPSLOG_BOOTSTRAP_COMPANY`, `OPSLOG_BOOTSTRAP_ADMIN_SUB`                                         | opcionales    | Nombre de la primera empresa y `sub` de Cognito de su administrador. Se definen las dos o ninguna. Ver «Primer administrador».                                                                  |

`OPSLOG_ENV=staging` ya está fijo en el compose. No definir `AWS_*` ni `NODE_ENV=production`: la guarda de arranque lo rechaza. Las claves de S3 van como `OPSLOG_S3_*`, no `AWS_*`.

## Pasos en Coolify

1. **DNS (GoDaddy):** en el dominio `northsoftmx.com`, crear un registro **A**: Nombre `opslog`, Valor = IP pública del VPS, TTL 600. Comprobar con `nslookup opslog.northsoftmx.com`.
2. **Nueva aplicación:** Projects → New Resource → Public/Private Repository (GitHub) → repositorio `aleiruiz/OPSLOG`, rama `main` → **Build Pack: Docker Compose**, archivo `/docker-compose.yml`.
3. **Dominio:** en el servicio `web`, Domains = `https://opslog.northsoftmx.com` (Coolify pide el certificado a Let's Encrypt; el VPS debe tener abiertos 80 y 443). Los demás servicios sin dominio.
4. **Variables:** cargar las cuatro obligatorias de la tabla (dos secretos generados con `openssl rand -base64 48`).
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

2. Definir `OPSLOG_BOOTSTRAP_COMPANY` (nombre de la empresa) y `OPSLOG_BOOTSTRAP_ADMIN_SUB` (ese `sub`) y redesplegar. Al arrancar, la API crea la empresa y le da rol administrador; escribe una línea `bootstrap_created …` (o `bootstrap_skipped …` si ese sub ya tiene membresía activa) sin datos personales. Es idempotente, así que puede dejarse configurado; con el estado en memoria se repite en cada reinicio.
3. Entrar en `https://opslog.northsoftmx.com`; desde ahí el administrador invita al resto.

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
- **Estado en memoria:** reiniciar `api` borra empresas, usuarios y datos. MySQL está desplegado pero sin conectar: la persistencia (control de tenants e identidad, y la base por empresa con sus cuentas y migraciones) es un cambio aparte, y ahí se añadirán las migraciones al desplegar.
- **Archivos:** en memoria salvo que se active `OPSLOG_OBJECT_STORAGE=s3` (adaptador S3 ya disponible; no probado contra AWS real desde aquí).
