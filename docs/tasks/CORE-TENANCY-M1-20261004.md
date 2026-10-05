# CORE-TENANCY-M1-20261004 — aislamiento y provisión multitenant desde cero

```yaml
id: CORE-TENANCY-M1-20261004
baseline: [SPEC-1.3, ORCH-1.3, inherited: SPEC-1.0/ORCH-1.0, SPEC-1.1/ORCH-1.1, SPEC-1.2/ORCH-1.2]
milestone: M1
kind: implementation
baseSHA: 2cb37c66e57a8d63662706a9cb454196203411a6
depends_on: [G0-human-reaffirmed]
write_paths: [packages/persistence/tenancy/src/**, docs/tasks/CORE-TENANCY-M1-20261004.md]
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

### Evidencia del checkpoint anterior (no corresponde al SHA de esta reparación)

- `pnpm lint`: pasó (ejecutado como primer paso de `pnpm quality`).
- `pnpm exec prettier --check` sobre todos los archivos modificados de esta tarea: pasó.
- `pnpm typecheck`: pasó.
- `pnpm test:unit`: pasó; contratos 7, UI/accesibilidad 2 + 2, UUIDv7 2, persistencia tenancy 5 y harness 4.
- `pnpm test:integration`: pasó; harness MySQL 8.0.45 1 y persistencia tenancy 2, usando únicamente la base sintética local.
- `pnpm build`: pasó.
- `pnpm quality`: no completó porque el `format:check` global reportó 38 archivos preexistentes fuera del alcance de esta tarea; ninguno de los archivos modificados de tenancy aparece en esa lista. No se reformatearon archivos ajenos.
- Revisión de alerta de fixture: se eliminaron los UUID literales del test; las identidades se generan en runtime mediante el generador UUIDv7 del dominio. Son valores efímeros usados solo en memoria por pruebas y no representan credenciales ni recursos externos. Conteo local de UUID estáticos en el archivo: 0.
- Entorno de esta remediación: Node 24.19.0 y pnpm 11.25.0. Typecheck, todas las pruebas unitarias, integración MySQL sintética (harness 1 y tenancy 2), build y Prettier scoped pasaron. `pnpm quality` se reportó limitado por 38 archivos preexistentes en el `format:check` local del autor (corrección: ese fallo no se reproduce en una exportación limpia de este SHA; ver remediación Opus 5.5).
- `git diff --check`: pendiente de verificación final. El escaneo remoto/CI y la auditoría independiente del SHA final quedan pendientes; no se declara ningún gate aprobado.

## Remediación posterior al informe de auditoría única — base 2cb37c6 (SPEC/ORCH-1.3)

- Fencing/rollback: cada claim incrementa `attempt`; el backend recibe `attempt` y `leaseOwner`. Base, referencia de credencial y versión son específicas por intento; la activación y mutaciones de fallo comparan owner+attempt+estado vigente. Un rollback viejo no puede borrar recursos del intento ganador.
- Pools: `TenantDataSourceFactory.acquire` comparte fuentes por tenant+secretVersion, limita fuentes/conexiones/leases/cola, aplica backpressure acotado, eviction LRU solo de fuentes idle y lifecycle explícito (`release`, `evictTenant`, `close`).
- URL admin de integración: se acepta solo `localhost`, `127.0.0.1` o `::1`; la validación ocurre antes de crear conexión y antes de cualquier DDL. El test remoto verifica que el callback de conexión/DDL no se invoca.
- Fixtures: todos los IDs de tenant, cabecera hostil y registro local A/B se generan al ejecutar tests; A y B comparten en memoria el mismo ID local requerido por la prueba de aislamiento. No hay UUID literal ni credenciales/recursos externos en fixtures.
- MySQL 8.0.45 sintético: `pnpm --filter @opslog/persistence-tenancy test:integration` pasó 4 tests, incluyendo lease expirado/reasignado con ganador activo, ausencia de borrado del DB ganador, caché/rotación de secretVersion/eviction y rechazo de host remoto antes de DDL.
- Unitarias de tenancy: 7 tests pasaron, incluyendo límites, cola/backpressure, pooling por versión y cierre.
- Con Node 24.19.0/pnpm 11.25.0: lint, typecheck, `pnpm test:unit` (contratos 7, UI/accesibilidad 2+2, dominio 2, tenancy 7, harness 4), `pnpm test:integration` (harness MySQL 1, tenancy MySQL 4), build y Prettier scoped pasaron.
- `pnpm quality` completo se ejecutó; se detuvo en `format:check` por 38 archivos preexistentes ajenos al scope. Ninguno de los cuatro paths modificados aparece en el reporte tras formatear esta nota. No se reformatearon archivos ajenos.
- La validación remota CI/GitGuardian sobre el SHA que publique esta reparación y la auditoría independiente siguen pendientes; no declarar gate ni auditoría aprobados.

### Reparación de concurrencia de pools — base e82bd18 (auditoría independiente pendiente)

- `TenantDataSourceFactory` serializa las decisiones que mutan el pool. La entrada y su lease de reserva se registran antes de esperar `initialize()`: adquisiciones frías del mismo tenant/version comparten el mismo `ready`, y adquisiciones de claves distintas cuentan inmediatamente contra `maxDataSources`.
- La misma exclusión coordina lectura/caché, eviction por versión, creación, liberación, `evictTenant` y `close`; una reserva fallida no deja una fuente huérfana. Se mantiene la comprobación de tenant, versión, base, referencia y fingerprint de contraseña para entradas concurrentes.
- Se añadieron pruebas deterministas con resolvers sincronizados: dos adquisiciones frías de la misma clave crean una sola fuente; dos tenants distintos con límite 1 producen exactamente un lease y un rechazo de capacidad. En ambos casos el cierre destruye la única fuente creada; la prueba existente cubre liberación, rotación/eviction y rechazo de cierre con leases activos.
- Verificación de esta reparación: `pnpm lint`, `pnpm test:unit` (incluye 9 unitarias de tenancy), `pnpm test:integration` (harness sintético 1 y tenancy/MySQL 8 sintético 4), `pnpm build`, typecheck de tenancy, Prettier scoped y `git diff --check` pasaron. jsdom/axe emitió avisos conocidos de `HTMLCanvasElement.getContext`, pero sus pruebas pasaron.
- No se declara aprobado el gate ni la auditoría. CI/escaneo remoto y la única auditoría independiente requerida para el SHA final siguen pendientes.

Leer instrucciones, baselines, ADR-0001/0002/0004/0005, SESSION_HANDSHAKE, AUTONOMOUS_ORCHESTRATOR y SPECS §4–§7. Usar solo fixtures sintéticos/locales. El autor no audita ni fusiona. Si se necesita contrato compartido o lockfile, detenerse y pedir reasignación.

## Remediación tras revisión de código Opus 5.5 (SHA 17e6050)

- Rollback con fencing: antes de `adapter.rollback`, `runProvisioning` relee el job bajo bloqueo. Si el intento ya está `succeeded` (acuse de commit perdido) devuelve el tenant activo y no borra su base ni usuario; si no puede probar el estado, no hace rollback y falla.
- Tope de intentos: `claimJob` rechaza con `ATTEMPTS_EXHAUSTED` tras 5 intentos; cada intento usa base/credencial propias, por lo que un fallo persistente ya no crea recursos sin límite. El comentario sobre reutilizar la ubicación quedó corregido.
- `TenantDataSourceFactory.acquire` solo acepta contextos emitidos por `TenantContextResolver` (WeakSet en `trusted-context.ts`); `testing.ts` (no exportado desde el entry point) permite a las pruebas marcar contextos construidos a mano.
- `destroy()` ya no se espera dentro del bloqueo del pool: las entradas se desvinculan bajo el bloqueo y se liberan después, así un `pool.end` lento no bloquea a otros tenants.
- Pruebas nuevas (unitarias): contexto no emitido por el resolver es rechazado sin resolver credenciales; adquirir otro tenant mientras un `destroy` está colgado.
- Sin MySQL local (no hay Docker/mysqld en este entorno) no se ejecutaron las pruebas de integración; las rutas nuevas de acuse perdido y tope de intentos no tienen prueba de integración todavía y quedan cubiertas solo por la revisión.
- Decisiones/pendientes que no se cambiaron: `authorizationVersion` sigue siendo por tenant (revocar a un miembro invalida las sesiones de todo el tenant; el miembro revocado ya se deniega por su estado de membresía, por lo que mover la versión a la membresía es una decisión de diseño de SPECS §4.2); suspensión sin `evictTenant` automático; sin cola por capacidad de data sources; migraciones MySQL no transaccionales; idempotencia global (no por actor); sin guardia de transición en `setTenantStatus`; igualdad exacta de `migrationVersion`.
- Alcance: este PR modifica `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `packages/domain/tenants` y `apps/api/tenants`, fuera de `write_paths` original; el usuario autorizó ampliar el alcance el 2026-10-05.
- PR #15 también edita `package.json` (`format:check`, `test:unit`) y `tsconfig.json`: resolver ese conflicto al fusionar el segundo PR.
