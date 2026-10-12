# MNT-ORDERS-M3-20261011 — órdenes de mantenimiento

```yaml
id: MNT-ORDERS-M3-20261011
baseline: [SPEC-1.3, ORCH-1.3, inherited: SPEC-1.0/ORCH-1.0, SPEC-1.1/ORCH-1.1, SPEC-1.2/ORCH-1.2]
active_provider: openai
model: gpt-6-luna
milestone: M3
kind: implementation
baseSHA: 2a7080f7a6dc0c2cdd0fa9f9c879d1da722d7382
depends_on:
  [G2 owner-accepted at baseSHA by direct instruction 2026-10-11, accepted MNT-PLANS contract/port]
write_paths:
  - packages/domain/maintenance/orders/**
  - packages/persistence/maintenance/orders/**
  - apps/api/maintenance/orders/**
  - docs/tasks/MNT-ORDERS-M3-20261011.md (package owner only)
forbidden_paths:
  - SPECS.md
  - Orchestrator.md
  - docs/baselines/**
  - Tasks.md
  - package.json (shared; coordinate a separate owner/lease before any change)
  - pnpm-lock.yaml
  - apps/web/** (MNT-UI owns this scope)
  - docs/traceability/maintenance* (MNT-INTEGRATE owns consolidated traceability)
  - tests/integration/maintenance/** (MNT-QA owns)
  - tests/e2e/maintenance/** (MNT-QA owns)
  - tests/fixtures/maintenance/** (MNT-QA owns)
  - maintenance/plans/**, workshops/**, mechanics/** (MNT-PLANS owns these scopes)
  - inventory or stock-accounting paths
  - .env*, AWS, production, and real customer data
status: package prepared; implementation waits for accepted MNT-PLANS contract/port
```

## Encargo

Implementar el dominio, persistencia y API de órdenes preventivas y correctivas para M3. La asignación solo inicia cuando G2 está aceptado sobre la base indicada y existe un contrato/puerto de MNT-PLANS ya aceptado. La orden consume ese puerto para las operaciones de plan que correspondan. No diseñar, inventar ni cerrar aquí su interfaz; si el contrato aceptado no cubre un caso necesario, detener esa parte y coordinar una decisión/paquete de contrato.

La instrucción directa del usuario fija SPEC/ORCH-1.3 y Codex `gpt-6-luna`; `docs/baselines/ACTIVE.md` todavía declara 1.4. Registrar esta discrepancia sin modificar baselines o manifests. M3 queda sujeto a G3 y a los gates acumulativos; este paquete no declara G3 ni la implementación aprobados.

El propietario aceptó G2 en el SHA base indicado mediante instrucción directa del 2026-10-11. Esta aceptación habilita preparar este paquete M3; no es una declaración de G3 ni sustituye su futura auditoría acumulativa.

## Fuentes y adopción

- `SPECS.md` §2.3, §5.2, §5.3, §5.4, §6.1, §7, §10 y trazabilidad §10.1; `Orchestrator.md` M3, MNT-ORDERS, MNT-QA, MNT-INTEGRATE y G3.
- `docs/baselines/1.1–1.3/{SPECS,Orchestrator}.md`, `docs/adr/0004-provider-model-policy.md`, `0005-single-active-provider.md`, `0006-luna6-model-policy.md`; `docs/operations/SESSION_HANDSHAKE.md`.
- `docs/sources/BRD_SRD_OPSLOG_Bitacoras_Operativas_v0.2.md` §9.1–9.6, FR-103–108, US-040/041, D9/D10/D14/D16/D20 y preguntas/decisiones relacionadas. El BRD es fuente con etiquetas; sus propuestas no se convierten en requisitos aprobados por aparecer aquí.
- Accepted MNT-PLANS contract/port and its task/evidence package (hard dependency; identify the accepted artifact and SHA in the implementation package before work starts).
- `Orchestrator.md` MNT-QA owns `tests/integration/maintenance/**`, `tests/e2e/maintenance/**` and `tests/fixtures/maintenance/**`.

`FR-103` y `FR-104` se consideran adoptados solo en la medida en que SPECS §5.2/§6.1 y el contrato/puerto aceptado de MNT-PLANS los cubran. SPECS §6.1 sí adopta recalcular la siguiente ocurrencia preventiva al cerrar y hacer idempotente el recálculo al reabrir, sin duplicar la próxima orden; por tanto, ese comportamiento de FR-105 es requisito de baseline. Los detalles adicionales del BRD que no estén cubiertos por la baseline o contratos aceptados conservan su etiqueta `[PROPOSED]` o `[DECISION REQUIRED]`; FR-106–108 no quedan adoptados aquí por completo. En particular, no implementar mantenimiento por horas, aprobación de presupuesto (D14: excluida del MVP), un override del workflow ni restauración automática del estado operativo del vehículo. El cambio operativo requiere acción/confirmación explícita y debe respetar todos los bloqueos vigentes.

## Alcance funcional

- Órdenes preventivas originadas por el puerto de planes aceptado y órdenes manuales correctivas. Preservar el origen y las relaciones permitidas por contratos aceptados; no introducir aprobación de presupuesto estimado antes de iniciar.
- Campos necesarios para el workflow y los registros de tarea, partes usadas, costos y moneda, evidencia y facturas conforme a los contratos aceptados y la configuración de requisitos. Las partes son registros de la orden; no hay existencia, reservas, movimientos ni contabilidad de inventario.
- Transiciones exclusivamente por comandos conforme a la tabla de SPECS §6.1. Validar actor/permiso, versión, requisitos y estado vigente; devolver faltantes estructurados. Ningún PATCH libre de estado ni transiciones adicionales.
- Historial cerrado e inmutable, incluida la evidencia, los costos y los hechos previos al cierre. Reapertura solo mediante `maintenance:reopen` y motivo requerido; invalidar el cierre y coordinar el recálculo idempotente a través del puerto aceptado, sin duplicar la siguiente orden del plan.
- SPECS §2.3 D20 adopta una revisión opcional al cierre por costo alto con umbral configurado por tenant. Si hay umbral y el costo final lo supera, requiere aprobación de un supervisor con `incidents:approve`; si no hay umbral configurado, no exige esta aprobación. No inventar monto ni valor predeterminado. Esta revisión aplica al cierre.
- D14 excluye del MVP la aprobación de presupuesto estimado antes de iniciar el trabajo. No agregar ese paso antes de `in_progress`, aunque exista un estimado o el costo final pudiera superar el umbral D20.
- Importes exactos como enteros en unidad monetaria menor, asociados siempre a código de moneda ISO 4217. No usar flotantes ni inferir conversión o moneda predeterminada.
- Permisos de mantenimiento y propiedad aplicados en cada operación. El acceso a importes se verifica por separado con `view_costs`; sin ese permiso, montos y totales no salen en lecturas, listados, historial, errores ni respuestas de escritura. Un mecánico solo puede consultar o actuar sobre órdenes propias/asignadas según la identidad contractual; no basta conocer el ID.
- Aislamiento del tenant y de recursos relacionados en todas las lecturas, escrituras y comandos. Actor y tenant provienen del contexto autenticado de API, nunca del body. No filtrar existencia de IDs extranjeros.
- Cada mutación de negocio, evento de audit local y mensaje de outbox se confirma atómicamente en MySQL del tenant. Si audit u outbox fallan o no están disponibles, se revierte toda la mutación; nunca se confirma el negocio sin ambos. No emitir efectos externos antes del commit.
- Todo evento de maintenance en outbox se valida contra un esquema mínimo allowlist antes de persistirse: solo IDs, tipo de evento y versión. Excluir PII, texto libre, metadata de evidencia y costos, incluso si esos datos existen en la orden.
- Al iniciar una orden que requiera taller, registrar/proponer el cambio operativo descrito por SPECS §6.1 y mostrar el bloqueo de elegibilidad. Al cerrar, la persona autorizada define el estado explícitamente; no restaurar el estado previo sin comprobar los otros bloqueos del vehículo.

## Fuera de alcance y fronteras

- Planes, generación/idempotencia de ocurrencias, talleres, mecánicos y sus puertos productores: MNT-PLANS. Este paquete consume únicamente el puerto aceptado.
- Pantallas, listado/calendario UI, navegación, responsive y componentes: MNT-UI.
- Pruebas independientes y fixtures de aceptación acumulativa de mantenimiento: MNT-QA.
- Composición final del producto, cableado compartido y regresión de flota: MNT-INTEGRATE.
- Publicación del artefacto consolidado `docs/traceability/maintenance*`: MNT-INTEGRATE. La matriz de este paquete es insumo trazable para esa consolidación, no un archivo adicional que MNT-ORDERS deba publicar.
- Auditoría acumulativa y aceptación de G3: gate posterior; MNT-ORDERS no lo ejecuta ni lo declara pasado.
- Compras, catálogo/existencia de inventario, consumo contable, aprobación de presupuesto estimado antes de iniciar (D14), contabilidad, integración con siniestros fuera de contratos aceptados, mantenimiento por horas, y restauración automática del estado del vehículo. La revisión condicional al cierre de D20 sí queda en alcance cuando el tenant configura el umbral.

`package.json` contiene scripts y listas de formato compartidos. Su edición necesita coordinación y un propietario/lease único separado; no se debe pedir al autor de MNT-ORDERS que lo edite bajo este paquete. `pnpm quality` y `pnpm test:integration` son los comandos existentes de calidad e integración; solo un propietario coordinado puede cablear nuevos tests de maintenance en scripts compartidos. `pnpm test:e2e` se ejecuta para flujos integrados de navegador/API aplicables al alcance backend y a su integración con MNT-UI, no sustituye integración MySQL.

MNT-ORDERS puede mantener pruebas unitarias dentro de sus propios subárboles de dominio/persistencia/API, conforme a las convenciones de esos módulos. MNT-QA es el único dueño de pruebas independientes y fixtures en los tres directorios indicados por Orchestrator.md; valida el candidato integrado contra MySQL real con datos sintéticos y cubre los flujos de navegador/API aplicables. MNT-ORDERS debe exponer contratos/seams comprobables y corregir hallazgos de su implementación dentro de sus paths asignados.

## Aceptación Given / When / Then

1. **Matriz de estados.** Given una orden en cada estado contractual, When se intenta cada transición de SPECS §6.1 y transiciones no permitidas, Then solo se aceptan las transiciones de la tabla y las demás fallan sin efectos parciales.
2. **Requisitos y versión.** Given una transición que carece de campos o evidencia exigidos, o una versión obsoleta, When se envía el comando, Then devuelve faltantes estables o `409 stale_version` respectivamente y no cambia orden, auditoría, outbox ni plan.
3. **Tenant y propiedad.** Given tenants A/B con órdenes, vehículos, actores y referencias relacionadas, When A solicita un ID de B o un mecánico actúa sobre una orden que no posee, Then se obtiene el error uniforme contractual, sin mutación ni filtración de existencia, costos o datos relacionados.
4. **Concurrencia e idempotencia.** Given solicitudes concurrentes para cerrar, reabrir o reintentar el mismo comando, When ambas compiten con la misma versión/clave idempotente, Then hay un único resultado de negocio confirmado; las demás obtienen conflicto/replay contractual y no duplican cierre, eventos ni próxima orden preventiva.
5. **Costos.** Given un usuario con `maintenance:view` pero sin `view_costs`, When lista, lee, consulta historial o ejecuta una escritura de orden, Then ningún importe, moneda/total derivado sensible ni parte que revele costo aparece en respuesta; con `view_costs`, los importes coinciden exactamente con los enteros persistidos y su moneda ISO.
6. **Permisos del mecánico.** Given un mecánico asignado a una orden y otro mecánico no asignado, When ambos ejecutan acciones habilitadas por SPECS §6.1, Then el asignado solo actúa donde la matriz lo permite y el ajeno no lee ni muta la orden. Flotilla/admin no eluden tenant ni requisitos.
7. **Atomicidad y payload audit/outbox.** Given MySQL de tenant y un fallo inyectado al escribir audit u outbox, o la ausencia de cualquiera de esos puertos/adaptadores, When se realiza cualquier mutación de negocio, Then orden, relaciones, eventos, audit y outbox quedan todos revertidos o la operación falla cerrada antes de escribir; cuando ambos escriben correctamente, quedan confirmados en la misma transacción local. Given un evento de maintenance, When se valida y persiste el outbox, Then el payload almacenado contiene únicamente IDs, tipo de evento y versión, sin PII, texto libre, metadata de evidencia ni costos.
8. **Historial y reapertura.** Given una orden cerrada, When se intenta editarla o reabrirla sin permiso/motivo y luego con `maintenance:reopen` y motivo válido, Then edición ordinaria se bloquea, la reapertura autorizada conserva el cierre anterior en historia y el recálculo no duplica la siguiente orden.
9. **Dos bloqueos del vehículo.** Given un vehículo con dos bloqueos independientes (por ejemplo, dos órdenes/talleres o una orden y otra restricción operativa activa), When se inicia y luego se cierra/reabre una orden, Then la elegibilidad sigue bloqueada mientras quede cualquier causa abierta; no se restaura automáticamente un estado previo ni se borra el otro bloqueo.
10. **Revisión de costo al cierre (D20) y D14.** Given un tenant con umbral D20 configurado, When el costo final supera el umbral, Then solo un supervisor con `incidents:approve` puede cerrar y el cierre espera esa aprobación; con costo igual o inferior no se requiere. Given un tenant sin umbral configurado, When se cierra una orden, Then no se exige ni inventa aprobación de costo alto. Given una orden con costo estimado, When pasa a `in_progress`, Then no se exige aprobación de presupuesto previo conforme a D14. No usar montos arbitrarios.
11. **MySQL real.** Given fixtures sintéticos en bases MySQL tenant A y B, When corren las pruebas de integración de órdenes y el flujo integrado correspondiente, Then los resultados anteriores se comprueban con filas/índices y transacciones reales, sin mocks como evidencia final.

## Trazabilidad requisito → contrato → implementación → prueba → evidencia

| Requisito                                            | Fuente/decisión                                                                                              | Contrato consumidor                                    | Implementación/alcance                                                  | Evidencia exigida                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Workflow permitido, versión y requisitos             | SPECS §5.2/§6.1; BRD FR-103 solo parcialmente adoptado                                                       | Comandos de orden y contrato de MNT-PLANS aceptado     | Dominio/API de órdenes                                                  | Casos 1–2, prueba MySQL y resultado por SHA                                           |
| Datos de trabajos, partes, costos, evidencia/factura | SPECS §6.1; FR-104 parcialmente; detalles BRD restantes siguen propuestos                                    | Contratos aprobados de órdenes/documentos/planes       | Persistencia y API dentro de órdenes; sin stock                         | Casos 2, 5 y 8; filas persistidas y permisos                                          |
| Tenancy, roles, propiedad y costos                   | SPECS §5.2–§5.4; permisos de costo separados                                                                 | Contrato de sesión/RBAC y órdenes                      | API/consultas tenant-scoped                                             | Casos 3, 5 y 6 en A/B con IDs extranjeros                                             |
| Cambios concurrentes                                 | SPECS §5.2, §6.1                                                                                             | Versionado/idempotencia contractual                    | Escritura condicional/transacción                                       | Caso 4 con MySQL real                                                                 |
| Audit y outbox                                       | SPECS §5.2 y contratos aceptados de plataforma                                                               | Puertos existentes de audit/outbox                     | Una transacción MySQL por tenant; payload allowlist antes de persistir  | Caso 7, rollback inducido e inspección del payload almacenado                         |
| Plan siguiente y reapertura                          | SPECS §6.1 adopta recálculo al cerrar y reapertura idempotente; contrato/puerto MNT-PLANS aceptado requerido | No especificar aquí la interfaz                        | Llamada por puerto para cierre/reapertura                               | Casos 4 y 8; evidencia de una sola próxima orden                                      |
| Revisión opcional de costo al cerrar                 | SPECS §2.3 D20: umbral por tenant; D14 declina aprobación pre-start                                          | Configuración del tenant y permiso `incidents:approve` | Gate solo en `completed` → `closed` cuando excede el umbral configurado | Caso 10: supera, igual/inferior, sin umbral y sin gate pre-start; sin monto inventado |
| Estado/eligibilidad del vehículo                     | SPECS §5.3 y §6.1; BRD FR-106 no se adopta como restauración automática                                      | Estado y elegibilidad actuales del vehículo            | Propuesta/confirmación explícita, preservando causas                    | Caso 9, dos bloqueos simultáneos                                                      |

## Comandos y evidencia

Comandos existentes a ejecutar sobre el SHA candidato cuando la implementación y los tests estén asignados y cableados:

- `pnpm quality`
- `pnpm test:integration`
- `pnpm test:e2e` solo para flujos integrados de navegador/API aplicables.
- `pnpm exec prettier --check docs/tasks/MNT-ORDERS-M3-20261011.md`
- `git diff --check`

Si los escenarios MNT no están incluidos en los scripts actuales, no editar `package.json` desde este lease: solicitar al orquestador coordinación y un propietario exclusivo para el cableado. Registrar el comando ejecutable final, MySQL 8 real, tenants sintéticos, escenarios omitidos/corridos, SHA, filas/evidencia observable, CI, auditoría independiente única del PR/SHA y hallazgos. Los mocks sirven solo para pruebas unitarias; no sustituyen la aceptación con MySQL real. Ningún resultado de esta lista por sí solo declara G3 pasado.
