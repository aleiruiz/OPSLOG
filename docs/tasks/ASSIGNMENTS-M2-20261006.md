# ASSIGNMENTS-M2-20261006 — Asignaciones conductor–vehículo (FLT-VEH, slice 3): dominio, persistencia, composición y BFF

```yaml
id: ASSIGNMENTS-M2-20261006
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
slice: third
baseSHA: 4d02024b238c39dc6f91db7743ee29eb803c0964
depends_on:
  [CORE-AUTH, CORE-TENANCY, CORE-AUDIT, CORE-INTEGRATE, VEHICLES-M2-20261006, EMPLOYEES-M2-20261006]
write_paths:
  [
    packages/domain/assignments/**,
    packages/persistence/assignments/**,
    apps/api/composition/**,
    apps/api/bff/**,
    packages/contracts/**,
    tests/integration/platform/**,
    docs/tasks/ASSIGNMENTS-M2-20261006.md,
    package.json,
    tsconfig.json,
    pnpm-lock.yaml,
  ]
```

`package.json`, `tsconfig.json` y `pnpm-lock.yaml` están en `write_paths` solo por el cableado (scripts de prueba, lista de `format:check`, referencias de proyecto e importadores del lockfile). Es el seguimiento que `VEHICLES-M2-20261006` (§ Pendientes: «asignaciones, BR-029») dejó abierto: la asignación conductor–vehículo de BRD/SRD v0.2 §8.7, FR-075, FR-076, FR-053 (parte de datos), BR-002, BR-003, BR-014, US-013 y su criterio de aceptación §22. **Solo backend** (ADR-0010: sin pantallas). Replica Vehículos, Áreas, Empleados, Documentos y Seguros. No toca `docs/baselines`, `apps/web` ni Storybook. Solo datos sintéticos; sin AWS ni red. **Dependencias nuevas: ninguna** (los paquetes nuevos solo cambian los importadores del lockfile).

## Alcance entregado

1. **Dominio** (`packages/domain/assignments`, `@opslog/domain-assignments`): tipos de asignación, normalizadores, `parseNewAssignment`, `parseEnd`, transiciones puras (`newAssignment`, `applyEnd`), eventos, puerto `AssignmentStore`, `InMemoryAssignmentStore`, puertos `AssignmentVehicleGate` y `AssignmentEmployeeGate` y `AssignmentService`. Errores tipados `AssignmentError(code, field?)`.
2. **Persistencia** (`packages/persistence/assignments`): tablas `opslog_vehicle_assignments` y `opslog_vehicle_assignment_events`; migración reversible `CreateVehicleAssignments2026100600080` (el id siguiente a `CreateInsurancePolicies2026100600070`) con `CHECK` como DDL y tres claves únicas; `TypeOrmAssignmentStore` (errores saneados, cierre con `UPDATE` condicional por versión, eventos solo se insertan); cuenta de ejecución `opslog_assignments_*` de mínimo privilegio (`SELECT, INSERT, UPDATE` sobre asignaciones, **sin `DELETE`**; solo `SELECT, INSERT` sobre eventos). `company_id` forma parte de toda clave primaria, de todo índice y de todo filtro.
3. **Composición** (`apps/api/composition/src/assignments.ts`, `platform.ts`): `AssignmentsApi` con sesión + `TenantGate`, rol y permiso resueltos en cada llamada; tenant y actor salen solo de la sesión. Puertas cableadas a `VehicleService.get` y `EmployeeService.get`. Auditoría: `vehicle_assignment.created` y `vehicle_assignment.ended` (acción, tipo, id y actor; nunca motivos ni valores).
4. **BFF y contratos**: `assignments.list`, `assignments.create` (201), `assignments.get`, `assignments.end`, `assignments.history` (5 rutas, bajo `/api/vehicle-assignments`). Lecturas con sesión; escrituras con sesión + CSRF. Cliente tipado `createAssignmentsClient`. **Tres códigos de error nuevos:** `invalid_employee` (422, `field: employee_id`, análogo a `invalid_vehicle`), `principal_taken` (409, `field: vehicle_id` o `employee_id`) y `already_assigned` (409, `field: employee_id`).
5. **Pruebas** (abajo).

## Alcance: qué se entiende por «asignaciones»

La solicitud habla de asignaciones entre vehículos y empleados/áreas. El BRD solo define como entidad con reglas propias la **asignación conductor–vehículo** (§8.7 `VehicleAssignment`, FR-075/076, US-013). La relación vehículo–área y empleado–área ya existe como el campo `areaId` de Vehículos y Empleados (con BR-021 vía `withActiveArea`), sin historial propio en el BRD; **no se modela una entidad de asignación a áreas** (pregunta abierta 1). «Empleado» se acota a los de tipo `driver`: la asignación de un despachador u «otro» a un vehículo no está en el BRD.

## Modelo

- **`VehicleAssignment`** (§8.7): vehículo, conductor (`employeeId`), tipo (`principal` / `secondary` / `temporary`, es decir `Principal` / `Secundario` / `Temporal`), inicio (fecha-hora), fin (`endedAt`; `null` = vigente), motivo y usuario que asigna. Se añaden `endKind` (`ended` o `replaced`), `endReason`, `endedBy`, `version` y `updatedAt`.
- **Inicio = reloj del servidor.** `startedAt` es el instante de la asignación; no se acepta una fecha del cliente (ni pasada ni futura): evita historiales retroactivos y solapes por reloj del cliente (pregunta abierta 3). El fin es el instante del cierre.
- **Una asignación nunca se edita ni se borra.** Solo se **cierra** (`end`, con motivo obligatorio) o la **reemplaza** otra principal. Vehículo, conductor, tipo, motivo e inicio son inmutables; una asignación cerrada es de solo lectura (409 `immutable`). Corregir una asignación es cerrarla y crear otra. Los registros cerrados son el historial de ambas fichas (US-013: «ambas muestran la asignación vigente y la anterior en historial con fechas»): se obtienen con `list?vehicleId=` y `list?employeeId=` (FR-053, parte de datos).
- **Estado derivado, nunca guardado** (`current`): vigente mientras `endedAt` es `null`. El listado filtra `status=current|ended` y los filtros `vehicleId`, `employeeId` y `type`.
- **Eventos de historial (append-only).** Cada asignación tiene un evento `assigned` (`seq` 1) y, al cerrarse, uno `ended` o `replaced` (`seq` 2) con actor, motivo e instante. La tabla de eventos solo admite `INSERT` (la cuenta de ejecución no puede modificar ni borrar) y `seq` lo fija un `CHECK`. `history` los lista, el más reciente primero.
- **Motivo:** 1 a 200 caracteres, una línea (espacios internos colapsados), sin caracteres de control. Es dato de negocio libre: **nunca entra en audit** ni en errores.
- **Reglas del BRD** (BR-002, BR-003, BR-014; ver «Valores por defecto»):
  - A lo sumo **una asignación `principal` vigente por vehículo** (BR-002, FR-076, `[CONFIRMED]`) y **una por conductor** (BR-003, `[PROPOSED]`: activada por defecto, la configuración por empresa para desactivarla es pregunta abierta 2).
  - `secondary` y `temporary` sin límite, salvo **una asignación vigente por par (vehículo, conductor)**: no tiene sentido repetir el mismo par vigente (`already_assigned`).
  - **Elegibilidad** (BR-014): el vehículo debe existir en el tenant, no estar archivado y no estar `inactive` ni `decommissioned`; el empleado debe existir en el tenant, ser `driver`, estar `active` y no archivado. Desconocido, de otro tenant o no elegible dan el mismo 422 (`invalid_vehicle` / `invalid_employee`) sin oráculo entre tenants. Un vehículo en `out_of_service`, `in_maintenance` o `restricted` sí admite asignación (BR-014 solo excluye baja e inactivo); un conductor `suspended` no.
- **Reemplazo** (US-013, §22: «ofrece reemplazar»): `replace: true` (solo para `principal`) cierra la principal vigente del vehículo (`endKind: replaced`, mismo motivo que la nueva) y crea la nueva **en una sola transacción**; la respuesta trae `assignment` y `replaced`. Sin `replace`, una segunda principal da 409 `principal_taken` con `field: vehicle_id` (la principal vigente se consulta con `list?vehicleId=&type=principal&status=current`; el mensaje no incluye datos del conductor para no filtrarlos a quien solo tiene `view`). `replace` no salta BR-003: si el conductor nuevo ya es principal de otro vehículo, `principal_taken` con `field: employee_id`. Pedir `replace` sobre un tipo distinto de `principal` es 400.
- **Unicidad bajo concurrencia: claves únicas, no lectura-escritura.** La tabla guarda dos columnas de bandera que solo la tienda calcula: `current_flag` (1 mientras vigente, `NULL` al cerrar) y `principal_flag` (1 solo para principal vigente, `NULL` en otro caso). Las claves únicas `(company_id, vehicle_id, employee_id, current_flag)`, `(company_id, vehicle_id, principal_flag)` y `(company_id, employee_id, principal_flag)` hacen imposibles los duplicados aunque dos procesos escriban a la vez (en MySQL `NULL` nunca colisiona, así que el historial cerrado no estorba). Un `CHECK` NULL-seguro mantiene las banderas coherentes con `ended_at` y `type`. El servicio comprueba antes para dar el error preciso; la base es la garantía. Al chocar una clave, la tienda re-consulta (fuera de la transacción revertida, ignorando la principal que se estaba reemplazando) y nombra el campo; si el titular ya no está, informa contención y se puede reintentar.
- **Versión optimista:** `version` +1 en cada cambio (solo el cierre). `end` es un `UPDATE` condicional por `(company_id, id, version)`; de dos escritores con la misma versión exactamente uno gana (409 `stale_version` el otro, o `immutable` si ya está cerrada). Un reemplazo cuyo titular cambió entre la lectura y la escritura da `stale_version` y no escribe nada.
- **Listado:** orden por `started_at` descendente y luego id. Páginas 25/50/100 con cursor firmado ligado a tenant y filtro; el historial usa su propio cursor ligado a `['assignment', id, limit]`. 404 uniforme para ids de otro tenant y desconocidos; las vistas no incluyen `tenantId`.
- **Sin FK a `opslog_vehicles` ni a `opslog_employees`** (tablas de otros módulos y otras migraciones); el servicio valida ambos. Lo mismo que Seguros.

## Permisos y roles

Se reutilizan los genéricos igual que en los demás módulos: lectura `view`, asignar `create`, cerrar `edit`. **Un reemplazo pide `create` y `edit`** (cierra una asignación ajena además de crear). No hay `delete`: las asignaciones no se borran ni se archivan.

| Operación                    | Permiso         | admin | editor | viewer | auditor | pii_reader |
| ---------------------------- | --------------- | ----- | ------ | ------ | ------- | ---------- |
| `list`, `get`, `history`     | `view`          | sí    | sí     | sí     | sí      | sí         |
| `create` (sin `replace`)     | `create`        | sí    | sí     | no     | no      | sí         |
| `create` con `replace: true` | `create`+`edit` | sí    | sí     | no     | no      | no         |
| `end`                        | `edit`          | sí    | sí     | no     | no      | no         |

`pii_reader` tiene `create` en la plantilla y puede asignar (sin reemplazar), igual que en Empleados, Documentos y Seguros (pregunta abierta 6). Una prueba comprueba los permisos exactos que `AssignmentsApi` pide en cada operación (incluidos `replace` válido y entradas mal formadas) y otra recorre los 5 roles contra las 6 variantes. Ninguna respuesta incluye PII del conductor: solo su `employeeId` (US-020: despacho no ve PII).

## Valores por defecto elegidos

1. Solo asignación conductor–vehículo; áreas ya son `areaId` en Vehículos y Empleados.
2. BR-003 (un solo vehículo principal por conductor) **activado y no configurable** en este slice.
3. Inicio y fin por reloj del servidor; sin asignaciones retroactivas ni futuras.
4. Una asignación se cierra, nunca se edita ni se borra; corregir = cerrar y crear.
5. Un solo vigente por par (vehículo, conductor), cualquiera que sea el tipo.
6. Motivo obligatorio al asignar y al cerrar (el BRD lista `motivo` en la entidad; el cierre lo exige igual que Vehículos y Empleados exigen motivo en el cambio de estado).
7. `replace` solo para principal, atómico y que respeta BR-003.
8. Elegibilidad por BR-014: conductor `driver` activo no archivado; vehículo no archivado, ni `inactive` ni `decommissioned`. Un solo código de error por lado, sin indicar la causa.
9. Verificación «comprobar y luego actuar» de elegibilidad (ver abajo); la unicidad principal sí es una garantía de base.
10. Sin alertas, sin outbox, sin importación en este slice.

## Limitación aceptada: elegibilidad en paralelo

Las comprobaciones de vehículo y conductor elegibles al crear son «comprobar y luego actuar» sin bloqueo (best effort), igual que la de vehículo en Seguros y la de propietario en Documentos. Si el conductor se suspende o el vehículo se archiva justo entre la comprobación y la escritura, la asignación se crea igual; es el mismo efecto que haberla creado un instante antes del cambio. Hoy cambiar el estado de un empleado o dar de baja un vehículo **no cierra** sus asignaciones vigentes (BR-029 y el cierre por baja del conductor son pendientes; preguntas abiertas 4 y 5).

## Nota de rendimiento

El listado por estado filtra por `current_flag` (nulo o 1) sin índice propio; los índices son `company_id` más vehículo o conductor más `started_at`, y `company_id` más `started_at`. Con el volumen esperado por empresa (cientos de asignaciones por vehículo a lo sumo) no es un problema.

## Preguntas abiertas

1. **Asignación a áreas**: ¿hace falta una entidad de asignación vehículo–área o empleado–área con historial? Hoy son los campos `areaId`, sin historial (el historial unificado FR-077 lo leerá del audit).
2. **BR-003 configurable** (`[PROPOSED] [DECISION REQUIRED]`): desactivar por empresa «un conductor, un solo vehículo principal», y el caso de transporte de personal por turnos (§8.7: varios conductores por día con `temporary`). Hoy siempre activo.
3. **Fechas del cliente**: ¿se permite fijar inicio y fin (turnos futuros, correcciones retroactivas con permiso especial)? Hoy solo reloj del servidor; y zona horaria del tenant para mostrarlas.
4. **BR-029**: dar de baja un vehículo cierra sus asignaciones vigentes (hoy no lo hace, ni el módulo de Vehículos lo exige). Y qué hacer con las asignaciones al archivar un vehículo.
5. **Conductor no apto o dado de baja** (BR-014, BR-012, FR-052): suspender, dar de baja o archivar a un conductor, o licencia vencida, debería advertir o cerrar sus asignaciones; hoy solo se impide asignar a uno no activo. La aptitud (`fitness`) no se exige al asignar.
6. `pii_reader` puede asignar (efecto de `create` genérico); resolver con permisos por módulo, y distinguir «asignar» de «reemplazar» (hoy `edit` extra).
7. **Detalle de rechazo** (§22: «mensaje que identifica a A y ofrece reemplazar»; «rechaza indicando el estatus»): el 409 solo nombra el campo y el 422 no distingue causas. ¿Debe devolver el id de la asignación vigente en conflicto o la causa de elegibilidad? Quien lo necesita consulta el listado o la ficha del empleado.
8. **Bloqueo de elegibilidad** como `withActiveArea` (carrera de conductor o vehículo cambiado en paralelo; ver arriba).
9. **Tipos de asignación configurables** o adicionales (p. ej. «suplente por vacaciones») y turnos.
10. **FK a vehículos y empleados** (hoy ninguna: otras migraciones).
11. **Historial unificado** (FR-077) y **vista del conductor** (FR-053 en pantalla): hoy solo el listado filtrado por `vehicleId` y `employeeId`.
12. **Eventos de outbox** y elegibilidad (BR-013/FLT-ELIG, US-020): no se implementa; el despacho consulta `list?status=current`.
13. **Retención** (BR-009, D19): no hay borrado físico ni purga, a propósito.

## Pendientes (no se declaran cumplidos)

Pantallas (ADR-0010), asignación a áreas, BR-003 configurable, fechas del cliente, BR-029 y cierre por baja de conductor, aptitud al asignar (FR-052), historial unificado del vehículo (FR-077) y exportación a PDF, vista del conductor (FR-053 en pantalla), cambio de conductor con fotos (FR-078), importación, outbox y webhooks, zona horaria del tenant, FK a vehículos y empleados, permisos por módulo, despliegue (AWS diferido, producción no autorizada).

## Cobertura (niveles 95/95/95/90)

| Paquete                            | Líneas | Ramas | Cómo se mide                                                                |
| ---------------------------------- | ------ | ----- | --------------------------------------------------------------------------- |
| `packages/domain/assignments`      | 100    | 96,49 | `pnpm --filter @opslog/domain-assignments test:unit` (19)                   |
| `packages/persistence/assignments` | 100    | 98,73 | `pnpm --filter @opslog/persistence-assignments test:unit` (42)              |
| `apps/api/composition` (global)    | 99,44  | 97,93 | `pnpm test:platform` (396 pruebas; `assignments.ts` 100 / 100)              |
| `apps/api/bff`                     | 99,9   | 98,49 | `vitest run apps/api/bff` (177 pruebas; 15 nuevas en `assignments.test.ts`) |
| `packages/contracts`               | 100    | 99,02 | `pnpm --filter @opslog/contracts test` (50)                                 |

Integración en MySQL 8 real (`OPSLOG_TEST_MYSQL_ADMIN_URL`; local: MySQL 8.0.46): `packages/persistence/assignments/src/mysql.integration.test.ts` (16 pruebas: tablas, colaciones binarias e índices con `company_id` primero; cada combinación ilegal de los `CHECK` de asignación y de evento; las tres claves únicas con escritura directa de cualquier cuenta y la coexistencia de filas cerradas; FK compuesta del evento; cuenta de mínimo privilegio —`DELETE` sobre asignaciones y eventos, `UPDATE` sobre eventos, `TRUNCATE`, `DROP` y `ALTER` rechazados—; ida y vuelta con microsegundos y orden; nombre del campo en cada conflicto; reemplazo atómico con reversión completa ante un choque y cierre obsoleto; campos inmutables; aislamiento por tenant; carreras reales entre dos pools de principal por vehículo, principal por conductor, reemplazos y cierres; errores saneados) y `tests/integration/platform/mysql-assignments.test.ts` (8 pruebas: BFF sobre `TypeOrmAssignmentStore` real: ciclo completo con eventos append-only y banderas en `NULL` al cerrar, `principal_taken` decidido por la base, `company_id` en cada fila, 404 uniforme entre tenants, 422 uniforme de vehículo y conductor, carreras desde dos sesiones, roles y auditoría sin motivos). Sin la variable se omiten en local y son un fallo duro en CI. Las pruebas sobre el almacén en memoria están en `tests/integration/platform/assignments.test.ts` (25) y `apps/api/bff/src/assignments.test.ts` (15); además `bff.test.ts` (matrices de CSRF, origen, tamaño y aislamiento incluyen las rutas de asignaciones), `web-client.test.ts` (recorre el cliente tipado) y `client.test.ts`.

## Trazabilidad requisito → prueba

| Requisito                                                                              | Pruebas                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-075 asignar y desasignar con tipo, fechas y motivo                                  | dominio, `schema.test.ts`, `mysql.integration.test.ts`, `assignments.test.ts` (plataforma y BFF), `web-client.test.ts`                           |
| FR-076 / BR-002 una principal vigente por vehículo                                     | dominio, `store.test.ts`, `mysql.integration.test.ts` (clave única y carrera real), `mysql-assignments.test.ts`, BFF                             |
| BR-003 una principal vigente por conductor                                             | dominio, `store.test.ts`, `mysql.integration.test.ts`, `mysql-assignments.test.ts`, plataforma                                                   |
| US-013 rechazo que nombra el campo y «reemplazar» que cierra la anterior con fecha fin | dominio («US-013»), `store.test.ts` («replacing the principal»), `mysql.integration.test.ts`, BFF («replaces the current principal»), plataforma |
| US-013 ambas fichas muestran la vigente y la anterior en historial                     | plataforma («both views»), BFF                                                                                                                   |
| BR-014 conductor/vehículo no elegible rechazado, sin oráculo entre tenants             | plataforma («ineligible»), BFF («BR-014», «same 422»), `mysql-assignments.test.ts`                                                               |
| Cierre sin edición; asignación cerrada de solo lectura; historial append-only          | dominio, `store.test.ts` («never changes»), `mysql.integration.test.ts` («least privilege», «immutable»), plataforma, BFF                        |
| Unicidad bajo concurrencia (versión y claves únicas)                                   | dominio, `store.test.ts`, `mysql.integration.test.ts` («real concurrency»), `mysql-assignments.test.ts`, plataforma («concurrency»)              |
| Aislamiento por tenant, 404 uniforme, `company_id` en todo                             | plataforma y BFF, `store.test.ts`, `mysql.integration.test.ts`, `mysql-assignments.test.ts`                                                      |
| Cursor firmado ligado a tenant y filtro                                                | `apps/api/bff/src/assignments.test.ts`                                                                                                           |
| Roles y permisos (5 roles, permisos exactos, `replace` = `create`+`edit`)              | plataforma («role matrix»), BFF, `mysql-assignments.test.ts`                                                                                     |
| Sesión y CSRF en cada ruta                                                             | BFF, `bff.test.ts` (matrices incluyen rutas de asignaciones)                                                                                     |
| Auditoría con lista blanca, sin motivos                                                | plataforma (lifecycle), `mysql-assignments.test.ts`                                                                                              |
| Errores saneados                                                                       | `errors.test.ts`, `store.test.ts`, `mysql.integration.test.ts`, plataforma, BFF                                                                  |
| Contrato y cliente tipado                                                              | `packages/contracts/src/client.test.ts`, `web-client.test.ts` (recorre las 5 rutas), prueba de deriva de rutas                                   |

## Hallazgos de la integración en MySQL real

- La prueba de la carrera de principales falló de forma intermitente la primera vez por un defecto **de la prueba**, no del código: reutilizaba conductores entre casos y el ganador aleatorio de una carrera quedaba como principal de otro vehículo (BR-003 lo rechaza, correctamente). Ahora cada caso toma vehículos y conductores nunca usados y los mensajes de aserción llevan los estados observados.
- El nombre de usuario de MySQL admite 32 caracteres: el prefijo `opslog_assignments_` deja 13 para el sufijo aleatorio de la cuenta de prueba (el patrón de cuenta de ejecución sigue siendo `^opslog_assignments_[a-z0-9_]+$`).

## Archivos tocados

- Nuevos: `packages/domain/assignments/**`, `packages/persistence/assignments/**`, `apps/api/composition/src/assignments.ts`, `apps/api/bff/src/assignments.test.ts`, `tests/integration/platform/assignments.test.ts`, `mysql-assignments.test.ts`, este documento.
- Editados: `apps/api/composition/src/platform.ts`, `index.ts`, `testing.ts`, `tsconfig.json`; `apps/api/bff/src/routes.ts`; `packages/contracts/src/bff.ts`, `client.ts`, `client.test.ts`; `tests/integration/platform/bff.test.ts`, `web-client.test.ts`, `tsconfig.json`; `package.json`, `tsconfig.json`, `pnpm-lock.yaml`.
