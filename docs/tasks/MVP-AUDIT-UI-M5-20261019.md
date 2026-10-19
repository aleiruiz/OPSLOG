# MVP-AUDIT-UI-M5-20261019: consulta de auditoría global y por entidad

```yaml
id: MVP-AUDIT-UI-M5-20261019
baseline: [SPEC-1.4, ORCH-1.4, inherited: SPEC/ORCH 1.0-1.3 not superseded]
active_provider: anthropic
model: pin de código vigente según ADR-0007, sin fallback
milestone: M5
kind: implementation
wave: 1 (primer dueño de los archivos compartidos de la ola 1)
base_sha: f2523475ee784307273d9bff9f38aedf58bb3010 (origin/main al asignar; rama claude/mvp-audit-ui)
depends_on:
  - G4 aceptado por el propietario el 2026-10-14 sobre 64bd116 (transcrito en el informe G4; no verificable desde el repositorio)
  - ADR-0016 (alcance por defecto de M5)
requirements:
  [
    FR-170 (reconciliación append-only),
    FR-171,
    US-070,
    BRD §16.1,
    BRD §16.2,
    BRD §16.3,
    BRD S26,
    NFR-PR1,
    NFR-PR5,
    SPECS §4.3 (misma política en audit),
    SPECS §4.4 (audit en la matriz A/B),
    SPECS §9.3 (audit append-only y reconciliado),
    ADR-0016 pregunta 1,
  ]
write_paths:
  - packages/domain/audit-query/**
  - apps/api/audit-query/**
  - apps/web/features/audit/**
  - packages/contracts/src/bff/audit.ts (nuevo)
  - apps/api/bff/src/routes/audit.ts (nuevo) y apps/api/bff/src/audit.test.ts (nuevo)
  - apps/api/composition/src/platform/audit-query-apis.ts (nuevo)
  - tests/integration/platform/audit-query.test.ts (nuevo)
  - tests/integration/platform/mysql-audit-query.test.ts (nuevo)
  - docs/tasks/MVP-AUDIT-UI-M5-20261019.md
shared_paths_owned_in_wave_1:
  - apps/web/app/routes.ts (se divide por grupo de navegación en apps/web/app/routes/*.ts antes de añadir rutas)
  - apps/web/app/ShellNavigation.tsx (grupo «Análisis»)
  - packages/contracts/src/index.ts y packages/contracts/src/bff.ts (registro)
  - apps/api/bff/src/routes.ts
  - apps/api/composition/src/** (registro y tipos)
  - packages/persistence/audit/src/** (solo índices de lectura y lectura paginada; sin cambiar el esquema de escritura)
  - package.json, tsconfig.json (registro del paquete y su comando de pruebas)
forbidden_paths:
  - SPECS.md, Orchestrator.md, docs/baselines/**, Tasks.md, .env*, AWS, producción y datos reales
  - packages/platform/audit/src/** (el sanitizador de escritura no cambia)
  - historiales de módulos (packages/domain/<módulo>/**): solo lectura por puertos
  - apps/web/features/reports/** (la exportación del audit es de MVP-REPORTS PR 2)
status: implemented (PR pendiente de abrir por el orquestador; CI y revisión Opus por headSHA pendientes)
```

## Encargo

Dar a quien tiene `view_audit` una consulta global del audit de su empresa (S26) y a cada ficha una pestaña «Historial» por entidad (FR-171, US-070), sin que el lector vea PII ni importes que su rol no permite. Comprobar además que el audit local es append-only y que el relevo al almacén duradero está reconciliado (FR-170).

Orden de M5, olas y dueños de los archivos compartidos: ADR-0016 §1. Este paquete es el primer dueño de la ola 1 porque es pequeño y deja dividido el registro de rutas web para los demás.

## Estado actual que se reutiliza

- `packages/platform/audit` guarda `action`, `entityType`, `entityId`, `occurredAt`, `actor`, `correlationId` y `data` con solo `attempts`. No guarda valores de campos por diseño (ver «Decisiones registradas en PR 1» de INC-CASES).
- `apps/api/composition/src/platform/events.ts` `listAudit` ya filtra por empresa de la sesión, exige `view_audit` y acota a 30 días y 500 filas.
- Los historiales de módulo con nombres de campos o snapshot `before` sin PII: timeline de siniestros (`opslog_incident_transitions`), timeline de órdenes de trabajo, historial de estado de vehículos y versiones de documentos.

## Alcance

1. **Puerto de consulta** (`packages/domain/audit-query`): filtros `actorId`, `entityType`, `entityId`, `action` (prefijo de allowlist), rango `from`/`to` obligatorio (máximo 366 días), resultado (`success`/`denied` si existe), paginación 25/50/100 con total y orden estable `occurredAt desc, eventId desc`; cursor firmado con empresa (SPECS §4.3).
2. **Etiquetas legibles.** Catálogo de acciones a texto en español por dominio (BRD §16.2) y descripción legible de la entidad resuelta por puertos de módulo (número económico, folio, nombre del área). Una entidad borrada o ajena se muestra como «registro no disponible» sin consultar otra empresa. Nombres de personas solo con `view_pii`; sin él, el rol y un alias estable.
3. **Diff (ADR-0016 pregunta 1, default).** Para siniestros y órdenes: nombres de campos cambiados y valores anteriores y nuevos solo de campos no sensibles que el historial del módulo ya guarda. Campos con PII o importes se muestran como «valor restringido» y no viajan en el payload. Para el resto: acción y entidad. FR-171 queda **parcial en el diff** en la trazabilidad.
4. **Reconciliación** (FR-170, SPECS §9.3): endpoint de administración (`view_audit`) que compara, por rango, las filas del audit local con el relevo duradero (`listPendingAuditEventIds`) y reporta pendientes y su antigüedad. Sin reparar ni editar filas.
5. **BFF:** `GET /api/v1/audit` (global), `GET /api/v1/audit/entities/:entityType/:entityId` (por entidad, exige además permiso de lectura del módulo de la entidad), `GET /api/v1/audit/reconciliation`. Errores con el formato existente.
6. **Web** (`apps/web/features/audit`): pantalla S26 en `/analisis/auditoria` con `FilterBar`, `DataTable`, atajos de fecha en la zona de la empresa y detalle con diff; componente `EntityAuditTab` que las fichas montan en MVP-INTEGRATE. Estados de SPECS §8 (cargando, vacío, sin resultados, error, sin permiso, sesión expirada). Sin exportación en este paquete.
7. **División de `apps/web/app/routes.ts`** en archivos por grupo de navegación, sin cambiar comportamiento ni pruebas existentes, y alta del grupo «Análisis».

## Pruebas de aceptación

1. **Permiso.** Given un miembro sin `view_audit`, Then la consulta global da 403 y la entrada de navegación no aparece; con `view_audit` ve solo su empresa.
2. **Tenant A/B.** Given ids locales iguales en A y B, When A filtra por un `entityId` de B o reutiliza un cursor de B, Then lista vacía o 400 por cursor inválido, nunca filas de B.
3. **Por entidad.** Given `view_audit` sin `incidents:view`, When pide el historial de un siniestro, Then 403; con ambos, ve sus acciones en orden.
4. **Restringidos.** Given un lector sin `view_pii` ni `incidents:view_costs`, Then ni la respuesta ni el DOM contienen nombres de terceros, contacto ni importes; los campos aparecen como «valor restringido».
5. **Rango acotado.** Given un rango de más de 366 días o `from >= to`, Then 400; sin rango, últimos 30 días.
6. **Append-only.** Given la cuenta runtime del audit, Then no puede `UPDATE` ni `DELETE` filas del audit (MySQL real).
7. **Reconciliación.** Given un evento local sin relevo por fixture, Then el reporte lo lista con su antigüedad; tras el relevo, desaparece.
8. **Rendimiento.** Given 200.000 filas sintéticas de audit en una empresa, Then la primera página filtrada p95 ≤ 500 ms (SPECS §9.3, lista ≤ 100 filas) con los índices declarados.
9. **Accesibilidad.** axe sin violaciones en S26 y en la pestaña; navegación completa por teclado.

## Decisiones por defecto

- Sin almacén nuevo de valores (ADR-0016 pregunta 1).
- La exportación del audit (BRD §13.1 «Audit log») es un reporte de MVP-REPORTS PR 2 que consume este puerto; el botón «Exportar» de S26 lo enlaza MVP-INTEGRATE.
- Exportación a SIEM (NFR-S9) fuera de MVP.

## Tamaño

Un PR de unas 1.800 líneas con pruebas, incluida la división de rutas. Ningún archivo de producción supera 400 líneas.

## Fuera de alcance

Escritura de audit nueva, cambios del sanitizador, exportación (MVP-REPORTS), montaje de la pestaña en cada ficha (MVP-INTEGRATE), retención y legal hold (SPECS §2.3 D19).

## Comandos y evidencia

```text
pnpm quality
pnpm test:integration
pnpm exec prettier --check docs/tasks/MVP-AUDIT-UI-M5-20261019.md
git diff --check
```

Registrar SHA, versión exacta de MySQL, empresas sintéticas A/B y la matriz requisito → contrato → implementación → prueba → evidencia para MVP-INTEGRATE. PR listo (no draft), CI verde y la única revisión Opus por PR/SHA (ADR-0007, ADR-0011). El autor no fusiona ni declara G5.

## Registro de implementación

Evidencia local; la verificación vigente es la de CI sobre el headSHA del PR.

- Base: f252347. MySQL local 8.0.46 (CI usa 8.4.11). Empresas sintéticas A y B en `tests/integration/platform/mysql-audit-query.test.ts` y `audit-query.test.ts`.
- p95 de la primera página filtrada sobre 200.000 filas: 127,2 ms (umbral 500 ms), con `ix_audit_projection_entity` e `ix_audit_projection_actor` (migración `AddAuditReadIndexes2026101900010`).
- Rutas BFF: `/api/v1/audit`, `/api/v1/audit/reconciliation`, `/api/v1/audit/entities/:entityType/:entityId` (prefijo `v1`, igual que las rutas vigentes).
- `apps/web/app/routes.ts` se divide en `apps/web/app/routes/{types,shell,plantilla,flota,operacion,analisis,configuracion}.ts`; el orden de resolución se conserva. `routes.ts` mantiene los ayudantes de resolución.
- `packages/contracts/src/bff.ts` mueve sus reexportaciones a `bff/exports.ts` para quedar bajo 400 líneas.

### Desviaciones y límites

- FR-171 queda **parcial en el diff** (ADR-0016 pregunta 1): solo siniestros y órdenes de trabajo; en órdenes únicamente el estado. Campos con PII, importes o texto libre salen como `restricted`; los que el historial no guarda, como `not_recorded`.
- El actor se muestra como rol más alias estable (`U-XXXX`): el contrato de identidad no transporta nombres.
- El camino real del diff sobre un almacén de siniestros en MySQL no tiene prueba de extremo a extremo, porque el almacén en memoria no escribe en el audit de plataforma; el diff se prueba con almacenes en memoria y eventos sembrados.
- `packages/persistence/files/tsconfig.json` incluye `../audit/src/query-store.ts` (TS6307 por el tipo reutilizado).
- Sin botón de exportación: lo enlaza MVP-INTEGRATE (reporte de MVP-REPORTS PR 2).

### Matriz de trazabilidad

| Requisito                  | Contrato                             | Implementación                               | Prueba                                                                                                      |
| -------------------------- | ------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Permiso (1)                | `audit.*` kind `session`, 403        | `AuditQueryApi`, `Platform.authorize`        | `apps/api/audit-query/src/index.test.ts`, `apps/api/bff/src/audit.test.ts`, `features/audit/audit.test.tsx` |
| Tenant A/B y cursor (2)    | cursor firmado con empresa y filtros | `routes/audit.ts`, `query-store.ts`          | `mysql-audit-query.test.ts`, `audit.test.ts` (BFF)                                                          |
| Por entidad (3)            | `audit.entity`                       | `AuditQueryService.forEntity`, `entities.ts` | `service.test.ts`, `audit-query.test.ts`                                                                    |
| Restringidos (4)           | `BffAuditChange.state`               | `diff.ts`                                    | `diff.test.ts`, `audit.test.tsx` (detalle)                                                                  |
| Rango acotado (5)          | 400 `invalid_input`                  | `query.ts`, `range.ts` (web)                 | `query.test.ts`, `range.test.ts`                                                                            |
| Append-only (6)            | grants runtime y relevo              | migraciones de `persistence/audit`           | `mysql-audit-query.test.ts` (MySQL real)                                                                    |
| Reconciliación (7, FR-170) | `audit.reconciliation`               | `reconcileAudit`, `ReconciliationPanel`      | `mysql-audit-query.test.ts`, `audit.test.tsx`                                                               |
| Rendimiento (8)            | índices de lectura                   | migración `AddAuditReadIndexes2026101900010` | `mysql-audit-query.test.ts` (p95 127,2 ms)                                                                  |
| Accesibilidad (9)          | n/a                                  | `features/audit/*`                           | axe en S26, detalle y pestaña; teclado: botones nativos, Escape y retorno de foco (`audit.test.tsx`)        |
