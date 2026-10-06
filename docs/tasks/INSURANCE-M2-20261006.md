# INSURANCE-M2-20261006 — Pólizas de seguro de vehículos (FLT-DOCS, slice 2): dominio, persistencia, composición y BFF

```yaml
id: INSURANCE-M2-20261006
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
baseSHA: 53dd6e6291eb57e47cd29175f9930a08e89cef64
depends_on:
  [CORE-AUTH, CORE-TENANCY, CORE-AUDIT, CORE-INTEGRATE, VEHICLES-M2-20261006, DOCS-M2-20261006]
write_paths:
  [
    packages/domain/insurance/**,
    packages/persistence/insurance/**,
    apps/api/composition/**,
    apps/api/bff/**,
    packages/contracts/**,
    tests/integration/platform/**,
    docs/tasks/INSURANCE-M2-20261006.md,
    package.json,
    tsconfig.json,
    pnpm-lock.yaml,
  ]
```

`package.json`, `tsconfig.json` y `pnpm-lock.yaml` están en `write_paths` solo por el cableado (scripts de prueba, lista de `format:check`, referencias de proyecto e importadores del lockfile). Segundo slice de FLT-DOCS: las pólizas que `DOCS-M2-20261006` dejó como seguimiento (BRD/SRD v0.2 §8.4, FR-090, FR-091, BR-009, BR-019, BR-025, US-011, US-012, D13; SPECS §5.1). **Solo backend** (ADR-0010: sin pantallas). Replica Vehículos, Áreas, Empleados y Documentos. No toca `docs/baselines`, `apps/web` ni Storybook. Solo datos sintéticos; sin AWS ni red. **Dependencias nuevas: ninguna** (los paquetes nuevos solo cambian los importadores del lockfile).

## Reutilización de Documentos

Las reglas de vencimiento no se copian: `@opslog/domain-insurance` importa de `@opslog/domain-documents` el cálculo de estado derivado (`expiryOf`: ventana de 30 días, último día inclusivo), el filtro por estado (`expiryFilterOf`, `matchesExpiry`), el estado de una revisión (`revisionStatus`), la aritmética de fechas y los límites de listado. Un cambio de la regla de vencimiento de documentos cambia también la de pólizas, que es lo que pide FR-091 (el mismo estado y los mismos umbrales). Lo que sí se replica, porque pertenece a cada módulo, es el esqueleto de persistencia (fuente de datos con cuenta propia, errores saneados, migración, tienda y fake de pruebas) y el de composición/BFF.

## Alcance entregado

1. **Dominio** (`packages/domain/insurance`, `@opslog/domain-insurance`): tipos de cobertura, deducible (monto o porcentaje), normalizadores, `parseNewPolicy`, `parseRenewal`, `parsePolicyPatch`, `coversOn`, transiciones puras (`applyPatch`, `applyRenewal`, `applyArchive`), puerto `PolicyStore`, `InMemoryPolicyStore`, puerto `PolicyVehicleGate` y `PolicyService`. Errores tipados `PolicyError(code, field?)`.
2. **Persistencia** (`packages/persistence/insurance`): tablas `opslog_insurance_policies` y `opslog_insurance_policy_revisions`; migración reversible `CreateInsurancePolicies2026100600070` con `CHECK` como DDL; `TypeOrmPolicyStore` (errores saneados, `UPDATE` condicional por versión, revisiones solo se insertan); cuenta de ejecución `opslog_insurance_*` de mínimo privilegio (`SELECT, INSERT, UPDATE` sobre pólizas, sin `DELETE`; solo `SELECT, INSERT` sobre revisiones). `company_id` forma parte de toda clave primaria, de todo índice y de todo filtro.
3. **Composición** (`apps/api/composition/src/insurance.ts`, `platform.ts`): `InsuranceApi` con sesión + `TenantGate`, rol y permiso resueltos en cada llamada; tenant y actor salen solo de la sesión. Puerta de vehículo cableada a `VehicleService.get`. Auditoría: `insurance_policy.created`, `.updated`, `.renewed`, `.archived` (acción, tipo, id y actor; nunca valores ni montos).
4. **BFF y contratos**: `insurance.list`, `insurance.create` (201), `insurance.get`, `insurance.update` (PUT), `insurance.renew`, `insurance.archive`, `insurance.history` (7 rutas, bajo `/api/insurance-policies`). Lecturas con sesión; escrituras con sesión + CSRF. Cliente tipado `createInsuranceClient`. **Un código de error nuevo:** `invalid_vehicle` (422, `field: vehicle_id`), análogo a `invalid_owner`.
5. **Pruebas** (abajo).

## Modelo

- **Vehículo** (`vehicleId`): inmutable; es una póliza N:1 a un vehículo (MVP de §8.4; la póliza de flota N:M, FR-093/D13, queda diferida: pregunta abierta 1). No hay FK a `opslog_vehicles` (tabla de otro módulo y otra migración); la existencia del vehículo la valida el servicio.
- **Póliza vs. revisión.** La póliza guarda `insurer`, `coverageNotes` y una copia de los datos de la revisión actual: `policyNumber`, `coverageType`, `startsOn`, `endsOn` y `deductible`. Cada versión de esos datos es una **revisión inmutable** (BR-025): renovar inserta la revisión n+1, actualiza la copia en la póliza y deja intactas las anteriores (US-012: «anterior `Reemplazada` y consultable»). El historial es la lista de revisiones, la más reciente primero; la actual lleva el estado derivado y las anteriores `replaced`.
- **Dos contadores distintos:** `revision` (+1 solo al renovar) y `version` (+1 en cualquier cambio; token de concurrencia optimista).
- **Datos de la póliza** (FR-090): aseguradora (texto, 2 a 80 caracteres), número de póliza (mayúsculas, hasta 40: letras, dígitos, espacio, `.`, `/`, `-`), tipo de cobertura, periodo y deducible. Tipos de cobertura incorporados: `mandatory_liability` (obligatorio, RC), `third_party`, `comprehensive` (todo riesgo) y `other`; el texto libre va en `coverageNotes` (hasta 500 caracteres). El catálogo de aseguradoras con contacto de siniestros (FR-092) y el checklist de coberturas configurable son de FLT-SETTINGS (pregunta abierta 2).
- **Periodo:** `startsOn` y `endsOn` obligatorios, `YYYY-MM-DD`, días reales del calendario entre 1950-01-01 y 2100-12-31, `endsOn` nunca anterior a `startsOn`; **ambos extremos inclusivos**. `startsOn` puede ser futura (renovaciones y pólizas compradas por anticipado).
- **Deducible** (BRD §8.4: monto o porcentaje más moneda; **dato financiero**, §12.5 `view_costs`): `null` (ninguno), `{ kind: 'amount', amountMinor, currency }` (entero positivo en la unidad menor de una moneda ISO 4217 en mayúsculas, hasta 10^12; nunca decimal flotante) o `{ kind: 'percent', basisPoints }` (entero de 1 a 10 000, es decir 0,01 % a 100 %). En la base son tres columnas tipadas (`deductible_kind`, `deductible_value` BIGINT, `deductible_currency`) y un `CHECK` exige que concuerden. **No se modela la prima** (opcional en el BRD): es otro importe sin requisito de lectura; pregunta abierta 4.
- **Estado derivado, nunca guardado** (`status`, `daysToExpiry`): `expired` si `endsOn < hoy`; `expiring` si faltan 0 a 30 días (el último día es `expiring` con 0 días); `valid` en otro caso (FR-091). «Hoy» es la fecha UTC del reloj del servicio (el mismo `now` de la plataforma). Además `covering` (booleano) indica si el periodo contiene hoy: una póliza que aún no empieza es `valid` pero no `covering`. El listado filtra por estado en la base con rangos de `ends_on`.
- **Póliza vigente a una fecha** (BR-019, FR-111, US-031): el listado acepta `coversOn=YYYY-MM-DD` y devuelve las pólizas cuyo periodo contiene ese día (`starts_on <= día <= ends_on`, ambos inclusivos), combinable con `vehicleId`, tipo y estado. Esto es lo que usará Siniestros para precargar la póliza y mostrar «Sin cobertura vigente a la fecha del evento» cuando la lista venga vacía; ese flujo no se implementa aquí.
- **Varias pólizas vigentes a la vez** (D13/§8.4: «obligatoria + todo riesgo»): se permiten, sin regla de solape ni de unicidad (preguntas abiertas 5 y 6).
- **Editable en sitio:** solo `insurer` y `coverageNotes`. Cambiar número, cobertura, periodo o deducible es una renovación. El vehículo no cambia.
- **Baja lógica** (BR-009): `archivedAt`; una póliza archivada es de solo lectura (409 `immutable` al editar, renovar o volver a archivar) y sus revisiones se conservan. No hay desarchivado ni borrado físico. «Cancelada» (§ entidades) no se modela como estado: pregunta abierta 7.
- **Vehículo vivo:** al **crear** y al **renovar**, el vehículo debe existir en el tenant y **no estar archivado**. Desconocido, de otro tenant o archivado dan el mismo 422 `invalid_vehicle` (`field: vehicle_id`) sin oráculo entre tenants. Leer, editar y archivar una póliza no consultan al vehículo. Archivar un vehículo **no archiva** sus pólizas.
- **Listado:** orden por `ends_on` ascendente y luego id, en orden de unidades de código. Filtros: `vehicleId`, `coverageType`, `status`, `coversOn`, `includeArchived`. Páginas 25/50/100 con cursor firmado ligado a tenant y filtro; el historial usa su propio cursor ligado a `['policy', id, limit]`. 404 uniforme para ids de otro tenant y desconocidos; las vistas no incluyen `tenantId`.

## Permisos y roles

Se reutilizan los genéricos igual que en Vehículos, Empleados y Documentos: lectura `view`, alta `create`, cambios (editar, renovar) `edit`, archivar `delete`. **El deducible exige además `view_costs`** (BRD §12.5: «Ver importes (costos, deducibles, facturas)»), del mismo modo que Empleados exige `view_pii` para sus datos personales:

- **Leer:** sin `view_costs`, `deductible` es `null` en toda respuesta (lectura, listado, historial y respuesta de escrituras) y solo `hasDeductible` dice si existe uno. El importe nunca viaja a quien no lo puede ver.
- **Escribir:** crear o renovar con un `deductible` distinto de `null` pide `view_costs` además del permiso de la operación (403 si falta, sin cambiar nada). Renovar **sin mencionar** el deducible lo conserva (quien no tiene `view_costs` renueva sin leerlo ni borrarlo); un `null` explícito lo elimina y no pide el permiso, porque no escribe un importe.

| Operación                                            | Permiso               | admin | editor | viewer | auditor | pii_reader |
| ---------------------------------------------------- | --------------------- | ----- | ------ | ------ | ------- | ---------- |
| `list`, `get`, `history` (sin deducible)             | `view`                | sí    | sí     | sí     | sí      | sí         |
| ver el deducible en esas lecturas                    | `view_costs`          | sí    | no     | no     | no      | no         |
| `create` sin deducible                               | `create`              | sí    | sí     | no     | no      | sí         |
| `create` con deducible                               | `create`+`view_costs` | sí    | no     | no     | no      | no         |
| `update` (aseguradora, notas), `renew` sin deducible | `edit`                | sí    | sí     | no     | no      | no         |
| `renew` con deducible                                | `edit`+`view_costs`   | sí    | no     | no     | no      | no         |
| `archive`                                            | `delete`              | sí    | no     | no     | no      | no         |

`pii_reader` tiene `create` en la plantilla y puede dar de alta pólizas sin deducible (igual que en Empleados y Documentos; pregunta abierta 8). Una prueba comprueba los permisos exactos que `InsuranceApi` pide en cada operación (incluidas las variantes con deducible) y otra recorre los 5 roles contra las 9 variantes.

## Valores por defecto elegidos

1. Pólizas N:1 a vehículo; sin póliza de flota (FR-093 es «Could» y D13 recomienda 1:N en MVP).
2. Aseguradora como texto, sin catálogo; tipo de cobertura incorporado de 4 valores más texto libre.
3. Periodo con ambos extremos inclusivos y fin obligatorio; el inicio puede ser futuro.
4. Ventana de «por vencer» de 30 días, la misma de Documentos (BRD §15: 30/15/7/0 y US-011 piden 7/15/30/60 como filtros; los umbrales por empresa son de FLT-SETTINGS/FLT-ALERTS).
5. «Hoy» es la fecha UTC del reloj; la zona IANA del tenant queda pendiente (pregunta abierta 9).
6. Deducible opcional, entero (unidad menor o puntos base) y bajo `view_costs`; sin prima.
7. Revisiones inmutables; en sitio solo aseguradora y notas; corregir periodo, número o deducible es renovar.
8. Renovar exige el nuevo periodo y conserva número, cobertura y deducible si no se mencionan; no exige que el nuevo periodo empiece después del anterior (permite corregir).
9. Sin unicidad de número de póliza ni validación de solapes.
10. Archivar un vehículo no archiva sus pólizas; archivar es desde cualquier estado.
11. Vehículo vivo exigido solo al crear y renovar, con comprobación «comprobar y luego actuar» (ver abajo); un vehículo dado de baja (`decommissioned`) no archivado sí admite pólizas.
12. Sin archivos adjuntos (`documento_id` del BRD): igual que Documentos, `FileRecordStore` no tiene adaptador persistente (pregunta abierta 3).
13. Sin alertas, sin outbox, sin importación en este slice.

## Limitación aceptada: vehículo archivado en paralelo

La comprobación de vehículo vivo al crear y renovar es «comprobar y luego actuar» sin bloqueo (best effort), igual que la de propietario de Documentos. Si el vehículo se archiva justo entre la comprobación y la escritura, la póliza se crea o renueva igual; como archivar un vehículo no archiva en cascada sus pólizas, el efecto es el mismo que haber creado la póliza un instante antes del archivado. Se acepta en este slice (pregunta abierta 10).

## Preguntas abiertas

1. **Póliza de flota N:M** (FR-093, D13): una póliza que cubra varios vehículos (`PolicyVehicle`). Hoy es 1:N; el paso a N:M cambia la clave de vínculo y la consulta «vigente a la fecha» por vehículo.
2. **Catálogo de aseguradoras** (FR-092) con contacto de siniestros (teléfono 24 h, correo, portal) y «override» por póliza, y checklist de coberturas configurable (RC, daños propios, robo, cristales, asistencia): FLT-SETTINGS. Hoy la aseguradora es texto libre y el contacto no se guarda (contacto de un tercero, no PII de empleados, pero sin requisito de lectura todavía).
3. **Documento adjunto de la póliza** (`documento_id`, FR-090) y su relación con los documentos de Documentos: ¿la póliza es propietaria de documentos (BRD §12.4 lista la póliza como entidad primaria) cuando exista el almacén persistente de archivos? Pendiente de CORE-FILES (sin adaptador persistente ni S3).
4. **Prima** (opcional en §8.4) y otros importes: ¿se guarda, con `view_costs`, y con qué precisión? Y ¿el deducible por porcentaje necesita base (valor asegurado)?
5. **Solapes y «según cobertura»** (D13): ¿se rechazan dos pólizas del mismo tipo de cobertura que se solapen en el mismo vehículo, o solo se advierte? Hoy se permite todo.
6. **Unicidad del número de póliza** por aseguradora (o por empresa): hoy no hay (una renovación puede cambiar el número; la unicidad exigiría decidir si es de la póliza o de cada revisión).
7. **Estado `Cancelada`** (§ entidades: `Vigente`, `Por vencer`, `Vencida`, `Cancelada`): hoy solo existe la baja lógica de toda la póliza. ¿Cancelar una póliza antes de su fin (con fecha y motivo) es distinto de archivar?
8. `pii_reader` puede crear pólizas (efecto de `create` genérico); resolver con permisos por módulo.
9. **Zona horaria del tenant** para «hoy» y para el fin de vigencia (hoy UTC; SPECS §5.1 pide zona IANA). Importa en el borde del día para `status` y `coversOn`.
10. **Bloqueo del vehículo.** ¿Se cierra la carrera de vehículo archivado en paralelo con un bloqueo del vehículo al crear y renovar, como `withActiveArea`? Hoy no (ver arriba).
11. **FK a vehículos** (hoy ninguna: otras migraciones) y qué hacer con las pólizas al archivar o dar de baja el vehículo.
12. **Renovación**: ¿debe validarse que el nuevo periodo no deje huecos ni solapes con el anterior? Hoy no, para permitir corregir.
13. **Alertas y listados 7/15/30/60** (US-011, FR-091 en su parte de alertas, FLT-ALERTS): hoy solo el estado derivado y el filtro `status` de 30 días; faltan umbrales por empresa, exportación y notificaciones.
14. **Eventos de outbox** y elegibilidad (BR-013: seguro obligatorio vencido pasa el vehículo a `Restringido`, D11): no se implementa; FLT-ELIG decidirá si lee `status`/`coversOn`.
15. **Retención y papelera** (BR-009, D19): no hay borrado físico ni purga.
16. Orden del listado por fin ascendente; alternativa: por fecha de alta.

## Pendientes (no se declaran cumplidos)

Pantallas (ADR-0010), documento adjunto y archivos, catálogo de aseguradoras, póliza de flota, prima, estado `Cancelada`, alertas y umbrales (FLT-ALERTS), elegibilidad/restricción de vehículo (FLT-ELIG, BR-013), uso en Siniestros (BR-019, FR-111, US-031: este slice solo expone `coversOn`), importación, outbox y webhooks, historial unificado del vehículo (FR-077), zona horaria del tenant, FK al vehículo, papelera y retención, despliegue (AWS diferido, producción no autorizada).

## Cobertura (niveles 95/95/95/90)

| Paquete                          | Líneas | Ramas | Cómo se mide                                                              |
| -------------------------------- | ------ | ----- | ------------------------------------------------------------------------- |
| `packages/domain/insurance`      | 100    | 96,58 | `pnpm --filter @opslog/domain-insurance test:unit` (18)                   |
| `packages/persistence/insurance` | 100    | 99,38 | `pnpm --filter @opslog/persistence-insurance test:unit` (44)              |
| `apps/api/composition` (global)  | 99,46  | 97,99 | `pnpm test:platform` (361 pruebas; `insurance.ts` 99,55 / 98,07)          |
| `apps/api/bff`                   | 100    | 98,98 | `vitest run apps/api/bff` (162 pruebas; 18 nuevas en `insurance.test.ts`) |
| `packages/contracts`             | 100    | 98,98 | `pnpm --filter @opslog/contracts test` (49)                               |

Integración en MySQL 8 real (`OPSLOG_TEST_MYSQL_ADMIN_URL`; local: MySQL 8.0.46): `packages/persistence/insurance/src/mysql.integration.test.ts` (15 pruebas: CHECK de póliza y de revisión incluidos los del deducible, cuenta de mínimo privilegio —`UPDATE`/`DELETE` sobre revisiones y `DELETE` sobre pólizas rechazados—, colaciones binarias, claves con `company_id`, ida y vuelta de montos grandes y porcentajes, aislamiento, FK compuesta de la revisión, renovación que deja intactas las filas anteriores, carreras de versión, listado, estado y `coversOn`) y `tests/integration/platform/mysql-insurance.test.ts` (9 pruebas: BFF sobre `TypeOrmPolicyStore` real: ciclo completo, deducible en columnas tipadas y oculto sin `view_costs`, `company_id` en cada fila, 404 uniforme entre tenants, 422 uniforme de vehículo, bordes inclusivos de estado y de `coversOn` en la base, 8 renovaciones concurrentes desde dos sesiones, archivar contra editar, roles y auditoría sin valores ni importes). Sin la variable se omiten en local y son un fallo duro en CI. Las pruebas sobre el almacén en memoria están en `tests/integration/platform/insurance.test.ts` (28) y `apps/api/bff/src/insurance.test.ts` (18).

**Hallazgo de la integración en MySQL real (corregido):** un `CHECK` cuya expresión evalúa a `NULL` (no a falso) es aceptado por MySQL. La primera versión del `CHECK` del deducible dejaba pasar `deductible_kind` nulo con un valor, o `amount` sin moneda; las pruebas contra la base real lo detectaron y la expresión se volvió segura frente a `NULL` (`... IS TRUE` y `IS NOT NULL` explícitos). La prueba comprueba cada combinación ilegal.

## Trazabilidad requisito → prueba

| Requisito                                                                                       | Pruebas                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-090 póliza con aseguradora, número, cobertura, inicio, fin y deducible                       | `domain/insurance/src/index.test.ts`, `schema.test.ts`, `mysql.integration.test.ts` (CHECK), `insurance.test.ts` (plataforma y BFF)                                   |
| FR-091 estado derivado (vigente/por vencer/vencida) con reloj de servicio, último día incl.     | dominio («derives the status from the clock»), `tests/integration/platform/insurance.test.ts` («calendar moves»), `mysql-insurance.test.ts` (bordes), `store.test.ts` |
| Filtro por estado coherente entre memoria, fake y MySQL                                         | dominio, `store.test.ts`, `mysql.integration.test.ts`, `mysql-insurance.test.ts`                                                                                      |
| BR-019 / FR-111 póliza vigente a la fecha del evento (`coversOn`, extremos inclusivos)          | dominio, `store.test.ts` («covering a day»), `mysql.integration.test.ts`, `mysql-insurance.test.ts`, `insurance.test.ts` (BFF y plataforma)                           |
| BR-025 / US-012 renovación como nueva revisión; anteriores `replaced` y consultables            | dominio, `store.test.ts`, `mysql.integration.test.ts` («renewal keeps the original»), `mysql-insurance.test.ts`, BFF                                                  |
| Original inalterado (revisiones solo se insertan, la cuenta no puede modificarlas)              | `store.test.ts` («keeps the earlier revision rows untouched»), `mysql.integration.test.ts` («append-only»), `mysql-insurance.test.ts`                                 |
| Baja lógica (BR-009), solo lectura tras archivar                                                | dominio, `tests/integration/platform/insurance.test.ts` («archived policies read-only»), `schema.test.ts`                                                             |
| Vehículo vivo del mismo tenant, 422 uniforme                                                    | `tests/integration/platform/insurance.test.ts` («same 422»), `apps/api/bff/src/insurance.test.ts`, `mysql-insurance.test.ts`                                          |
| Aislamiento por tenant, 404 uniforme, `company_id` en todo                                      | plataforma y BFF, `store.test.ts`, `mysql.integration.test.ts`, `mysql-insurance.test.ts`                                                                             |
| Versión optimista y carreras                                                                    | dominio, plataforma («concurrency»), `mysql.integration.test.ts`, `mysql-insurance.test.ts`                                                                           |
| Cursor firmado ligado a tenant, filtro y póliza                                                 | `apps/api/bff/src/insurance.test.ts`                                                                                                                                  |
| Roles y permisos (5 roles, permisos exactos), `view_costs` en lectura y escritura del deducible | plataforma («role matrix», «shows the deductible only to a role with view_costs»), BFF («gates the deductible»), `mysql-insurance.test.ts`                            |
| Sesión y CSRF en cada ruta                                                                      | BFF, `bff.test.ts` (matrices incluyen rutas de pólizas)                                                                                                               |
| Auditoría con lista blanca, sin valores ni importes                                             | plataforma (lifecycle), `mysql-insurance.test.ts`                                                                                                                     |
| Errores saneados                                                                                | `errors.test.ts`, `store.test.ts`, plataforma, BFF                                                                                                                    |
| Contrato y cliente tipado                                                                       | `packages/contracts/src/client.test.ts`, `web-client.test.ts` (recorre las 7 rutas), prueba de deriva de rutas                                                        |

### Comprobación de mutación hecha a mano (no versionada, restaurada)

Cada mutación se aplicó, se ejecutaron las pruebas indicadas y se restauró el archivo. Todas fueron detectadas.

| Mutación                                                                        | Resultado                                      |
| ------------------------------------------------------------------------------- | ---------------------------------------------- |
| `coversOn` excluye el día de inicio (`<` en lugar de `<=`)                      | 2 fallan (dominio)                             |
| `TypeOrmPolicyStore.find` sin `company_id`                                      | 1 falla (`store.test.ts`)                      |
| `coversOn` en la tienda con `LessThan(startsOn)`                                | 1 falla (`store.test.ts`)                      |
| `replace` sin condición de versión                                              | 2 fallan (`store.test.ts`)                     |
| La vista devuelve el deducible a quien no tiene `view_costs`                    | 2 fallan (plataforma y BFF)                    |
| Escribir un deducible no exige `view_costs`                                     | 4 fallan (plataforma)                          |
| Renovar sin comprobar el vehículo vivo                                          | 2 fallan (dominio y plataforma)                |
| Permiso de archivar `delete` → `edit`                                           | 2 fallan (plataforma)                          |
| La renovación no conserva el deducible cuando no se menciona                    | 2 fallan (dominio)                             |
| `CHECK` del deducible sin comprobación segura frente a `NULL` (versión inicial) | detectado por MySQL real al escribir la prueba |

## Archivos tocados

- Nuevos: `packages/domain/insurance/**`, `packages/persistence/insurance/**`, `apps/api/composition/src/insurance.ts`, `apps/api/bff/src/insurance.test.ts`, `tests/integration/platform/insurance.test.ts`, `mysql-insurance.test.ts`, este documento.
- Editados: `apps/api/composition/src/platform.ts`, `index.ts`, `testing.ts`, `tsconfig.json`; `apps/api/bff/src/routes.ts`; `packages/contracts/src/bff.ts`, `client.ts`, `client.test.ts`; `tests/integration/platform/bff.test.ts`, `web-client.test.ts`, `tsconfig.json`; `package.json`, `tsconfig.json`, `pnpm-lock.yaml`.
