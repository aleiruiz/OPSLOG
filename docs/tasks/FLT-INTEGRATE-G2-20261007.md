# FLT-INTEGRATE — integración real de flota para G2

```yaml
id: FLT-INTEGRATE-G2-20261007
baseline: [SPEC-1.3, ORCH-1.3, inherited: SPEC-1.0/ORCH-1.0, SPEC-1.1/ORCH-1.1, SPEC-1.2/ORCH-1.2]
active_provider: openai
model: gpt-6-luna
milestone: M2
kind: integration
base_sha: e42b3c20968201698d4be8659801828ed274f774
status: package-ready; implementation not started
accepted_dependencies:
  [
    AREAS-M2,
    VEHICLES-M2,
    EMPLOYEES-M2,
    DOCS-M2,
    INSURANCE-M2,
    ASSIGNMENTS-M2,
    SETTINGS-ALERTS-M2,
    IMPORT-M2,
    corresponding M2 web packages,
  ]
write_paths:
  [
    apps/api/composition/**,
    apps/worker/composition/**,
    infra/runtime/**,
    tests/e2e/fleet/**,
    package.json,
    tsconfig*.json,
    docs/tasks/FLT-INTEGRATE-G2-20261007.md,
  ]
forbidden_paths:
  [SPECS.md, Orchestrator.md, docs/baselines/**, Tasks.md, .env*, pnpm-lock.yaml, infra/aws/**]
acceptance:
  - 'Given the accepted M2 services and a disposable MySQL 8 tenant database, When the integrated suite runs through the real API composition and BFF, Then create, renewal, import and assignment journeys persist and read the expected rows.'
  - 'Given tenant A and tenant B fixtures, When each journey reads, mutates, retries or requests foreign identifiers, Then tenant isolation, uniform errors, permission checks and durable audit evidence hold across the composed modules.'
  - 'Given a driver whose license is expired and a vehicle with expired insurance, When the real composed services calculate fitness, alerts and assignment eligibility, Then the test records the current contract exactly and exposes any missing/undecided business rule without silently adding one.'
  - 'Given the integrated candidate SHA, When required quality, real-MySQL integration, browser E2E and visual regression checks run, Then every required check passes on that SHA with no skipped MySQL fleet scenarios.'
commands:
  [
    pnpm baseline:check,
    pnpm lint,
    pnpm format:check,
    pnpm typecheck,
    pnpm test:unit,
    pnpm test:integration,
    pnpm test:e2e,
    pnpm test:visual,
    pnpm build,
    pnpm quality,
  ]
completion_evidence:
  [
    PR,
    exact base/head SHA,
    CI run links,
    real-MySQL version and synthetic fixture evidence,
    traceability matrix,
    one independent audit per PR SHA,
  ]
```

## Objetivo y límites

Integrar las composiciones ya aceptadas de Áreas, Vehículos, Empleados, Documentos, Seguros, Asignaciones, Ajustes/Alertas e Importaciones. Cerrar el hueco entre pruebas por módulo y evidencia de recorridos completos contra BFF y MySQL 8 real. Implementar únicamente cableado y correcciones necesarias para que esos recorridos sean comprobables; no adoptar reglas de negocio marcadas como propuestas ni iniciar M3. Todos los datos de prueba serán sintéticos. No conectar AWS ni producción.

El candidato se basa en `e42b3c20968201698d4be8659801828ed274f774` (merge de PR #68, que contiene también las pantallas #67 y #68). Las dependencias son los paquetes M2 enumerados arriba, ya incorporados a `main`; sus merges no equivalen a aceptación de G2. La baseline indicada sigue la instrucción directa del usuario para SPEC/ORCH-1.3 y ADR-0006. El `docs/baselines/ACTIVE.md` del checkout declara 1.4; esa discrepancia queda registrada y no se modifica ningún archivo de baseline.

`package.json` se reserva solo para registrar este documento en `format:check` y, si se requiere, para cablear los comandos existentes de pruebas. No añadir dependencias ni cambiar scripts ajenos a esta integración. No modificar `pnpm-lock.yaml`; cualquier necesidad real de migración compartida requiere coordinación y un paquete de decisión previo.

## Requisitos y escenarios de aceptación

1. **Composición y migraciones.** Given el arranque de API/worker con una base tenant vacía, When se aplica el registro de migraciones de la composición, Then se instalan una sola vez las migraciones de áreas, vehículos, personas, documentos, seguros, asignaciones, alertas e importaciones en orden válido; down/up queda reversible y no modifica esquemas ajenos. La cuenta de runtime mantiene mínimo privilegio y no recibe credenciales administrativas.
2. **Alta y renovación de vehículo.** Given un tenant nuevo y permisos de editor, When se crea un área activa, un vehículo con documentos obligatorios y una póliza, y luego se renueva la póliza vencida, Then los datos quedan vinculados al mismo tenant/vehículo, la póliza anterior conserva su historial y estado, la nueva cubre el rango indicado y la alerta derivada se recalcula según los umbrales configurados. Incluir límites de fechas UTC y consultas sobre filas MySQL, no solo respuestas HTTP.
3. **Licencia vencida y aptitud.** Given un conductor `driver` activo con licencia cuya fecha de expiración ya pasó, When Empleados calcula `fitness`, Then devuelve la razón contractual `license_expired`. When se intenta asignar, Then registrar el resultado contractual de BR-014 (el servicio de Asignaciones solo requiere `driver` activo/no archivado y explícitamente no exige `fitness`). El recorrido debe demostrar y reportar esa limitación; no convertirla en rechazo sin decisión de producto. Suspensión, baja o archivo sí deben seguir la elegibilidad vigente de BR-014.
4. **Seguro vencido y alertas.** Given una póliza cuya fecha `endsOn` es anterior al día UTC del reloj, When se lee y se evalúan alertas, Then Seguros devuelve `expired` y Alertas produce el resultado conforme a la configuración acordada. No inferir que el vehículo queda `restricted`/`out_of_service`: BR-013 (y el bloqueo por póliza) está propuesto/pendiente y la elegibilidad de Vehículos lo excluye expresamente. Dejar evidencia del estado visible y del hueco de decisión.
5. **Asignación completa.** Given vehículo y conductor elegibles bajo BR-014, When se crea una asignación `principal`, después se reemplaza y se consulta la historia desde ambos recursos, Then solo existe una principal vigente conforme a la unicidad, el cierre y alta son atómicos, las fechas/motivos están preservados y la historia de cada ficha coincide. Comprobar carreras concurrentes en MySQL y la salida `principal_taken` sin filtrar identidad del conductor. La integración no afirma que la ficha satisfaga FR-077 (línea de tiempo unificada/PDF), que sigue pendiente.
6. **Importación CSV.** Given el caso sintético US-016 de 300 filas con 12 inválidas, When se valida en modo dry-run, Then no se crean entidades; When se importan las válidas, Then se crean exactamente 288, el informe identifica las 12 filas con errores y la misma clave/idempotency key no duplica escrituras al reintentarse ni bajo concurrencia. Validar la importación de conductores y vehículos, permisos/CSRF, fórmulas, límites y auditoría sin PII. XLSX no forma parte del contrato implementado: CSV/JSON sí; la discrepancia del requisito BRD US-016/FR-054/FR-074 queda como decisión pendiente y no se declara resuelta.
7. **Aislamiento, permisos y errores.** Given dos tenants sintéticos A/B con objetos de cada módulo, When cada rol listado por los contratos intenta lectura/escritura, identificadores ajenos, repetición y conflictos concurrentes, Then todas las consultas y filas quedan acotadas por `company_id`, el acceso entre tenants produce la respuesta uniforme del contrato, los permisos se evalúan antes de efectos y ni respuestas, auditorías ni logs revelan PII o montos no autorizados. Confirmar evidencia de auditoría durable en la misma transacción o con el mecanismo contractual de cada servicio.
8. **Regresión acumulativa.** Given la rama de integración sobre el SHA exacto, When se ejecutan comandos anteriores en el mismo SHA y la CI requerida, Then pasan regresión de plataforma, suites MySQL, E2E web Chromium y regresión visual; cualquier escenario MySQL ausente o marcado skip en CI falla el criterio.

## Trazabilidad requisito → contrato → implementación → prueba → evidencia

| Requisito                                  | Contrato y fuente                                                                 | Composición a integrar                               | Prueba objetivo                                                | Evidencia exigida                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Alta, documentos y renovación de vehículo  | VEHICLES-M2, DOCS-M2, INSURANCE-M2; US-010/US-012, FR-091                         | `apps/api/composition` + BFF y registro de migración | `tests/e2e/fleet/vehicle-lifecycle.test.ts`                    | filas y respuestas MySQL; renovación conserva póliza previa                                                                    |
| Aptitud y conductor no elegible            | EMPLOYEES-M2: `fitnessOf`; ASSIGNMENTS-M2: BR-014 y limitación explícita          | composición de empleados y asignaciones              | `tests/e2e/fleet/driver-fitness.test.ts`                       | fitness=`license_expired`; registrar que la asignación con licencia vencida actualmente está permitida; suspensión no elegible |
| Seguro vencido y alertas                   | INSURANCE-M2: estado expirado UTC; SETTINGS-ALERTS-M2: umbrales; BR-013 propuesto | seguros + ajustes/alertas                            | `tests/e2e/fleet/insurance-alerts.test.ts`                     | `expired` y alerta configurada; restricción de vehículo marcada sin decisión                                                   |
| Asignar/reemplazar e historia              | ASSIGNMENTS-M2: BR-002/003/014, US-013, FR-053/075/076; FR-077 pendiente          | assignments + employees + vehicles                   | `tests/e2e/fleet/assignment-flow.test.ts`                      | transacción real, carrera y lecturas de fichas; FR-077 fuera de aceptación                                                     |
| CSV validar/confirmar/idempotencia         | IMPORT-M2: US-016, FR-054/074, S27                                                | imports + vehículos + empleados + PII                | `tests/e2e/fleet/import-flow.test.ts`                          | dry-run 0; 288 altas; 12 errores; reintento no duplica                                                                         |
| Tenant, permisos, auditoría y persistencia | contratos M2 y SPECS §8/§10                                                       | API composition, BFF, stores y audit                 | `tests/e2e/fleet/tenant-security.test.ts`                      | A/B, permisos, 404/422 uniformes y filas auditables sintéticas                                                                 |
| Reversibilidad y regresión                 | ORCH-1.3 M2/FLT-INTEGRATE; suites existentes                                      | API/worker composition + migrator                    | `tests/e2e/fleet/migrations.test.ts` y `pnpm test:integration` | logs CI, MySQL 8 real, comandos y SHA                                                                                          |

## Evidencia y decisiones que siguen abiertas

El PR requiere un único auditor independiente para su SHA exacto, CI requerido exitosa y base actualizada. Cada cambio posterior invalida la auditoría del SHA anterior. La evidencia local no sustituye CI/MySQL real. El integrador no declara el gate G2 aceptado ni pasado; después de integrar se requiere auditoría acumulativa M0–M2 y aceptación del owner.

Quedan expresamente sin resolver: XLSX; BR-012/BR-013 y el efecto de licencia/seguro vencidos sobre asignaciones y estado del vehículo; historia unificada FR-077 y PDF; identidad de persona en `principal_taken`; cualquier comportamiento marcado `[PROPOSED]`/`[DECISION REQUIRED]`; auditoría acumulativa G2 y aceptación del owner. AWS continúa diferido por ADR-0002. M3 no inicia hasta superar la auditoría acumulativa del hito previo.

No tocar secretos, archivos `.env*`, AWS ni producción; no usar SQL manual salvo migración/administración aprobada. No cambiar contratos públicos ni migraciones compartidas sin propietario y coordinación. Mantener la fuente de verdad de cada regla en los paquetes M2 y hacer explícitas las limitaciones en el resultado.
