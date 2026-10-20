# Runbook: respuesta a incidentes y recuperación ante desastres

Plan de recuperación ante desastres (NFR-B6) con roles, procedimiento y comunicación a clientes. Técnica de recuperación: `backup-restore.md`. Despliegue y rollback: `release-rollback-coolify.md`.

## 1. Roles

| Rol                      | Responsabilidad                                                       | Titular                                               |
| ------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------- |
| Comandante del incidente | decide severidad, rollback o restauración, y cuándo se cierra         | propietario del servicio (nombrar por instalación)    |
| Operador                 | diagnostica y ejecuta los runbooks; registra cada acción con hora UTC | persona con acceso a Coolify y al VPS                 |
| Comunicación             | avisa a los clientes y mantiene la cronología                         | designado por el comandante; si no hay, el comandante |
| Custodio de secretos     | entrega las claves (PII, MySQL, exportación) cuando se necesitan      | persona distinta del operador cuando sea posible      |

Antes de lanzar, rellenar nombres y medios de contacto fuera del repositorio (sin datos personales en git). Si una sola persona cubre varios roles, se anota igualmente.

## 2. Severidad

| Nivel | Criterio                                                                                    | Objetivo de respuesta                                |
| ----- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| SEV1  | servicio caído, pérdida o corrupción de datos, o sospecha de exposición de datos personales | empezar de inmediato; primer aviso a clientes en 1 h |
| SEV2  | degradación grave (errores sostenidos, cola de salida bloqueada, copias sin hacerse)        | empezar en 4 h hábiles                               |
| SEV3  | defecto menor o aviso preventivo                                                            | siguiente día hábil                                  |

Los objetivos de tiempo son una propuesta de arranque, no un compromiso contractual (SLO 99,5 % pendiente de lanzamiento, `customer-aws.md`).

## 3. Detección y alertas

- **Coolify, alerta de salud de contenedor.** Activar las notificaciones del servidor/proyecto en Coolify (Notifications: correo o el canal que use el equipo) para que llegue el aviso de contenedor en mal estado o reiniciado. `api` se declara sano por `/readyz` (MySQL, migración, worker), `backup` por la antigüedad de la última copia, `mysql` por su propio healthcheck.
- **Monitor externo gratuito (opcional).** Un monitor HTTP externo sobre `https://<dominio>/healthz` cada 5 min, con aviso por correo, detecta caídas del VPS o del proxy que Coolify no puede avisar. Es solo de vivo: no prueba base ni worker. No enviar datos de clientes a ningún servicio externo; `healthz` no devuelve datos.
- **Logs.** Una línea JSON por evento; filtrar `level` de aviso o error y `msg` como `readyz_failed`, `worker_tick_failed`. Cada línea lleva `correlationId`. La línea `ops_stats` (cada minuto) da el lag del outbox, entregas pendientes y en DLQ, exportaciones por estado, cola de escaneo y conexiones.
- **Usuarios.** El soporte registra reportes de clientes con hora y descripción, sin datos personales.

## 4. Procedimiento

1. **Registrar.** Abrir la cronología (hora UTC, quién, qué). Asignar roles y severidad.
2. **Contener.** Elegir lo menos invasivo: reintentar, `docker compose restart api`, rollback de aplicación. Si hay riesgo de corrupción o exposición, `docker compose stop api web` para cortar escrituras.
3. **Diagnosticar.** `docker compose ps`, logs de `api`, `migrate`, `mysql` y `backup`, `readyz` dentro de la pila. Espacio de disco y memoria del VPS.
4. **Recuperar.** Árbol de decisión:
   - despliegue reciente y sin daño de datos: rollback de aplicación (`release-rollback-coolify.md` §4);
   - VPS o contenedor reiniciado: reiniciar la pila y verificar;
   - corrupción, borrado o pérdida de la base: restaurar (`backup-restore.md` §3);
   - pérdida del VPS: reconstruir la pila desde el repositorio, cargar los secretos del gestor y restaurar el volumen de respaldos si sobrevivió. **Sin copia fuera del host, la pérdida simultánea de VPS y volumen es pérdida de datos** (riesgo aceptado hasta que el propietario decida la copia externa);
   - exposición de datos personales: contener, preservar logs y avisar al propietario inmediatamente; notificar a clientes y autoridades según contrato y ley aplicable (decisión del propietario con asesoría legal).
5. **Verificar.** Lista de verificación posterior del runbook de release; confirmar con una persona del cliente cuando sea posible.
6. **Cerrar.** El comandante declara el cierre. Revisión posterior en 5 días hábiles: causa raíz, línea de tiempo, RPO y RTO reales, acciones con responsable y fecha. Sin culpables; sin datos personales en el informe.

## 5. Comunicación a clientes

Canal: el acordado con cada cliente (correo del contacto técnico). Plantillas, sin datos personales y sin detalles internos:

- **Inicio (SEV1 en 1 h, SEV2 en 4 h hábiles):** qué servicio, desde cuándo (UTC), impacto conocido, próxima actualización.
- **Actualización:** cada hora en SEV1 y cada 4 h en SEV2, aunque sea «sin novedad».
- **Cierre:** causa en una frase, datos afectados (si los hubo), RPO real, medidas.
- **Pérdida de datos:** decir exactamente hasta qué instante se restauró.

## 6. Ventanas de mantenimiento anunciadas (NFR-A4)

- Aviso con **72 h** de antelación por el canal acordado: fecha, hora de inicio y fin en UTC y hora local, impacto esperado, contacto.
- Fuera del horario operativo de la mayoría de los clientes; se elige con los datos de uso reales (`ops_stats` y el calendario del cliente).
- Respaldo previo obligatorio (`release-rollback-coolify.md` §1). Recordatorio 24 h antes y aviso al terminar.
- Una urgencia de seguridad puede adelantarse con aviso inmediato y justificación; queda en la cronología.

## 7. Qué no cubre aún

Guardia fuera de horario, SLO 99,5 %, Multi-AZ y despliegue sin caída son pendientes de lanzamiento (`customer-aws.md`). Hasta entonces la etapa 0 acepta caídas durante reinicios y que la recuperación dependa de personas.
