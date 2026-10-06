# EMPLOYEES-M2-20261006 — módulo Empleados (FLT-PEOPLE, slice 2): dominio, persistencia, cifrado de PII, composición y BFF

```yaml
id: EMPLOYEES-M2-20261006
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
slice: second
baseSHA: 34d92fa346ac1137d06bf653a287e67f62c3426c
depends_on:
  [CORE-AUTH, CORE-TENANCY, CORE-AUDIT, CORE-INTEGRATE, VEHICLES-M2-20261006, AREAS-M2-20261006]
write_paths:
  [
    packages/platform/pii/**,
    packages/domain/employees/**,
    packages/persistence/employees/**,
    apps/api/composition/**,
    apps/api/bff/**,
    packages/contracts/**,
    tests/integration/platform/**,
    docs/tasks/EMPLOYEES-M2-20261006.md,
    package.json,
    tsconfig.json,
    pnpm-lock.yaml,
  ]
```

`package.json`, `tsconfig.json` y `pnpm-lock.yaml` están en `write_paths` solo por el cableado (scripts de prueba, lista de `format:check`, referencias de proyecto e importadores del lockfile). Segundo slice de FLT-PEOPLE (BRD/SRD v0.2, FR-050.., BR-009, BR-021, SPECS D23). **Solo backend** (ADR-0010: sin pantallas). Replica Vehículos y Áreas. No toca `docs/baselines`, `apps/web` ni Storybook. Solo datos sintéticos; sin AWS ni red. **Dependencias nuevas: ninguna** (los paquetes de trabajo nuevos solo cambian los importadores del lockfile; `typeorm`, `mysql2` y `reflect-metadata` ya estaban y el cifrado usa `node:crypto`).

## Alcance entregado

1. **PII** (`packages/platform/pii`, `@opslog/platform-pii`). No existía un puerto KMS, así que se define uno pequeño: `KmsPort` (`generateDataKey`, `decryptDataKey`, `mac`) y `PiiCipher` (`seal`, `open`, `blindIndex`). `EnvelopePiiCipher`: una clave de datos por valor, AES-256-GCM, y el contexto `{tenantId, entityType, entityId, field}` como AAD y como contexto de cifrado del KMS (un sobre copiado a otra fila, otro campo u otro tenant no abre). Formato `pii1.<keyId>.<clave envuelta>.<iv>.<texto||etiqueta>` en base64url. Índice ciego: HMAC hexadecimal (`kms.mac`) sobre `['opslog.blind.v1', campo, valor normalizado]`, ligado al tenant. `LocalDevKms`: **solo pruebas y desarrollo**, clave maestra de ≥ 32 bytes que viene de configuración (`fromBase64`) o efímera (`ephemeral()`), se niega a construirse en producción (argumento `environment`, `NODE_ENV` u `OPSLOG_ENV` = `production`). Errores `KmsError` y `PiiError` de mensaje fijo (sin valores, ids ni claves). `src/testing/kms-contract.ts` exporta `describeKmsPortContract(nombre, fábrica)`: la suite de contrato que deberá pasar cualquier adaptador AWS KMS.
2. **Dominio** (`packages/domain/employees`): tipos, normalizadores, `parseNewEmployee`, `parseEmployeePatch`, `fitnessOf`, transiciones puras, puerto `EmployeeStore` (con `countLiveInArea`), `InMemoryEmployeeStore` y `EmployeeService` (puerto `EmployeeAreaGate`, `reveal`, `fitness`). Errores tipados `EmployeeError(code, field?)`.
3. **Persistencia** (`packages/persistence/employees`): tablas `opslog_employees` y `opslog_employee_history`; migración reversible `CreateEmployees2026100600050` con `CHECK` como DDL; `TypeOrmEmployeeStore` (errores saneados, `UPDATE` condicional por versión); cuenta de ejecución solo DML. `company_id` forma parte de la clave primaria y de toda clave única y filtro.
4. **Composición** (`apps/api/composition/src/employees.ts`, `platform.ts`): `EmployeesApi` con sesión + `TenantGate`, rol y permiso resueltos en cada llamada; tenant y actor salen solo de la sesión. Cableado del puerto de personas de Áreas (BR-021) y de la puerta de área. Auditoría: `employee.created`, `employee.updated`, `employee.status_changed`, `employee.archived`, `employee.pii_viewed` (acción, tipo, id y actor; nunca valores).
5. **BFF y contratos**: `employees.list`, `employees.create` (201), `employees.get`, `employees.update` (PUT), `employees.status`, `employees.archive`, `employees.history` (7 rutas, bajo `/api/employees`). Lecturas con sesión; escrituras con sesión + CSRF. Cliente tipado `createEmployeesClient`. Sin códigos de error nuevos (`invalid_area` ya existía).
6. **Pruebas** (abajo).

## Modelo

- **Tipo** (`kind`): `driver`, `dispatcher`, `other`; inmutable. Mecánicos diferidos.
- **Estados:** `active`, `inactive`, `suspended`, `terminated`. `terminated` es terminal y de solo lectura (409 `immutable` al editar, 409 `invalid_transition` al cambiar de estado). El estado inicial es `active` con motivo «Alta». Cada cambio de estado exige motivo y deja historial. El archivado (BR-009) es baja lógica y se permite desde cualquier estado; un empleado archivado es de solo lectura.
- **Obligatorios:** `kind`, `firstName`, `lastName`, `areaId`. Opcionales: `employeeNumber` (único por empresa, sin distinguir mayúsculas), `position`, `hireDate`, `idType` + `nationalId` (juntos o ninguno), `phone`, `email`, `licenseNumber`, `licenseType`, `licenseExpiresOn`. Los datos de licencia son solo para conductores.
- **Una sola área por empleado** (columna `areaId`); validada contra áreas ACTIVAS del mismo tenant.
- **Aptitud (fitness)**: derivada, nunca guardada; `null` para no conductores. Razones: `not_active`, `archived`, `license_missing`, `license_expired`. El último día de vigencia es inclusivo; «hoy» es la fecha UTC del reloj del servicio.
- **Historial** (`opslog_employee_history`): entradas `status` (de/a, con motivo) y `area` (ids de área de/a, motivo nulo). Paginado, más reciente primero. Actor `user-<subject>`; nunca PII.

## PII (SPECS D23)

| Campo                                                | En reposo                                            | Índice ciego                      | Unicidad por empresa |
| ---------------------------------------------------- | ---------------------------------------------------- | --------------------------------- | -------------------- |
| `nationalId`                                         | sobre `pii1.…` (AES-256-GCM + KMS)                   | sí, sobre `idType:número normal.` | sí                   |
| `email`                                              | sobre                                                | sí                                | sí                   |
| `licenseNumber`                                      | sobre                                                | sí                                | **no** (solo índice) |
| `phone`                                              | sobre                                                | no                                | no                   |
| fecha de nacimiento                                  | **no se recoge** (minimización)                      | —                                 | —                    |
| `idType`, `licenseType`, `licenseExpiresOn`, nombres | texto plano (no son PII de alto riesgo por sí solos) | —                                 | —                    |

- Nunca en logs, auditoría, errores ni listados. Los listados y las respuestas de escritura llevan solo `piiPresent` (banderas), nunca valores.
- `get` descifra solo si el llamante tiene `view_pii`; si no, `pii: null` (enmascarado). La divulgación se audita como `employee.pii_viewed` **antes** de devolverla; si la auditoría falla, no sale nada (falla cerrada). No se audita cuando no hay nada que divulgar.
- **Escribir** nationalId, idType, phone, email o licenseNumber exige además `view_pii`. Motivo: si no, un `editor` podría usar el 409 `duplicate` como oráculo para saber si una identificación o un correo existen sin poder leerlos. Se resuelve el permiso (403) antes de cualquier comprobación de duplicados.
- Un fallo de KMS o de cifrado se convierte en 500 genérico sin escribir fila. Un valor que no se puede descifrar da 500 solo en la lectura individual de quien tiene `view_pii`.
- El sellado (llamadas al KMS) ocurre antes de tomar el candado de áreas; solo la escritura va dentro del candado.

## Permisos y roles

Se reutilizan los genéricos igual que en Vehículos: lectura `view`, alta `create`, cambios (editar, estado) `edit`, archivar `delete`, y `view_pii` para leer y escribir PII.

| Rol        | Lee | Alta (sin PII) | Alta con PII | Edita / estado | Edita PII | Archiva | Ve PII |
| ---------- | --- | -------------- | ------------ | -------------- | --------- | ------- | ------ |
| admin      | sí  | sí             | sí           | sí             | sí        | sí      | sí     |
| editor     | sí  | sí             | no           | sí             | no        | no      | no     |
| viewer     | sí  | no             | no           | no             | no        | no      | no     |
| auditor    | sí  | no             | no           | no             | no        | no      | no     |
| pii_reader | sí  | sí             | sí           | no             | no        | no      | sí     |

`pii_reader` tiene `create` en la plantilla, por lo que puede dar de alta empleados (con PII). **No se cambia** (pregunta abierta 1). Una prueba comprueba los permisos exactos que `EmployeesApi` pide en cada operación con un autorizador de prueba.

## Reglas de negocio

- **BR-021:** desactivar un área cuenta empleados vivos con `countLiveInArea(tenantId, areaId)`: no archivados y no `terminated`. Los `inactive` y `suspended` **sí cuentan** (pueden volver a trabajar en esa área). Respuesta 409 `area_in_use` con `field: people`. Terminar o archivar libera el área. `adapters.people` se conserva solo como sustitución de pruebas.
- **Puerta de área:** crear o cambiar `areaId` pasa por `EmployeeAreaGate` = `AreaService.withActiveArea` (el mismo candado por tenant que usa Vehículos y `deactivate`). Un `areaId` sin cambios no se comprueba. Desconocida, ajena e inactiva dan el mismo 422 `invalid_area` (`field: area_id`) sin oráculo entre tenants. Asignación y desactivación concurrentes: gana exactamente una (en memoria y en MySQL).
- **Orden del listado:** por `name_key` (apellido y luego nombre, en minúsculas), luego id, en orden de unidades de código. Las letras con acento quedan después de «z» (igual que Vehículos). Está documentado y es la pregunta abierta 12.
- Listado: páginas 25/50/100, cursor firmado ligado a tenant y filtro (`kind`, `status`, `areaId`, `includeArchived`); el historial usa su propio cursor ligado a `['employee', id, limit]`.
- 404 uniforme para ids de otro tenant y desconocidos; las vistas no incluyen `tenantId`; concurrencia optimista con `version` (409 `stale_version`).

## Valores por defecto elegidos

1. KMS local en memoria (`LocalDevKms`) hasta que exista el adaptador AWS; la plataforma lo usa por defecto y **falla al construirse** si el entorno es de producción.
2. `phone` se normaliza a `+` y dígitos; sellado sin índice (no se busca ni se deduplica por teléfono).
3. nationalId y email únicos por empresa; la licencia solo se indexa.
4. `kind` inmutable; archivado desde cualquier estado.
5. «Hoy» para la vigencia de la licencia es la fecha UTC del reloj.
6. Escribir PII exige `view_pii` además de `create`/`edit`.
7. El historial de área no guarda motivo; el de estado sí.
8. Sin nacimiento, foto, supervisor, turno ni campos personalizados.

## Preguntas abiertas

1. `pii_reader` puede crear empleados (efecto de `create` genérico). Resolver con permisos por módulo.
2. **Una sola área por empleado:** se impone con la columna única `areaId`; ¿hace falta pertenencia a varias áreas o un empleado «sin área»?
3. **Duplicados por índice ciego:** nationalId y email son únicos; la licencia solo se indexa, no es única. ¿Debe serlo (p. ej. por tipo y emisor)?
4. **Borrado, anonimización y retención de PII:** no hay borrado físico (BR-009). Falta decidir plazo de retención, anonimización al terminar y atención de solicitudes de supresión.
5. **KMS local falso (decisión del propietario):** `LocalDevKms` no protege nada real; sirve para pruebas y desarrollo. Antes de cualquier dato real hace falta el adaptador AWS KMS (que pase `describeKmsPortContract`), políticas de claves, rotación y alta disponibilidad. AWS está diferido y producción no autorizada; se pide confirmar el alcance y el momento.
6. ¿Un empleado `inactive` o `suspended` debe bloquear la desactivación del área (hoy sí; igual que la pregunta 6 de Vehículos)?
7. Archivado desde cualquier estado (incluido `active`): ¿se exige terminar antes?
8. `kind` inmutable: ¿se permite reclasificar (p. ej. conductor a despachador)?
9. Aptitud: zona horaria del tenant (hoy UTC) y documentos obligatorios (diferidos).
10. Búsqueda por PII (consulta por índice ciego, p. ej. buscar por identificación) diferida: requiere permiso, auditoría y límites de frecuencia.
11. ¿Escribir PII debe exigir `view_pii` (hoy sí, para evitar el oráculo de duplicados)? Tiene el efecto de que un `editor` no puede dar de alta a un conductor con identificación.
12. Orden de nombres con acentos (orden de unidades de código) frente a una colación de idioma.

## Pendientes (no se declaran cumplidos)

Pantallas (ADR-0010), foto, tipo de vinculación, supervisor, turno, campos personalizados, vínculo con usuario, documentos, importación CSV, asignaciones, mecánicos, filtro por aptitud, outbox y webhooks (`driver.eligibility_changed`), FR-022 (alcance por áreas), adaptador AWS KMS y rotación de claves, despliegue (AWS diferido, producción no autorizada).

## Cobertura (niveles 95/95/95/90)

| Paquete                          | Líneas | Ramas | Cómo se mide                                                     |
| -------------------------------- | ------ | ----- | ---------------------------------------------------------------- |
| `packages/platform/pii`          | 100    | 98,98 | `pnpm --filter @opslog/platform-pii test:unit` (25)              |
| `packages/domain/employees`      | 99,85  | 97,7  | `pnpm --filter @opslog/domain-employees test:unit` (36)          |
| `packages/persistence/employees` | 100    | 98,8  | `pnpm --filter @opslog/persistence-employees test:unit` (48)     |
| `apps/api/composition` (global)  | 99,54  | 98,23 | `pnpm test:platform` (289 pruebas; `employees.ts` 99,55 / 98,21) |
| `packages/contracts`             | 100    | 98,89 | `pnpm --filter @opslog/contracts test` (47)                      |

Integración en MySQL 8 real (`OPSLOG_TEST_MYSQL_ADMIN_URL`; local: `mysql://root@127.0.0.1:33306`, MySQL 8.0.46): `packages/persistence/employees/src/mysql.integration.test.ts` (23 pruebas: CHECK, cuenta solo DML, sin texto plano en filas, aislamiento, concurrencia, conteo, listado, migración reversible) y `tests/integration/platform/mysql-employees.test.ts` (10 pruebas: BFF sobre `TypeOrmEmployeeStore` y `TypeOrmAreaStore` reales: ciclo completo, sin PII en claro en filas, 404 entre tenants, índices ciegos distintos por empresa, roles y enmascarado, duplicados, dos sesiones concurrentes, conteo BR-021, 422 uniforme, asignación vs. desactivación con retención y 12 carreras). Sin la variable se omiten en local y son un fallo duro en CI.

## Trazabilidad requisito → prueba

| Requisito                                                                       | Pruebas                                                                                                                                               |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRUD de empleado, perfil y estado con motivo e historial                        | `domain/employees/src/index.test.ts`, `tests/integration/platform/employees.test.ts`, `apps/api/bff/src/employees.test.ts`, `mysql-employees.test.ts` |
| Baja lógica (BR-009), solo lectura tras terminar o archivar                     | dominio, `employees.test.ts` («business rules»), `schema.test.ts`                                                                                     |
| Área activa del mismo tenant (BR-021) y 422 uniforme                            | `employee-area.test.ts`, `mysql-employees.test.ts`, dominio                                                                                           |
| Desactivar área con personas vivas → 409 `people`; liberar al terminar/archivar | `employee-area.test.ts`, `mysql-employees.test.ts`, `store.test.ts`, `mysql.integration.test.ts`                                                      |
| Asignación vs. desactivación concurrentes (retención y 25/12 carreras)          | `employee-area.test.ts`, `mysql-employees.test.ts`                                                                                                    |
| Cifrado de PII (sobre + índice ciego), contexto/AAD, local solo no-producción   | `packages/platform/pii/src/*.test.ts`, `employees.test.ts` («personal data protection»), `mysql-employees.test.ts`, `mysql.integration.test.ts`       |
| PII enmascarada sin `view_pii`, nunca en listados ni errores                    | `employees.test.ts`, `apps/api/bff/src/employees.test.ts`, `mysql-employees.test.ts`                                                                  |
| PII no en logs, auditoría, errores ni filas                                     | `employees.test.ts` (consola, stdout/stderr, auditoría, almacén), `apps/api/bff/src/employees.test.ts`, `mysql-employees.test.ts`                     |
| Divulgación auditada y falla cerrada                                            | `employees.test.ts`                                                                                                                                   |
| Duplicados por índice ciego (sin oráculo para quien no ve PII)                  | `employees.test.ts`, `store.test.ts`, `mysql.integration.test.ts`, `mysql-employees.test.ts`                                                          |
| Fallo de KMS → 500 genérico sin fila                                            | `employees.test.ts`                                                                                                                                   |
| Aptitud derivada (reloj, inclusive, no conductor)                               | dominio, `employees.test.ts`                                                                                                                          |
| Aislamiento por tenant, 404 uniforme, `company_id` en todo                      | `employees.test.ts`, `apps/api/bff/src/employees.test.ts`, `mysql-employees.test.ts`, `mysql.integration.test.ts`                                     |
| Versión optimista                                                               | `employees.test.ts`, `mysql-employees.test.ts`                                                                                                        |
| Cursor firmado ligado a tenant, filtro y empleado                               | `apps/api/bff/src/employees.test.ts`                                                                                                                  |
| Roles y permisos (5 roles, permisos exactos)                                    | `employees.test.ts` («role matrix»), `apps/api/bff/src/employees.test.ts`, `mysql-employees.test.ts`                                                  |
| Sesión y CSRF en cada ruta                                                      | `apps/api/bff/src/employees.test.ts`, `bff.test.ts` (matrices incluyen rutas de empleados)                                                            |
| Auditoría con lista blanca                                                      | `employees.test.ts`                                                                                                                                   |
| Errores saneados                                                                | `errors.test.ts`, `store.test.ts`, `employees.test.ts`, `apps/api/bff/src/employees.test.ts`                                                          |
| Contrato y cliente tipado                                                       | `packages/contracts/src/client.test.ts`, `web-client.test.ts` (recorre las 7 rutas), prueba de deriva de rutas                                        |
| Contrato de KMS para el futuro adaptador AWS                                    | `packages/platform/pii/src/testing/kms-contract.ts` (usada por `local-dev-kms.test.ts`)                                                               |

### Comprobación de mutación hecha a mano (no versionada, restaurada)

Cada mutación se aplicó, se ejecutaron las pruebas indicadas y se restauró el archivo. Todas fueron detectadas.

| Mutación                                            | Resultado                          |
| --------------------------------------------------- | ---------------------------------- |
| `InMemoryEmployeeStore.find` ignora el tenant       | 1 prueba falla                     |
| `TypeOrmEmployeeStore.find` sin `company_id`        | 1 falla (`store.test.ts`)          |
| Puerta de área anulada (`withActiveArea` no se usa) | 4 fallan (`employee-area.test.ts`) |
| Escribir PII ya no exige `view_pii`                 | 3 fallan                           |
| Sin enmascarado cuando falta `view_pii`             | 8 fallan (plataforma y BFF)        |
| PII guardada en claro (sin `pii.seal`)              | 17 fallan                          |
| Divulgación sin auditar (`employee.pii_viewed`)     | 5 fallan                           |
| Conteo en memoria incluye `terminated`              | 1 falla                            |
| Conteo MySQL sin filtro de tenant                   | 1 falla (`store.test.ts`)          |

## Archivos tocados

- Nuevos: `packages/platform/pii/**`, `packages/domain/employees/**`, `packages/persistence/employees/**`, `apps/api/composition/src/employees.ts`, `apps/api/bff/src/employees.test.ts`, `tests/integration/platform/employees.test.ts`, `employee-area.test.ts`, `mysql-employees.test.ts`, este documento.
- Editados: `apps/api/composition/src/platform.ts`, `index.ts`, `testing.ts`, `tsconfig.json`; `apps/api/bff/src/routes.ts`; `packages/contracts/src/bff.ts`, `client.ts`, `client.test.ts`; `tests/integration/platform/bff.test.ts`, `web-client.test.ts`, `tsconfig.json`; `package.json`, `tsconfig.json`, `pnpm-lock.yaml`.
