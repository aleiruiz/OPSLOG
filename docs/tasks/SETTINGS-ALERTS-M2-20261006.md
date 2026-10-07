# SETTINGS-ALERTS-M2-20261006 — Ajustes de empresa (FLT-SETTINGS, primer corte) y alertas base de vencimiento (FLT-ALERTS, primer corte): dominio, persistencia, composición y BFF

```yaml
id: SETTINGS-ALERTS-M2-20261006
baseline:
  [
    SPEC-1.4,
    ORCH-1.4,
    inherited: SPEC-1.0/ORCH-1.0,
    SPEC-1.1/ORCH-1.1,
    SPEC-1.2/ORCH-1.2,
    SPEC-1.3/ORCH-1.3,
  ]
milestone: M2
kind: implementation
slice: fourth
baseSHA: cf89e8437035e4d5e0346df0f5d18e350ad48287
depends_on:
  [
    CORE-AUTH,
    CORE-TENANCY,
    CORE-AUDIT,
    CORE-INTEGRATE,
    VEHICLES-M2-20261006,
    DOCS-M2-20261006,
    INSURANCE-M2-20261006,
  ]
write_paths:
  [
    packages/domain/settings/**,
    packages/persistence/settings/**,
    packages/domain/alerts/**,
    apps/api/composition/**,
    apps/api/bff/**,
    packages/contracts/**,
    tests/integration/platform/**,
    docs/tasks/SETTINGS-ALERTS-M2-20261006.md,
    package.json,
    tsconfig.json,
    pnpm-lock.yaml,
  ]
```

`package.json`, `tsconfig.json` y `pnpm-lock.yaml` están en `write_paths` solo por el cableado (scripts de prueba, lista de `format:check`, referencias de proyecto e importadores del lockfile). Es el seguimiento que `DOCS-M2-20261006` y `INSURANCE-M2-20261006` dejaron abierto (catálogo y días de anticipación por empresa; alertas de vencimiento): BRD/SRD v0.2 §15.1 (eventos «Seguro próximo a vencer» y «Documento de vehículo próximo a vencer», 30/15/7/0 días), §15.3 (deduplicación), FR-034, FR-091, FR-132, FR-150, FR-151 (parte de datos), BR-007 y la fila «Alertas» de la configuración de empresa (S24). **Solo backend** (ADR-0010: sin pantallas). Replica Vehículos, Áreas, Empleados, Documentos, Seguros y Asignaciones. No toca `docs/baselines`, `apps/web` ni Storybook. Solo datos sintéticos; **sin correo, SQS, outbox ni AWS** (la cola durable queda diferida: las alertas se derivan de lecturas a base de datos). **Dependencias nuevas: ninguna** (los paquetes nuevos solo cambian los importadores del lockfile).

## Alcance entregado

1. **Ajustes de empresa** (`packages/domain/settings`, `@opslog/domain-settings`): `CompanySettings` con **ventana de vencimiento** (`expiryWindowDays`, 1 a 30 días) y **destinatarios de alertas** (`recipientRoles`, de 1 a 5 de los 5 roles, en orden canónico y sin repetir); `parseSettings`, puerto `SettingsStore`, `InMemorySettingsStore` y `SettingsService` (`get` devuelve los valores por defecto en versión 0 mientras la empresa no ha guardado; `update` reemplaza por completo con la versión de la última lectura). Errores tipados `SettingsError(code)`.
2. **Persistencia** (`packages/persistence/settings`): tabla `opslog_company_settings` (una fila por empresa, `company_id` es la clave primaria); migración reversible `CreateCompanySettings2026100600090` (el id siguiente a `CreateVehicleAssignments2026100600080`) con `CHECK` NULL-seguros como DDL; `TypeOrmSettingsStore` (errores saneados; primera escritura decidida por la clave primaria; reemplazo con `UPDATE` condicional por `(company_id, version)`); cuenta de ejecución `opslog_settings_*` de mínimo privilegio (`SELECT, INSERT, UPDATE`, **sin `DELETE`**).
3. **Alertas base** (`packages/domain/alerts`, `@opslog/domain-alerts`, sin persistencia propia): `AlertService` que **deriva** las alertas en cada lectura a partir de los almacenes de documentos y de pólizas con el reloj del servicio (fecha UTC), sin escribir ni encolar nada. Reutiliza los ayudantes de vencimiento de documentos y seguros (`expiryOf`, `addDays`, `dateOf`, `ExpiryFilter`): el último día de vigencia es inclusivo (con 0 días restantes sigue «por vencer»; al día siguiente está «vencido»). Puertos `AlertSource` (uno por origen) y `AlertWindowReader`.
4. **Composición** (`apps/api/composition/src/settings.ts`, `alerts.ts`, `platform.ts`): `CompanySettingsApi` (`platform.companySettings`) y `AlertsApi` (`platform.alerts`) con sesión + `TenantGate`, rol y permiso resueltos en cada llamada; tenant y actor salen solo de la sesión. Las fuentes de alertas son adaptadores sobre `DocumentStore.list` y `PolicyStore.list` (siempre con el tenant, sin archivados). Auditoría: `company_settings.updated` (acción, tipo, id de empresa y actor; nunca valores).
5. **BFF y contratos**: `alerts.list` (GET `/api/alerts`), `alerts.settings.get` (GET `/api/alerts/settings`) y `alerts.settings.update` (PUT, 200). Lecturas con sesión; escritura con sesión + CSRF. Cliente tipado `createAlertsClient` (`list`, `settings`, `saveSettings`). **Sin códigos de error nuevos** (`bad_request`, `forbidden`, `stale_version`, 401). Las rutas `company.settings.*` (nombre, MFA, inactividad) son otra cosa y no cambian.
6. **Pruebas** (abajo).

## Alcance: qué se entiende por «alertas base» y «ajustes»

- **Alertas base** = qué documentos de **vehículo** y qué **pólizas de seguro** están por vencer o vencidos hoy. No hay entidad de alerta ni estado de entrega: una alerta es una fila derivada (`source`, `subjectId`, `vehicleId`, `typeCode`, `dueOn`, `daysToExpiry`, `severity`). El BRD §15.3 pide deduplicar por evento + entidad + umbral y reiniciar el ciclo si cambia la fecha: ese contrato queda preparado en la **clave** `key = source:subjectId:dueOn` (una renovación cambia la fecha, es decir, empieza un ciclo nuevo); la deduplicación real de envíos llega con la cola durable.
- **Ajustes** = lo mínimo que las alertas necesitan hoy: ventana y destinatarios. Catálogos, etiquetas, branding, campos, obligatoriedad y cuotas del carril FLT-SETTINGS (Orchestrator §7) siguen pendientes; esta tabla se amplía con ellos.

## Modelo

- **`CompanySettings`**: `tenantId`, `expiryWindowDays`, `recipientRoles`, `version`, `updatedBy` (`user-<subject>`), `updatedAt`. Sin fila, `get` devuelve los valores por defecto con `version: 0`, `updatedBy: null` y `updatedAt: null`.
- **Versión optimista con «versión 0 = no guardado».** El primer guardado envía `version: 0` y es un `INSERT` (la clave primaria decide la carrera: gana exactamente uno, el otro recibe 409 `stale_version`); los siguientes envían la versión de la última lectura y son un `UPDATE` condicional. Un reemplazo sobre una versión que no existe o ya cambió es 409 `stale_version`.
- **Reemplazo completo (PUT)**: `version`, `expiryWindowDays` y `recipientRoles` son obligatorios; cualquier otra propiedad (incluido `tenantId`) es 400.
- **Ventana**: entero de **1 a 30**. Solo puede estrechar los 30 días fijos de los ayudantes de documentos y seguros (`EXPIRING_WINDOW_DAYS`), de modo que el estado «por vencer» de `documents.list` e `insurance.list` (siempre 30 días) y las alertas nunca se contradicen hacia arriba (pregunta abierta 2). Por defecto 30 (BRD §15.1).
- **Destinatarios**: roles (`admin`, `editor`, `viewer`, `auditor`, `pii_reader`), no personas ni correos: no hay PII en la configuración y un cambio de plantilla de rol no deja destinatarios huérfanos. Por defecto `admin` y `editor` (el «Resp. flotilla» del BRD es la plantilla de editor). Una prueba comprueba que la lista de roles del dominio coincide con las plantillas de la composición. Hoy son **datos de configuración**: ningún envío los usa todavía.
- **Alertas**: `severity` es `expiring` (de 0 a `windowDays` días, ambos inclusive) o `expired` (días negativos). Orden: fecha de vencimiento, luego origen y luego id. Filtros `source` (`vehicle_document`, `insurance_policy`), `severity` y `vehicleId`. Páginas 25/50/100 con cursor firmado ligado a tenant y filtro; `total` es la suma de los totales de ambos orígenes; la respuesta lleva `asOf` (fecha UTC) y `windowDays`.
- **Mezcla de dos orígenes sin tabla propia**: cada origen entrega sus filas ordenadas por fecha e id; el servicio lee de cada uno los primeros `offset + limit` y los mezcla. Por eso el desplazamiento está acotado (`MAX_ALERT_OFFSET` = 2 000; más es 400 y el BFF no emite cursor más allá). Con el volumen esperado (cientos de vencimientos por empresa) no es un límite práctico (pregunta abierta 5).
- **Consultas**: documentos con `ownerType = vehicle`, `expiry_key` entre `1950-01-01` y hoy + ventana (rango sobre el índice existente); pólizas por `ends_on`; siempre `company_id`, sin archivados. Un documento sin vencimiento no entra nunca (su clave de orden es `9999-12-31`).
- **Qué ve el navegador**: ids, código de tipo, fechas y días; nunca título, número de documento o de póliza, aseguradora ni personas. La empresa nunca forma parte de la vista.

## Permisos y roles

| Operación                            | Permiso         | admin | editor | viewer | auditor | pii_reader |
| ------------------------------------ | --------------- | ----- | ------ | ------ | ------- | ---------- |
| `alerts.list`, `alerts.settings.get` | `view`          | sí    | sí     | sí     | sí      | sí         |
| `alerts.settings.update`             | `manage_config` | sí    | no     | no     | no      | no         |

Lectura con `view` (las alertas se derivan de documentos y pólizas, que cualquier lector ya puede listar) y escritura con `manage_config`, el permiso de configuración de la plantilla de administrador (BRD S24: «Configuración de empresa… alertas… `manage_config`»). Una prueba comprueba los permisos exactos que cada API pide y otra recorre los 5 roles.

## Valores por defecto elegidos

1. Solo **documentos de vehículo y pólizas**; los documentos de empleado y la licencia (BRD §15.1, fila 3) quedan fuera (pregunta abierta 1).
2. Ventana de 1 a 30 días (por defecto 30); sin umbrales múltiples 30/15/7/0 por separado.
3. Destinatarios por **rol**, de 1 a 5, por defecto `admin` y `editor`; sin destinatarios por área ni por usuario.
4. Fecha UTC del reloj del servicio, sin zona horaria de empresa.
5. Alertas derivadas en cada lectura (nada guardado), con `key` lista para deduplicar.
6. Primer guardado con versión 0; reemplazo completo.
7. Escritura solo con `manage_config`; lectura con `view`.
8. Sin cambio automático de estado del vehículo (BR-013) ni del conductor (BR-012): las alertas informan, no actúan.

## Preguntas abiertas

1. **Documentos de empleado y licencia** (BRD §15.1, «Licencia / documento de conductor próximo a vencer», MVP «Sí»): ¿entran en las alertas base? Los documentos de empleado ya existen (`ownerType = employee`) y bastaría otro origen; se dejó fuera porque la solicitud nombra solo vehículos y seguros y porque quién puede ver vencimientos de personas (PII-adyacente, US-020) es una decisión de permisos. La licencia está en el empleado (`licenseExpiresOn`, cifrada con PII), no en documentos.
2. **Ventana mayor de 30 días y umbrales múltiples** (30/15/7/0, FR-034 «umbrales por tipo»): hoy 1 a 30 y un solo umbral. Ampliar la ventana exige cambiar `EXPIRING_WINDOW_DAYS` en documentos y seguros (su estado «por vencer» es fijo). Umbrales por tipo de documento y «días de anticipación del tipo» (BRD §8.2) esperan al catálogo de empresa.
3. **Destinatarios**: ¿roles, usuarios concretos, responsables del área del vehículo (§15.1: «responsables del área»), conductor con canal (fase 2)? Hoy roles; no se valida contra los miembros reales.
4. **Zona horaria de la empresa** (BRD §14.3, §16.1): «hoy» es la fecha UTC del servidor; un vencimiento puede contarse un día antes o después de la medianoche local. Aceptación de FLT-ALERTS «fecha/zona» pendiente.
5. **Persistencia de alertas, cola durable y deduplicación de envíos** (FR-150/FR-151, §15.3): la tabla de alertas con sus estados (enviada, descartada, leída), el outbox/SQS, el correo con plantilla y los reintentos están diferidos (sin AWS). Con la tabla desaparece también el tope del desplazamiento.
6. **Alertas de vehículos archivados o dados de baja**: se excluyen los documentos y pólizas archivados, pero un documento vigente de un vehículo archivado o en baja sigue alertando (el módulo de vehículos no los archiva en cascada, BR-029 pendiente).
7. **Estado sugerido** (BR-013, FLT-ALERTS: «estado sugerido no evita marcar no apto»): ninguna alerta propone ni cambia estados todavía; despacho consulta el listado.
8. **Resumen diario/semanal** (§15.1, fase 2), silencio nocturno, preferencias por usuario (FR-152) y centro de notificaciones in-app con leído/no leído: fuera de este corte; las alertas actuales no tienen estado por usuario.
9. **Permisos por módulo**: hoy `view` y `manage_config` genéricos; `pii_reader` y `auditor` leen las alertas igual que `viewer`.
10. **Resto del carril FLT-SETTINGS**: catálogos (tipos de documento, vehículo, aseguradoras), branding con contraste, etiquetas, campos personalizados y obligatoriedad, cuotas; y la pantalla `apps/web/settings/company` (ADR-0010).

## Pendientes (no se declaran cumplidos)

Pantallas (ADR-0010), documentos de empleado y licencia en las alertas, umbrales múltiples y ventana mayor de 30 días, destinatarios por usuario o área, zona horaria de la empresa, tabla de alertas, outbox/SQS y correo, deduplicación de envíos por umbral, centro de notificaciones, estado sugerido de vehículo y conductor (BR-012/BR-013), motor de elegibilidad (`packages/domain/eligibility`, `apps/worker/expiry`), catálogos y demás ajustes de FLT-SETTINGS, despliegue (AWS diferido, producción no autorizada).

## Cobertura (niveles 95/95/95/90)

| Paquete                         | Líneas | Ramas | Cómo se mide                                                              |
| ------------------------------- | ------ | ----- | ------------------------------------------------------------------------- |
| `packages/domain/settings`      | 100    | 100   | `pnpm --filter @opslog/domain-settings test:unit` (11)                    |
| `packages/domain/alerts`        | 100    | 98,46 | `pnpm --filter @opslog/domain-alerts test:unit` (12)                      |
| `packages/persistence/settings` | 100    | 100   | `pnpm --filter @opslog/persistence-settings test:unit` (28)               |
| `apps/api/composition` (global) | 99,48  | 98,05 | `pnpm test:platform` (420 pruebas; `alerts.ts` y `settings.ts` 100 / 100) |
| `apps/api/bff`                  | 99,9   | 98,45 | `vitest run apps/api/bff` (190 pruebas; 13 nuevas en `alerts.test.ts`)    |
| `packages/contracts`            | 100    | 99    | `pnpm --filter @opslog/contracts test` (51)                               |

Integración en MySQL 8 real (`OPSLOG_TEST_MYSQL_ADMIN_URL`; local: MySQL 8.0.46): `packages/persistence/settings/src/mysql.integration.test.ts` (11 pruebas: tabla, colaciones binarias y clave primaria por empresa; cada combinación ilegal de los `CHECK` de ajustes —ventana, versión, escritor en blanco y los recortes de la lista de roles—; ids sensibles a mayúsculas; cuenta de mínimo privilegio con `DELETE`, `TRUNCATE`, `DROP` y `ALTER` rechazados; ida y vuelta; primera escritura decidida por la clave primaria; reemplazo por versión; fila fuera de forma tratada como integridad; errores saneados; carreras reales entre dos pools de la primera escritura y de un reemplazo) y `tests/integration/platform/mysql-alerts.test.ts` (6 pruebas: BFF sobre `TypeOrmDocumentStore`, `TypeOrmPolicyStore` y `TypeOrmSettingsStore` reales: consultas de rango con último día inclusivo, límite de 30 y 31 días y archivados excluidos, sin escritura alguna en las tres bases, `company_id` en cada fila y ninguna fila de otra empresa, renovación que reinicia el ciclo, ventana estrechada con la fila `admin,viewer` guardada y auditoría sin valores, carreras desde dos sesiones, roles). Sin la variable se omiten en local y son un fallo duro en CI. Las pruebas sobre almacenes en memoria están en `tests/integration/platform/alerts.test.ts` (18) y `apps/api/bff/src/alerts.test.ts` (13); además `bff.test.ts` (matrices de CSRF, origen, tamaño y aislamiento incluyen `PUT /api/alerts/settings`), `web-client.test.ts` (recorre el cliente tipado y la deriva de rutas) y `client.test.ts`.

## Trazabilidad requisito → prueba

| Requisito                                                                        | Pruebas                                                                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| FR-091 / FR-132 / BR-007 alerta de póliza y documento por vencer o vencidos      | dominio (alertas), `alerts.test.ts` (plataforma y BFF), `mysql-alerts.test.ts`, `web-client.test.ts`                            |
| §15.1 ventana por defecto de 30 días, último día inclusivo (0 días = por vencer) | dominio, `alerts.test.ts` (BFF: 2026-10-05/06, 11-05/11-06 y el paso de medianoche UTC), `mysql-alerts.test.ts`                 |
| FR-034 / S24 ventana configurable por empresa                                    | dominio (ajustes), `store.test.ts`, `mysql.integration.test.ts`, `alerts.test.ts`, `mysql-alerts.test.ts`                       |
| §15.1 destinatarios configurables                                                | dominio (ajustes), `schema.test.ts`, `mysql.integration.test.ts` (`CHECK` de roles), BFF                                        |
| FR-151 / §15.3 renovación reinicia el ciclo (clave con la fecha)                 | dominio (alertas), `alerts.test.ts` (plataforma y BFF), `mysql-alerts.test.ts`                                                  |
| Alertas derivadas de lecturas, sin escribir ni encolar                           | `alerts.test.ts` (plataforma: sin auditoría), `mysql-alerts.test.ts` (recuentos de filas iguales)                               |
| Versión optimista (0 = no guardado) y carreras                                   | dominio, `store.test.ts`, `mysql.integration.test.ts` («real concurrency»), `mysql-alerts.test.ts`, plataforma y BFF            |
| Aislamiento por tenant, `company_id` en todo, ajustes y alertas por empresa      | `store.test.ts`, `mysql.integration.test.ts`, `mysql-alerts.test.ts`, plataforma («adapters»: solo el tenant de la sesión), BFF |
| Cursor firmado ligado a tenant y filtro                                          | `apps/api/bff/src/alerts.test.ts`                                                                                               |
| Roles y permisos (5 roles; `view` y `manage_config` exactos)                     | plataforma («role matrix»), BFF, `mysql-alerts.test.ts`                                                                         |
| Sesión y CSRF en cada ruta                                                       | BFF, `bff.test.ts` (matrices incluyen `PUT /api/alerts/settings`)                                                               |
| Auditoría con lista blanca, sin valores                                          | plataforma (ajustes), `mysql-alerts.test.ts`                                                                                    |
| Cuenta de ejecución sin `DELETE`; `CHECK` NULL-seguros; migración reversible     | `schema.test.ts`, `mysql.integration.test.ts` (sube, baja y sube en la base real)                                               |
| Errores saneados                                                                 | `errors.test.ts`, `store.test.ts`, `mysql.integration.test.ts`, plataforma (500 sin filtración), BFF                            |
| Contrato y cliente tipado                                                        | `packages/contracts/src/client.test.ts`, `web-client.test.ts` (recorre las 3 rutas), prueba de deriva de rutas                  |

## Archivos tocados

- Nuevos: `packages/domain/settings/**`, `packages/domain/alerts/**`, `packages/persistence/settings/**`, `apps/api/composition/src/settings.ts`, `alerts.ts`, `apps/api/bff/src/alerts.test.ts`, `tests/integration/platform/alerts.test.ts`, `mysql-alerts.test.ts`, este documento.
- Editados: `apps/api/composition/src/platform.ts`, `index.ts`, `testing.ts`, `tsconfig.json`; `apps/api/bff/src/routes.ts`; `packages/contracts/src/bff.ts`, `client.ts`, `client.test.ts`; `tests/integration/platform/bff.test.ts`, `web-client.test.ts`, `tsconfig.json`; `package.json`, `tsconfig.json`, `pnpm-lock.yaml`.
