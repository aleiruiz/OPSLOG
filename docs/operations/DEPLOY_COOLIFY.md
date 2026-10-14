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

Se definen en Coolify (Environment Variables de la aplicación) o en un `.env` local (`.env.example`). Nunca se versionan valores reales.

| Variable                     | Obligatoria | Qué es                                                                                                                                       |
| ---------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPSLOG_PUBLIC_ORIGIN`       | sí          | Origen público con https, sin ruta: `https://opslog.northsoftmx.com`. El BFF solo acepta peticiones de ese origen.                           |
| `OPSLOG_BFF_SECRET`          | sí          | Secreto de CSRF y cursores, 32+ caracteres (`openssl rand -base64 48`).                                                                      |
| `OPSLOG_GRANT_SECRET`        | sí          | Secreto de las descargas firmadas, 32+ caracteres. Distinto del anterior.                                                                    |
| `OPSLOG_MYSQL_ROOT_PASSWORD` | sí          | Contraseña root de MySQL.                                                                                                                    |
| `OPSLOG_AUTH_MODE`           | no          | Solo `synthetic` en esta versión. El verificador real de Cognito lo añade su propio cambio (se configurará con las variables de ese cambio). |

`OPSLOG_ENV=staging` ya está fijo en el compose. No definir `AWS_*` ni `NODE_ENV=production`: la guarda de arranque lo rechaza. Las claves de S3 llegarán como `OPSLOG_S3_*` con el adaptador S3.

## Pasos en Coolify

1. **DNS (GoDaddy):** en el dominio `northsoftmx.com`, crear un registro **A**: Nombre `opslog`, Valor = IP pública del VPS, TTL 600. Comprobar con `nslookup opslog.northsoftmx.com`.
2. **Nueva aplicación:** Projects → New Resource → Public/Private Repository (GitHub) → repositorio `aleiruiz/OPSLOG`, rama `main` → **Build Pack: Docker Compose**, archivo `/docker-compose.yml`.
3. **Dominio:** en el servicio `web`, Domains = `https://opslog.northsoftmx.com` (Coolify pide el certificado a Let's Encrypt; el VPS debe tener abiertos 80 y 443). Los demás servicios sin dominio.
4. **Variables:** cargar las cuatro obligatorias de la tabla (dos secretos generados con `openssl rand -base64 48`).
5. **Deploy.** La primera construcción es lenta y usa unos 3 GB de RAM mientras compila la web; conviene hacerla cuando el VPS (compartido con otras apps) esté tranquilo.
6. Comprobar `https://opslog.northsoftmx.com/healthz` (nginx) y `https://opslog.northsoftmx.com/api/auth/csrf` (JSON con `csrfToken`, llega hasta la API).

## Prueba local

```sh
cp .env.example .env   # rellenar los secretos
docker compose -f docker-compose.yml -f deploy/compose.local.yml up --build
# http://localhost:8081/healthz  y  http://localhost:8081/api/auth/csrf
```

Para construir detrás de un proxy que inspecciona TLS: `docker build --secret id=extra-ca,src=ca.pem ...`.

## Limitaciones actuales (honestas)

- **Sin inicio de sesión real todavía.** La compilación de producción de la web falla cerrada («El inicio de sesión no está disponible») hasta que llegue el login con Cognito; la API usa el verificador sintético. La pila arranca y responde, pero aún no se puede entrar.
- **Estado en memoria:** reiniciar `api` borra empresas, usuarios y datos. MySQL está desplegado pero sin conectar: la persistencia (control de tenants e identidad, y la base por empresa con sus cuentas y migraciones) es un cambio aparte, y ahí se añadirán las migraciones al desplegar.
- **Archivos:** en memoria hasta que se active el adaptador S3 (`OPSLOG_S3_*`).
