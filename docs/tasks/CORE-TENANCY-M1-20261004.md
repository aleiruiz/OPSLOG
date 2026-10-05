# CORE-TENANCY-M1-20261004 — aislamiento y provisión multitenant desde cero

```yaml
id: CORE-TENANCY-M1-20261004
baseline: [SPEC-1.2, ORCH-1.2, inherited: SPEC-1.0/ORCH-1.0, SPEC-1.1/ORCH-1.1]
milestone: M1
kind: implementation
baseSHA: 810e1e3d842ac6c8aa1cb7816a0bbe8f77b95f71
depends_on: [G0-human-reaffirmed]
write_paths:
  [
    apps/api/tenants/**,
    packages/domain/tenants/**,
    packages/persistence/tenancy/**,
    infra/database/**,
    docs/tasks/CORE-TENANCY-M1-20261004.md,
    package.json,
    pnpm-lock.yaml,
    pnpm-workspace.yaml,
    tsconfig.json,
  ]
forbidden_paths:
  [
    SPECS.md,
    Orchestrator.md,
    docs/baselines/**,
    Tasks.md,
    .orchestrator/**,
    .env*,
    packages/contracts/**,
    apps/api/auth/**,
    AWS,
    production,
  ]
```

Implementar un slice nuevo de tenant control-plane y resolución de contexto sin copiar PR12 ni sus ramas. Debe crear/provisionar tenant, validar estado activo/suspendido, producir contexto inmutable y separar credenciales/directorios por tenant; nunca aceptar host/database/secret desde request.

Aceptación mínima: tenant A no puede resolver ni consultar B; tenant inexistente/suspendido deniega uniformemente; IDs son UUIDv7 opacos; provisión/reintento es idempotente y coordinado mediante lease persistente; membership projection aplica únicamente versiones nuevas de forma transaccional; el tenant no se activa hasta migraciones, rol runtime restringido y prueba de aislamiento verificables; no hay usuario master ni SQL manual en runtime. Agregar pruebas A/B con IDs locales iguales, cabeceras manipuladas, revocación, rollback y concurrencia en MySQL 8.0.45 sintético.

## Requisitos de implementación

- Persistencia control-plane mediante TypeORM 1.1.1, `DataSource`, `EntitySchema`, repositorios y migraciones versionadas. `synchronize` y migraciones automáticas al arranque permanecen desactivados.
- El runtime control-plane usa cuenta dedicada `opslog_control_*`; el runtime operativo usa usuario dedicado `opslog_u_*`, contraseña resuelta por referencia/versionado confiable y base del `TenantContext`. El request no provee host, database ni credenciales.
- El backend de aprovisionamiento crea la base aislada y credencial con privilegios DML mínimos, aplica migraciones y verifica DDL denegado e inaccesibilidad cross-database. Evidencia incompleta deja el tenant inactivo y activa compensación.
- El job de provisión guarda clave idempotente única, hash de payload, intentos, owner y vencimiento de lease en MySQL. El reclamo usa bloqueo transaccional de fila, compatible con múltiples procesos.
- Proyecciones de membresía toman bloqueo de fila y comparan versión en la misma transacción que incrementa authorizationVersion ante revocación.
- Identificadores generados por esta capa son UUIDv7 de aplicación; el motor MySQL no los genera.
- `pnpm quality` incluye workspace, format, typecheck, pruebas unitarias e integración. El test admin URL solo se configura para el harness sintético.

## Evidencia de implementación

Archivos principales: `packages/persistence/tenancy/src/index.ts`, `entities.ts`, `migrations.ts`, `mysql.integration.test.ts`; `packages/domain/tenants/src/index.ts`; `apps/api/tenants/src/index.ts`.

La auditoría reportó brechas en persistencia durable, MySQL real, leases, evidencia de activación, UUIDv7 y registro del paquete en CI. Esta continuación debe cerrar cada punto en este PR y dejar los comandos/resultados reales aquí. No declarar el gate ni la auditoría como aprobados.

### Resultados de validación de esta continuación

- `pnpm lint`: pasó (ejecutado como primer paso de `pnpm quality`).
- `pnpm exec prettier --check` sobre todos los archivos modificados de esta tarea: pasó.
- `pnpm typecheck`: pasó.
- `pnpm test:unit`: pasó; contratos 7, UI/accesibilidad 2 + 2, UUIDv7 2, persistencia tenancy 5 y harness 4.
- `pnpm test:integration`: pasó; harness MySQL 8.0.45 1 y persistencia tenancy 2, usando únicamente la base sintética local.
- `pnpm build`: pasó.
- `pnpm quality`: no completó porque el `format:check` global reportó 38 archivos preexistentes fuera del alcance de esta tarea; ninguno de los archivos modificados de tenancy aparece en esa lista. No se reformatearon archivos ajenos.
- Revisión de alerta de fixture: se eliminaron los UUID literales del test; las identidades se generan en runtime mediante el generador UUIDv7 del dominio. Son valores efímeros usados solo en memoria por pruebas y no representan credenciales ni recursos externos. Conteo local de UUID estáticos en el archivo: 0.
- Entorno de esta remediación: Node 24.19.0 y pnpm 11.25.0. Typecheck, todas las pruebas unitarias, integración MySQL sintética (harness 1 y tenancy 2), build y Prettier scoped pasaron. `pnpm quality` sigue limitado por los mismos 38 archivos preexistentes listados por `format:check` global.
- `git diff --check`: pendiente de verificación final. El escaneo remoto/CI y la auditoría independiente del SHA final quedan pendientes; no se declara ningún gate aprobado.

Leer instrucciones, baselines, ADR-0001/0002/0004/0005, SESSION_HANDSHAKE, AUTONOMOUS_ORCHESTRATOR y SPECS §4–§7. Usar solo fixtures sintéticos/locales. El autor no audita ni fusiona. Si se necesita contrato compartido o lockfile, detenerse y pedir reasignación.
