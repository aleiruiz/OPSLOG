# MVP-NOTIFY-M5-20261019: centro de notificaciones, preferencias, suscripciones y correo

```yaml
id: MVP-NOTIFY-M5-20261019
baseline: [SPEC-1.4, ORCH-1.4, inherited: SPEC/ORCH 1.0-1.3 not superseded]
active_provider: anthropic
model: pin de código vigente según ADR-0007, sin fallback
milestone: M5
kind: implementation
wave: 2 (desarrollo en paralelo con MVP-REPORTS PR 1; lease compartido tras su fusión)
base_sha: el main vigente con la ola 1 fusionada; rebase sobre el SHA con MVP-REPORTS PR 1 antes de tocar archivos compartidos
depends_on:
  - ola 1 de M5 fusionada
  - MVP-REPORTS PR 1 fusionado (evento export.completed y registro de jobs del worker)
  - ADR-0014 §5 y ADR-0016 §2
requirements:
  [
    FR-150,
    FR-151,
    FR-152,
    FR-153,
    FR-148 (aviso de exportación lista),
    FR-107 y FR-119 (como fuentes ya existentes),
    BRD §15.1,
    BRD §15.2,
    BRD §15.3,
    BRD S23,
    NFR-A3,
    SPECS §4.3 (jobs con tenant y actor; revalidar al enviar),
    SPECS §4.4 (notificaciones en la matriz A/B),
    SPECS §7 (alertas,
    deduplicación,
    fallo de correo no revierte),
  ]
write_paths:
  - packages/domain/notifications/**
  - packages/persistence/notifications/**
  - packages/platform/mail/** (nuevo: puerto, sumidero y SMTP opcional)
  - apps/api/notifications/**
  - apps/worker/notifications/**
  - apps/web/features/notifications/**
  - packages/contracts/src/bff/notifications.ts (nuevo)
  - apps/api/bff/src/routes/notifications.ts y apps/api/bff/src/notifications.test.ts (nuevos)
  - apps/api/composition/src/platform/notification-apis.ts y apps/api/composition/src/notifications-source.ts (nuevos)
  - tests/integration/platform/notifications.test.ts y tests/integration/platform/mysql-notifications.test.ts (nuevos)
  - docs/tasks/MVP-NOTIFY-M5-20261019.md
shared_paths_owned_in_wave_2:
  - registro de contratos, rutas BFF, composición, worker y arneses MySQL
  - apps/api/composition/src/platform/incident-sla-apis.ts (solo para que el mailer de INC-SLA sea un adaptador del puerto general)
  - apps/web/app/AppShell.tsx (campana con contador) y rutas web de notificaciones
  - apps/api/server/src/config.ts, docker-compose.yml y deploy/variables.example (solo las variables OPSLOG_SMTP_*)
  - package.json, pnpm-lock.yaml (nodemailer con versión exacta)
forbidden_paths:
  - SPECS.md, Orchestrator.md, docs/baselines/**, Tasks.md, .env*, AWS (sin SES), producción y datos reales
  - reglas de los escaneos existentes (FLT-ALERTS, planes de mantenimiento, INC-SLA): se consumen, no se reescriben
status: implemented
```

## Encargo

Centro de notificaciones in-app con contador (S23), preferencias por usuario de canal y tipo dentro de lo que la empresa permite (FR-152), suscripción a vehículos y siniestros concretos (FR-153), plantillas de correo por evento y el puerto de correo general con sumidero por defecto y SMTP opcional (ADR-0016 §2), integrando los eventos y escaneos que ya existen (FR-150, FR-151). Un fallo de notificación nunca revierte el comando que la causó. Orden y dueños: ADR-0016 §1.

## Modelo

- `Notification` por destinatario: `id`, `companyId`, `recipientId`, `eventKind`, `entityType`, `entityId`, `title`, `link`, `severity`, `createdAt`, `readAt`. Sin PII, importes ni texto libre del registro: el título se compone con folio o número económico y la etiqueta del evento.
- `NotificationDelivery` por canal: `notificationId`, `channel` (`in_app`, `email`), `status` (`pending`, `sent`, `failed`, `suppressed`), `attempts`, `lastError` (código, nunca el mensaje del proveedor con direcciones).
- `NotificationPreference` por usuario y `eventKind`: canales activos. `CompanyNotificationRule` (`manage_config`): qué eventos admiten correo, silencio nocturno para canales externos (desactivado por defecto; si se activa, 22:00–07:00 en la zona de la empresa) y umbral de inactividad de siniestros si INC-SLA no lo tiene ya.
- `Subscription`: `recipientId`, `entityType` (`vehicle`, `incident`), `entityId`. Al leer se revalida que el suscriptor siga viendo la entidad.
- **Deduplicación** (FR-151, SPECS §7): clave única `(company_id, event_kind, entity_id, date_version, threshold, recipient_id, channel)`. Si cambia la fecha de vencimiento cambia `date_version` y el ciclo se reinicia. «Mantenimiento vencido» como máximo uno por día.

## Fuentes de eventos (BRD §15.1)

| Evento                                                | Fuente existente o nueva                                      | Destinatarios por defecto                       | Obligatorio |
| ----------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------- | ----------- |
| Seguro, documento o licencia por vencer               | escaneo de FLT-ALERTS (30/15/7/0)                             | miembros con `edit` en flota                    | no          |
| Mantenimiento próximo / vencido                       | escaneo de planes de mantenimiento                            | flota; vencido también supervisores (`approve`) | no          |
| Siniestro nuevo / cambio de estado                    | outbox `incident.status_changed`                              | responsable, creador, suscriptores              | no          |
| Siniestro asignado, sin responsable, SLA, inactividad | avisos de INC-SLA (ya con correo, ADR-0014)                   | los de INC-SLA                                  | sí          |
| Vehículo fuera de servicio                            | outbox `vehicle.status_changed`                               | flota y suscriptores                            | no          |
| Orden de mantenimiento asignada                       | outbox de órdenes (`maintenance.status_changed` a `assigned`) | mecánico asignado                               | sí          |
| Usuario creado / rol cambiado                         | cambios de membresía del plano de control                     | usuario afectado y `manage_users`               | sí          |
| Exportación lista o fallida                           | outbox `export.completed` / `export.failed` (MVP-REPORTS)     | solicitante                                     | sí          |

Los avisos de INC-SLA **no se duplican**: aparecen en el centro y su correo lo sigue enviando INC-SLA, ahora mediante el puerto general. Si un evento no existe todavía en el outbox (membresías), se emite desde la composición sin cambiar reglas de dominio. Los destinatarios se resuelven y **revalidan al enviar** (permiso y membresía vigentes); un destinatario revocado no recibe nada.

## Correo

- `packages/platform/mail`: `MailPort.send({companyId, to, subject, text, html?, idempotencyKey})`; `SinkMailAdapter` (por defecto; registra empresa, plantilla, destinatario opaco y resultado, nunca la dirección ni el cuerpo en logs); `SmtpMailAdapter` con **nodemailer**, activo solo si están `OPSLOG_SMTP_HOST`, `OPSLOG_SMTP_PORT`, `OPSLOG_SMTP_USER`, `OPSLOG_SMTP_PASSWORD` y `OPSLOG_SMTP_FROM`, con TLS obligatorio. Configuración parcial falla al arrancar nombrando la variable, nunca el valor.
- Plantillas fijas en español por evento, texto y HTML simple con el nombre de la empresa (sin logo, ADR-0016 pregunta 3) y el enlace; sin importes, PII ni texto libre.
- Entrega asíncrona desde el worker, reintentos 1m/5m/30m con jitter y estado `failed` terminal visible para el administrador. Idempotente por notificación y canal.

## Web

Campana con contador de no leídas en la barra superior; `/notificaciones` con lista agrupada por día, filtros por tipo y leídas, marcar una o todas como leídas, enlace a la entidad; `/notificaciones/preferencias` con la matriz evento × canal donde los obligatorios aparecen fijos y explicados; botón «Seguir» que MVP-INTEGRATE monta en las fichas de vehículo y siniestro. Estados de SPECS §8.

## Pruebas de aceptación

1. **Deduplicación.** Given el escaneo de vencimientos corre dos veces el mismo día, Then una notificación por destinatario y umbral; given que cambia la fecha de vencimiento, Then el ciclo empieza de nuevo.
2. **No revierte.** Given el puerto de correo falla, Then el comando original queda confirmado, la entrega queda `failed` tras los reintentos y el in-app existe.
3. **Obligatorios.** Given un usuario que desactiva todo, Then sigue recibiendo los obligatorios (asignación de caso, orden asignada, exportación lista) y el formulario no permite apagarlos.
4. **Silencio nocturno.** Given silencio activo y un evento a las 23:00 locales, Then el correo se difiere a las 07:00 y el in-app es inmediato.
5. **Revocación.** Given un destinatario al que se le quita `incidents:view` con un envío pendiente, Then no recibe ni in-app ni correo; las suscripciones a esa entidad dejan de entregar.
6. **Tenant A/B.** Given ids iguales en A y B, Then ninguna notificación, contador, suscripción ni correo del sumidero cruza de empresa.
7. **Contenido mínimo.** Given cada plantilla, Then asunto y cuerpo no contienen importes, PII ni texto libre; el log del sumidero no contiene la dirección.
8. **Sin duplicar INC-SLA.** Given un aviso SLA, Then un solo correo por destinatario, el mismo que antes de este paquete.
9. **SMTP.** Given las cinco variables `OPSLOG_SMTP_*` y un servidor SMTP de prueba local, Then el correo llega con TLS; given cuatro de cinco, Then el arranque falla nombrando la que falta.
10. **Accesibilidad.** Contador con texto accesible; centro y preferencias por teclado; axe sin violaciones.

## Decisiones por defecto

- Sumidero por defecto y SMTP apagado en la demo (ADR-0016 pregunta 2). Sin SES.
- Digest diario y semanal fuera (BRD §15.1, fase 2). Push, WhatsApp y SMS fuera (FR-154, FR-155, SPECS §2.2).
- Retención de notificaciones leídas 180 días; sin purga automática activada (D19) hasta validar política.

## Tamaño

Un PR de unas 2.800 líneas con pruebas. Si crece, PR 1 (modelo, fuentes, puerto de correo, worker) y PR 2 (web y preferencias). Ningún archivo de producción supera 400 líneas.

## Fuera de alcance

Webhooks (MVP-WEBHOOKS), reglas de los escaneos existentes, montaje del botón «Seguir» en fichas (MVP-INTEGRATE), envío real con SES en la cuenta del cliente (pendiente de lanzamiento).

## Comandos y evidencia

```text
pnpm quality
pnpm test:integration
pnpm exec prettier --check docs/tasks/MVP-NOTIFY-M5-20261019.md
git diff --check
```

Registrar SHA, MySQL exacto, versión exacta de nodemailer y la matriz requisito → contrato → implementación → prueba → evidencia. PR listo, CI verde y la única revisión Opus por PR/SHA. El autor no fusiona ni declara G5.

## Evidencia de implementación

- Base: `origin/claude/mvp-reports-pr1`; rama `claude/mvp-notify`. El SHA de cabeza se registra en el reporte de la sesión.
- MySQL de las pruebas locales: 8.0.46 (las suites que exigen 8.4 quedan fuera de esta evidencia y corren en CI). nodemailer: 10.0.14 exacta.
- Pruebas propias: dominio 64, plataforma de correo 17, persistencia 10 (9 de integración, tres ejecuciones verdes), API 6, worker 20, BFF 9, plataforma 9 y MySQL de plataforma 2, web 10 (axe incluido).
- Cobertura: dominio 99,89 / 97,32; correo 100; API 100 / 98,27; worker 100 / 95,58; composición 96,7 / 91,6 (sentencias / ramas).

| Requisito                            | Contrato                         | Implementación                                | Prueba                                                       |
| ------------------------------------ | -------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Centro, contador, leídas (S23)       | `notifications.list/count/read*` | `packages/domain/notifications`, persistencia | `notifications.test.ts` (BFF), `mysql-notifications.test.ts` |
| Preferencias y obligatorios (FR-152) | `notifications.preferences.*`    | `catalog.ts`, `service.ts`                    | aceptación 3                                                 |
| Suscripciones (FR-153)               | `notifications.subscri*`         | `service.ts`, `FollowButton`                  | `notifications.test.ts` (BFF)                                |
| Fuentes y deduplicación (FR-150/151) | n/a                              | `apps/worker/notifications`                   | aceptación 1                                                 |
| Correo: puerto, sumidero, SMTP       | n/a                              | `packages/platform/mail`                      | aceptaciones 7, 8 y 9                                        |
| A/B (SPECS §4.4)                     | 404 con ids ajenos               | toda sentencia filtra `company_id`            | aceptación 6, `mysql-notifications.test.ts`                  |

La matriz completa y los desvíos están en `docs/traceability/notifications.md`.
