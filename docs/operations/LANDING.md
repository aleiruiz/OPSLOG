# Página de ventas y solicitudes de demo

`apps/landing` es la página pública para conseguir clientes de OPSLOG: explica el producto con capturas del demo y tiene un formulario «Solicitar demo». Corre como el servicio `landing` del mismo `docker-compose.yml`, separado de la aplicación: no comparte sesión, base de datos ni código con `api` o `web`, y no forma parte de lo que se instala en la nube de un cliente.

## Qué hace

- `GET /` sirve la página (`apps/landing/public`), con aviso de privacidad (`/privacidad.html`) y página de gracias.
- `POST /api/leads` valida la solicitud (nombre, empresa, correo, teléfono opcional, tamaño de flotilla, mensaje opcional y aceptación del aviso) y la agrega como una línea JSON a `/data/leads.jsonl`, en el volumen `landing-data`. Funciona con y sin JavaScript.
- Antispam sin servicios externos: un campo trampa oculto (los bots que lo llenan reciben «ok» y no se guardan), 5 solicitudes por dirección cada 15 minutos y 200 en total por ventana.
- `GET /admin/leads` muestra las solicitudes (la más reciente arriba) y `GET /admin/leads.csv` las descarga para Excel. Piden usuario `admin` y la contraseña `LANDING_ADMIN_PASSWORD`; sin esa variable responden 404.
- Si `LANDING_NOTIFY_URL` tiene un webhook https, cada solicitud nueva le envía `{"text": "...", "content": "..."}` (formato de Slack y Discord). Si falla, la solicitud se guarda igual.
- La campaña de origen se guarda si el enlace trae `?utm_source=` o `?ref=` (por ejemplo `?utm_source=facebook`).

## Variables

| Variable                 | Obligatoria | Qué es                                                                                      |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------- |
| `LANDING_ADMIN_PASSWORD` | no          | Contraseña de `/admin/leads`, 16+ caracteres (`openssl rand -base64 24`). Vacía: sin lista. |
| `LANDING_NOTIFY_URL`     | no          | Webhook https que recibe un aviso por cada solicitud nueva.                                 |
| `LANDING_CONTACT_EMAIL`  | no          | Correo que aparece en el aviso de privacidad para ejercer derechos ARCO.                    |

## Pasos en Coolify

1. **DNS (GoDaddy):** registro **A** para el dominio de la página (sugerido: Nombre `flotillas`, es decir `flotillas.northsoftmx.com`), Valor = IP del VPS.
2. En la aplicación de Coolify, servicio `landing`: Domains = `https://flotillas.northsoftmx.com:8090` (el puerto indica a Coolify a qué puerto interno enviar el tráfico).
3. Cargar `LANDING_ADMIN_PASSWORD` (y, si se quiere, `LANDING_CONTACT_EMAIL` y `LANDING_NOTIFY_URL`) y desplegar.
4. Comprobar `https://flotillas.northsoftmx.com/healthz`, enviar una solicitud de prueba y verla en `https://flotillas.northsoftmx.com/admin/leads`.

El contenedor usa unos 40 MB de RAM. Respaldar el volumen `landing-data` junto con `mysql-data`.

## Prueba local

```sh
docker compose -f docker-compose.yml -f deploy/compose.local.yml up --build landing
# http://localhost:8082  y  http://localhost:8082/admin/leads
```

O sin Docker: `node apps/landing/build.mjs && LANDING_PUBLIC_DIR=$PWD/apps/landing/public LANDING_LEADS_FILE=/tmp/leads.jsonl LANDING_ADMIN_PASSWORD=una-clave-de-prueba node apps/landing/bundle/landing.mjs` (puerto 8090).

## Editar la página

El texto está en `apps/landing/public/index.html` y los estilos en `styles.css` (colores del producto, ADR-0013). Las capturas de `public/img` vienen del manual de usuario (empresa de prueba). El aviso de privacidad (`privacidad.html`) es una base para revisar antes de publicar: nombra al titular y no incluye domicilio.
