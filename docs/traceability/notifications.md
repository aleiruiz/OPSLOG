# Trazabilidad: notificaciones, preferencias, suscripciones y correo (MVP-NOTIFY)

| Requisito                                               | Contrato                                                                  | Implementación                                                              | Prueba                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Centro in-app con contador (S23, FR-150)                | `notifications.list`, `notifications.count`                               | `NotificationService`, `TypeOrmNotificationStore`, `NotificationsApi`       | `service.test.ts`, `notifications.test.ts` (BFF), `mysql.integration.test.ts`          |
| Marcar una o todas como leídas                          | `notifications.read`, `notifications.readAll`                             | `NotificationService.markRead`, `markAllRead`                               | `service.test.ts`, `notifications.test.ts` (BFF)                                       |
| Preferencias canal × tipo dentro de la empresa (FR-152) | `notifications.preferences.get`, `.update` (422 obligatorio)              | `catalog.ts` (`mandatory`), `NotificationService.savePreferences`           | `service.test.ts`, `notifications.test.ts` (BFF y plataforma, aceptación 3)            |
| Regla de empresa y silencio nocturno 22:00 a 07:00      | `notifications.rules.get`, `.update` (`manage_config`)                    | `calendar.ts`, `NotificationService.saveRule`, `Dispatcher`                 | `pure.test.ts`, `dispatch.test.ts`, `notifications.test.ts` (plataforma, aceptación 4) |
| Suscripción a vehículos y siniestros (FR-153)           | `notifications.subscriptions.*`, `notifications.subscribe`                | `NotificationService.subscribe`, revalidación de visibilidad al leer        | `service.test.ts`, `notifications.test.ts` (BFF)                                       |
| Deduplicación y reinicio del ciclo (FR-151, SPECS §7)   | n/a                                                                       | clave única `ux_notice_dedupe`, `dateVersion` y umbral                      | `ingest.test.ts`, `mysql.integration.test.ts`, `notifications.test.ts` (aceptación 1)  |
| Fallo de correo no revierte el comando                  | `notifications.deliveries.failed`                                         | `Dispatcher` (reintentos 1m/5m/30m, terminal `failed`), código de error     | `dispatch.test.ts`, `notifications.test.ts` (aceptación 2)                             |
| Destinatarios revalidados al enviar                     | n/a                                                                       | `NotificationDirectory` (membresía y permiso vigentes)                      | `dispatch.test.ts`, `notifications.test.ts` (aceptación 5)                             |
| Plantillas por evento sin importes, PII ni texto libre  | n/a                                                                       | `templates.ts`, `titles.ts`                                                 | `pure.test.ts`, `notifications.test.ts` (aceptación 7)                                 |
| Puerto de correo, sumidero y SMTP con TLS               | n/a                                                                       | `packages/platform/mail` (`SinkMailAdapter`, `SmtpMailAdapter`, nodemailer) | `sink.test.ts`, `smtp.test.ts` (servidor TLS local), `config.test.ts` (servidor)       |
| Configuración parcial falla nombrando la variable       | n/a                                                                       | `readSmtpConfig`, `readConfig` (`apps/api/server`)                          | `config.test.ts` (mail y servidor)                                                     |
| INC-SLA sin duplicar correo                             | n/a                                                                       | `MailPortAlertMailer`, `withSlaNotice`                                      | `notifications.test.ts` (aceptación 8), `incident-sla.test.ts`                         |
| Aislamiento A/B                                         | 404 con ids ajenos, contador y listas por empresa                         | toda sentencia filtra `company_id`; cuentas `opslog_notify_*`               | `notifications.test.ts`, `mysql-notifications.test.ts`, `mysql.integration.test.ts`    |
| Eventos de membresía y de vehículo desde composición    | `membership.created`, `membership.role_changed`, `vehicle.status_changed` | `NotificationEvents` (`publish` al outbox del tenant)                       | `notifications.test.ts`, `mysql-notifications.test.ts`                                 |
| Campana accesible y pantallas con teclado y axe         | n/a                                                                       | `apps/web/features/notifications`, `AppShell.tsx`                           | `notifications.test.tsx` (axe)                                                         |
| Deriva entre contrato BFF y catálogo de dominio         | `BFF_NOTIFICATION_KINDS`                                                  | `EVENT_KINDS`                                                               | `notifications.test.ts` (plataforma)                                                   |

## Desvíos registrados

- `MailMessage` lleva un campo `template` adicional al del encargo: el sumidero registra la plantilla sin guardar contenido.
- La clave de deduplicación vive en la fila de la notificación (sin canal); las entregas son únicas por (empresa, notificación, canal).
- La regla de empresa se edita en un panel compacto dentro de las preferencias (silencio nocturno, tipos con correo, envíos fallidos).
- El escaneo de vencimientos anuncia hasta 3 días después de vencer (margen de gracia) y una vez por hora.
- El aviso «siniestro nuevo» llega al responsable, al creador y a los seguidores, sin excluir al actor.
- «Seguir» es un componente reutilizable; MVP-INTEGRATE lo monta en las fichas.
- No se añadió el umbral de inactividad (lo tiene INC-SLA) ni la purga de leídas (D19).
- «Mantenimiento vencido, uno por día»: el día es el de proceso en la zona de la empresa, porque el manejador no recibe `occurredAt`.
- Los eventos de vehículo y de membresía se publican por el puerto `NotificationEvents` (outbox durable en MySQL, en memoria con el kernel).
- Las cuentas MySQL usan la clave de módulo `notify` (`opslog_notify_*`) por el límite de 32 caracteres de MySQL.
- Los títulos de exportación usan el título del catálogo de reportes.
