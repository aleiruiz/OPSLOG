# ADR-0016 — Alcance de M5 para la etapa 0 (demo en Coolify)

Estado: **Propuesta: alcance por defecto elegido por el agente; el propietario puede cambiarlo.** No es una decisión del propietario. Si él corrige un punto, un ADR posterior sustituye ese punto y los paquetes se ajustan en el mismo cambio.
Fecha: 2026-10-19.
Autor: sesión de planificación de M5 (revisión e investigación con el pin de ADR-0007).

Compatible con SPEC-1.4 y ORCH-1.4. No modifica `SPECS.md`, `Orchestrator.md` ni `docs/baselines/**`, y no reduce requisitos: donde la etapa 0 no puede cumplir un requisito, el requisito queda **pendiente de lanzamiento** con su condición, como permite SPECS §9.3 («G5 puede certificar el MVP en staging y dejar explícitos requisitos de lanzamiento externos aún pendientes, sin autorizar publicación»).

## Contexto

- **Negocio.** El propietario **vende** OPSLOG; cada cliente lo ejecuta en su propia cuenta de AWS (ADR-0015). El propietario no lo opera como servicio.
- **Demo.** Corre en Coolify (`docs/operations/DEPLOY_COOLIFY.md`): un solo `docker-compose.yml`, MySQL 8.4, VPS de 2 vCPU y 8 GB compartida con otras apps, inicio de sesión real con Cognito en `opslog.northsoftmx.com`, una empresa por despliegue, `OPSLOG_ENV=staging` y datos sintéticos. El worker corre dentro del proceso `api` (`apps/api/server/src/worker-loop.ts`).
- **AWS.** Solo existen el bucket S3 de staging y Cognito. Todo lo demás sigue diferido y la etapa 0 debe costar casi nada (ADR-0002, ADR-0012). Producción no está autorizada. El módulo Terraform de ADR-0015 existe en `infra/terraform/`.
- **Gate.** G4 aceptado por el propietario el 2026-10-14 sobre `64bd116` (informe G4, «Decisión del propietario»); M5 desbloqueado. La deuda L-1 y L-2 del informe G4 la corrige otro hilo como `FIX-G4-L1-L2`; este ADR no la planifica. L-3, L-4, M-1 y las notas Info siguen diferidas por el propietario.
- **Revisión.** ADR-0011: una revisión de código Opus por PR, acotada al diff; los PRs solo de documentación se fusionan con CI en verde.

## Decisión

### 1. Paquetes y olas

Nueve paquetes en `docs/tasks/*-M5-20261019.md`, cada uno de uno o dos PRs. La preparación de G5 (`G5-AUDIT`) es un documento aparte que se escribe después.

| Ola | Paquete (PR)                                                    | Empieza cuando                           | Lease de archivos compartidos      |
| --- | --------------------------------------------------------------- | ---------------------------------------- | ---------------------------------- |
| 1   | MVP-AUDIT-UI                                                    | M5 desbloqueado                          | 1.º (divide `apps/web/app/routes`) |
| 1   | MVP-SEARCH PR 1 (búsqueda global)                               | M5 desbloqueado                          | 2.º                                |
| 1   | MVP-ANALYTICS PR 1 (API de indicadores)                         | M5 desbloqueado                          | 3.º                                |
| 1   | MVP-SEARCH PR 2 (vistas guardadas, URL, columnas, filtros)      | SEARCH PR 1 fusionado                    | 4.º                                |
| 1   | MVP-ANALYTICS PR 2 (dashboard web)                              | ANALYTICS PR 1 y SEARCH PR 2 fusionados  | 5.º (solo web)                     |
| QA  | MVP-QA etapa 1 (matriz y suite)                                 | contratos de la ola 1 fusionados         | ninguno                            |
| 2   | MVP-REPORTS PR 1 (motor, formatos, jobs, plantilla y vehículos) | ola 1 fusionada                          | 1.º (registro de jobs del worker)  |
| 2   | MVP-NOTIFY                                                      | ola 1 fusionada                          | 2.º                                |
| 2   | MVP-REPORTS PR 2 (mantenimiento, siniestros, transversal, PDF)  | REPORTS PR 1 y NOTIFY fusionados         | 3.º                                |
| 3   | MVP-WEBHOOKS                                                    | ola 2 fusionada                          | 1.º                                |
| 3   | MVP-OPS PR 1 (observabilidad, respaldo y restauración)          | ola 2 fusionada                          | 2.º                                |
| 3   | MVP-OPS PR 2 (carga, exportación de empresa, runbooks)          | WEBHOOKS y OPS PR 1 fusionados           | ninguno                            |
| QA  | MVP-QA etapa 2 (ejecución)                                      | ola 3 fusionada, junto con MVP-INTEGRATE | ninguno                            |
| 4   | MVP-INTEGRATE                                                   | todo lo anterior fusionado               | único dueño                        |

Dentro de una ola cada paquete desarrolla en sus propios paths en paralelo y hace rebase antes de tocar archivos compartidos. En cada momento hay un solo dueño de los archivos compartidos; el coordinador entrega el lease al siguiente después de la fusión del anterior.

Archivos compartidos de M5: catálogo de permisos (`packages/domain/identity/src/types.ts`, `apps/api/composition/src/access.ts`, `apps/web/app/permissions.ts`); registro de contratos (`packages/contracts/src/index.ts`, `packages/contracts/src/bff.ts`, `packages/contracts/src/client.ts`, que está en la lista de excepciones de `max-lines` y no crece: los métodos nuevos van en archivos nuevos); rutas BFF (`apps/api/bff/src/routes.ts`); composición (`apps/api/composition/src/**`, `apps/worker/composition/**`); servidor (`apps/api/server/src/**`); arneses MySQL (`tests/e2e/fleet/mysql.ts`, `e2e/real-api/harness.ts`); shell web (`apps/web/app/routes.ts` o sus divisiones, `ShellNavigation.tsx`, `AppShell.tsx`, `router.tsx`, `HomeScreen.tsx`); despliegue (`docker-compose.yml`, `deploy/**`); raíz (`package.json`, `tsconfig.json`, `pnpm-lock.yaml`, `eslint.config.mjs`, cuya lista de excepciones solo se reduce).

Varios de esos archivos están en el límite de 400 líneas efectivas (`apps/web/app/routes.ts` 399, `apps/api/composition/src/platform/apis.ts` 393, `packages/contracts/src/bff.ts` 383). El primer paquete que los toque los divide por responsabilidad antes de añadir nada.

### 2. Correo

El correo sale por el puerto de correo existente (ADR-0014; hoy `IncidentAlertMailer` de INC-SLA). MVP-NOTIFY lo generaliza en `packages/platform/mail` con dos adaptadores: el **sumidero** (por defecto, registra el envío sin contenido personal) y un adaptador **SMTP opcional** (`nodemailer`), que solo se activa si están todas las variables `OPSLOG_SMTP_*`. Sin SES. El envío real a usuarios finales en la cuenta del cliente (SES u otro) es pendiente de lanzamiento.

### 3. Operación (MVP-OPS)

Sin RDS ni PITR gestionado en la demo. Alcance para la realidad Coolify/MySQL:

- `GET /healthz` (vivo) y `GET /readyz` (MySQL, migraciones y último tick del worker); logs JSON con empresa, correlación y actor opaco, sin PII.
- Respaldo con `mysqldump --single-transaction` diario más copia de binlogs cerrados cada 15 minutos o menos a un volumen del VPS, y script de restauración. Simulacro de restauración en una instancia MySQL temporal con datos sintéticos que **mide** RPO y RTO contra SPECS §9.3 (RPO ≤ 15 min, RTO ≤ 4 h).
- Exportación de la empresa (JSON/CSV y archivos autorizados, NFR-B5) como script de administración.
- Prueba de carga con k6 (imagen Docker fijada) contra la pila local, con informe honesto de p95.
- Runbook de release y rollback en Coolify y plan de presupuesto y región para la cuenta AWS del cliente con el módulo Terraform.
- **Pendiente de lanzamiento (cuenta del cliente):** PITR y retención de 35 días en RDS, copia en otra región, Multi-AZ, alarmas CloudWatch y Budgets, SQS/EventBridge, SES, despliegue sin caída (NFR-A2) y SLO 99,5 % (NFR-A1).

### 4. Rendimiento de búsqueda

SPECS §9.3 y NFR-P4 piden p95 ≤ 700 ms sobre 1 M de registros. MVP-SEARCH usa una tabla de proyección indexada en MySQL (claves normalizadas con índice B-tree para prefijo e índice FULLTEXT con parser `ngram` para «contiene»), alimentada por el outbox y con reconstrucción idempotente. La prueba de rendimiento genera un dataset sintético escalable: 100.000 filas en la corrida local o de CI opcional y **1 M como paso manual documentado**, con el resultado registrado en el paquete.

### 5. Reportes

CSV con serializador propio RFC 4180 (UTF-8 con BOM), XLSX con **ExcelJS** (escritor en streaming) y PDF con **PDFKit** usando las fuentes IBM Plex ya autoalojadas. Más de 5.000 filas, o una generación que no cumpla el presupuesto de 10 s, pasa a un job asíncrono del worker existente. Neutralización de fórmulas en toda salida. Descarga autenticada por proxy, nunca una URL firmada de 7 días.

### 6. Webhooks

Firma HMAC-SHA256 sobre timestamp, id de evento y bytes exactos; reintentos 1m/5m/30m/2h/12h con jitter y DLQ; protección SSRF (solo HTTPS público, DNS validado y fijado al conectar, sin redirecciones, metadatos y redes privadas bloqueados). Worker en `apps/worker/webhooks`, ejecutado en el proceso `api` como el resto del worker. Permiso nuevo `integrations:manage`. API pública, API keys y elegibilidad por API (FR-180, FR-182, FR-183) siguen en fase 1.5.

### 7. Rutas web

Dashboard en Inicio (`/`), reportes en `/analisis/reportes`, auditoría en `/analisis/auditoria`, búsqueda en la barra superior y `/buscar`, notificaciones en la campana y `/notificaciones`, integraciones en `/configuracion/integraciones`. Grupo de navegación «Análisis» según SPECS §8.

## Preguntas abiertas para el propietario (con el default que se aplica mientras no responda)

1. **Diff de auditoría.** BRD §16.1 y US-070 piden valor anterior y nuevo; el audit actual guarda solo acción, entidad y actor (sin valores, por diseño). **Default:** MVP-AUDIT-UI muestra nombres de campos cambiados y valores anteriores y nuevos solo donde el historial del módulo ya los guarda sin PII ni importes (timeline de siniestros y órdenes); no se crea un almacén nuevo de valores. FR-171 queda parcial en el «diff» y así se declara. Alternativa: almacén de diffs enmascarados por módulo (más costo y más superficie de PII).
2. **Correo real en la demo.** **Default:** sumidero; el adaptador SMTP existe pero queda apagado hasta que el propietario cargue un proveedor SMTP propio en Coolify.
3. **Logo de la empresa en PDF y correo.** No existe carga de logo. **Default:** nombre de la empresa en texto y la marca OPSLOG; la carga de logo queda fuera de M5.
4. **Webhooks desde la demo.** **Default:** permitidos hacia HTTPS público con las protecciones SSRF, máximo 5 endpoints por empresa y límite de entregas por minuto, para poder enseñarlos a clientes con un receptor de prueba.

## Consecuencias

- Los nueve paquetes citan este ADR. Cambiar un default exige un ADR posterior y el ajuste de los paquetes afectados.
- G5 revisará los requisitos marcados aquí como pendientes de lanzamiento y los dejará explícitos; no cuentan como implementados.
- Dependencias nuevas previstas (todas MIT o similar, versión exacta fijada al instalarlas): `exceljs`, `pdfkit`, `nodemailer`. k6 se usa como imagen Docker y no entra al lockfile.
- No cambian: SPECS, Orchestrator, baselines, proveedor único, una revisión por PR/SHA (ADR-0007, ADR-0011), AWS diferido, producción sin autorización y el aislamiento por empresa de SPECS §4.
- Este ADR no declara ningún gate aprobado.
