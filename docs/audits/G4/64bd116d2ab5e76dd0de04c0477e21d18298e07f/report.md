# Informe de auditoría de gate G4 — candidato `64bd116d2ab5e76dd0de04c0477e21d18298e07f`

Fecha: 2026-10-14. Alcance: auditoría acumulativa M0–M4 según `docs/tasks/G4-AUDIT-20261014.md` («Encargo del auditor», puntos 1 a 7), con foco en siniestros (M4, PRs #98 a #118).

Auditor: uno, independiente, con el modelo de revisión de ADR-0007, contexto limpio, no autor de ningún paquete de M4 (ADR-0011 §1, decisión del propietario transcrita y no verificable desde el repositorio). Profundidad ligera según ADR-0011 §3: pruebas nuevas de M4 repetidas tres veces y mutación dirigida solo en el código crítico de seguridad del punto 6. No se hicieron barridos exhaustivos.

**Veredicto recomendado: APROBAR.** No hay hallazgos bloqueantes: ningún Critical ni High, y ningún Medium de seguridad. El flujo de siniestros funciona de principio a fin sobre la API real y MySQL, incluida la ruta de reparación con orden cerrada, que el auditor tuvo que comprobar con una prueba propia porque la suite no la recorre (L-1). Hay un Medium que no es de seguridad (M-1: `pnpm test:visual` falla en 709 de 778 capturas por líneas base obsoletas) y que el encargo pide en verde. Según ADR-0011 §1 el propietario puede diferirlo, y ADR-0013 ya sacó esas capturas del CI por decisión suya. La recomendación de aprobar depende de que el propietario registre ese diferimiento o pida regenerar las capturas antes de aceptar.

Este informe **no** declara G4 aprobado. La aceptación de G4, y por tanto el inicio de M5, es decisión registrada del propietario.

## Candidato y entorno

- Candidato: `64bd116d2ab5e76dd0de04c0477e21d18298e07f` (`origin/main`, merge del PR #119 que añade el encargo). Worktree limpio, rama `wip/g4-report`.
- MySQL **8.4.11** (contenedor Docker `opslog-mysql`, `127.0.0.1:3306`, base sintética desechable), `max_connections = 500` como en el CI. `OPSLOG_TEST_MYSQL_ADMIN_URL=mysql://root@127.0.0.1:3306/mysql` en todas las corridas.
- Node 22.22.0, pnpm 11.25.0, Chromium 1194 preinstalado (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`), máquina de 4 núcleos y 15 GB.
- Solo datos sintéticos. Sin AWS, sin producción, sin correo real (el sumidero de prueba registra y no envía).

## 1. Regresión acumulativa

| Comando                       | Resultado                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm quality` (16 min)       | **Verde.** `baseline:check`, `leak:scan`, `lint`, `format:check`, `typecheck` y `build` verdes. `test:unit`: 3.359 pruebas en 233 archivos (web: 1.289 en 92), con los umbrales de cobertura cumplidos. `test:integration`: 869 pruebas en 82 archivos |
| `pnpm test:integration`       | Verde, dentro de `pnpm quality`. Incluye `test:platform` (61 archivos, 596 pruebas, cobertura de composición ≥ 95 %) y las seis suites de persistencia de siniestros                                                                                   |
| `pnpm test:fleet-integration` | **Verde.** 23 archivos, 102 pruebas                                                                                                                                                                                                                    |
| `pnpm test:e2e` con `CI=1`    | **Verde.** 147 de 147 en 10,0 min, incluidos `e2e/incidents-real.spec.ts` (15) y `e2e/incidents-journeys.spec.ts` (3) sobre la API real                                                                                                                |
| `pnpm test:visual` con `CI=1` | **Rojo.** 709 fallidas y 69 pasadas de 778 (18,4 min). Ver M-1                                                                                                                                                                                         |

Ninguna prueba MySQL se omitió: los resúmenes de Vitest no muestran `skipped` ni `todo` en ninguna corrida, y la variable de MySQL estaba definida en todas. Playwright no informó pruebas omitidas.

## 2. Siniestros de principio a fin

Comparado con SPECS §6.2 (tabla de transiciones), D8, D10, D11, D16, D17, D18, D20, D23, el BRD (BR-016 a BR-028, US-021 a US-051) y ADR-0014.

| Tramo                                                       | Evidencia                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Borrador → reporte con folio                                | J1 (el reportero edita su borrador y deja de poder al reportarlo, D8); folio por empresa y año bajo bloqueo de fila (`nextFolio` en `packages/persistence/incidents/cases/src/store.ts`); `e2e/incidents-real.spec.ts:90` (un folio con doble clic) |
| Evidencia y terceros                                        | `tests/e2e/fleet/incident-cases.test.ts:137` (identidad sellada `pii1.`, solo evidencia `clean`); J1, J2, J4                                                                                                                                        |
| Póliza y reclamo; aceptación; rechazo, apelación y asunción | J1 (aceptado), J2 (rechazo con carta, apelación única, segundo rechazo, asunción); `e2e/incidents-real.spec.ts:313` y el journey de navegador                                                                                                       |
| Reparación con orden o presupuesto (ADR-0014 §4)            | `tests/e2e/fleet/incident-workflow.test.ts:199` (sin orden ni presupuesto: 422 `repair_order_or_budget`); J3 (orden creada una vez con `Idempotency-Key`, vinculada, paso a `repair`)                                                               |
| Costos y D20 (estrictamente mayor, por moneda)              | J2 (igual al umbral: sin aprobación; un centavo más: aprobación de asunción y de cierre; la aprobación vence si el costo crece); `incident-close.test.ts:207`; `incident-costs.test.ts:205` (costo de una orden real leído de MySQL)                |
| Resolución y cierre con fotografía de costos                | `incident-close.test.ts:92` (un snapshot, un evento y la misma respuesta bajo concurrencia); `incident-costs.test.ts:309`                                                                                                                           |
| Reapertura, segundo ciclo                                   | J5 (solo `incidents:reopen`, motivo obligatorio, replay por clave, ciclo 1 intacto, segundo snapshot)                                                                                                                                               |
| Pérdida total y sin seguro                                  | J4 (`theft_total`, `decommissioned` propuesto y no aplicado, D11); J3 (`no_insurance` con motivo, asunción, cierre)                                                                                                                                 |

No es un CRUD desconectado. Cada transición pasa por la tabla `TRANSITIONS`, el CAS de versión, la lista de faltantes y una sola transacción con historial, auditoría y outbox. La reparación lee las órdenes de mantenimiento en vivo, y el cierre exige que estén `closed`. D20 lee los totales dentro de la transacción del comando.

Ninguna prueba del repositorio recorre por API o navegador el tramo `repair` → orden completada y cerrada → evidencia final → `resolve` desde `repair` → `close`. El auditor lo comprobó con una prueba temporal sobre el mismo arnés, que no se versionó y se borró después (L-1):

1. Con la orden abierta, `resolve` responde 422 con `repair_orders_finished`, `repair_costs` y `final_evidence`.
2. Tras completar la orden con costo, subir una foto `post_repair` y pasar el escaneo, `resolve` responde 200.
3. Con la orden solo completada, `close` responde 422 `repair_orders_closed`.
4. Al cerrar la orden, `close` responde 200.
5. El snapshot de costos y la fila de cierre contienen la orden y su importe.

La prueba pasó en el primer intento.

## 3. Plazos y avisos

- Avisos SLA al 80 % y al 100 %, inactividad a N y 2N días y escalaciones: `tests/integration/platform/incident-sla.test.ts` y `mysql-incident-sla.test.ts` (escenarios de `incident-sla-scenarios.ts`), en verde en las tres repeticiones.
- Un aviso por ciclo y destinatario: la fila (aviso, destinatario, canal) con lease hace idempotente el envío (`packages/domain/incidents/sla/src/delivery.ts:94-128`). Los permisos y la dirección se revalidan al enviar (`:131-136`). Repetir el escaneo no envía otro correo.
- Correo por puerto con sumidero de prueba. El mensaje lleva folio, tipo de aviso, severidad y enlace, sin importes, PII ni texto libre (`packages/domain/incidents/sla/src/mail.ts:24-37`).
- Producción falla cerrado: `selectIncidentAlertMailer` exige un remitente real, y la composición lanza una excepción si falta el directorio de direcciones (`apps/api/composition/src/platform/incident-sla-apis.ts:104-110`). La detección de producción (`production`/`prod` en el modo, `NODE_ENV` u `OPSLOG_ENV`) es única (`packages/platform/pii/src/environment.ts`).
- Disparo periódico: `PeriodicScheduler` existe y está probado (`tests/integration/platform/periodic.test.ts`), pero nada lo arranca (ver punto 7).

## 4. Seguridad multitenant

- **Aislamiento A/B.** `tests/integration/incidents/isolation.integration.test.ts`: matriz de 19 rutas contra un caso de la otra empresa, que compara el cuerpo con el de un id desconocido salvo el `correlationId`; además listas, filtros, sugerencias, vínculo de orden ajena, filas de B y grants de la cuenta de A. Verde tres veces.
- **Tenant y actor solo de la sesión.** `runSession` (`apps/api/incidents/cases/src/session.ts:63-98`) y el worker de SLA, que toma el tenant del sobre y rechaza cualquier campo extra (`apps/worker/incident-sla/src/index.ts:16-24`).
- **Permisos propios.** `mayRun` y `canView` (`packages/domain/incidents/workflow/src/access.ts`, `packages/domain/incidents/cases/src/access.ts`): los verbos genéricos no conceden nada. Lo prueban el editor de flota en `incident-workflow.test.ts` y `e2e/incidents-real.spec.ts:497`.
- **`incidents:view_costs`.** `requireCosts` antes de cualquier lectura o escritura de costos (`packages/domain/incidents/costs/src/service.ts:77-79`). Cerrar exige además `view_costs` (`workflow/src/access.ts:31`). El umbral de `GET /alerts/settings` se omite sin el permiso, y un `PUT` con la clave y sin el permiso da 403 (`apps/api/composition/src/settings.ts:117-121`, `:163-167`). Los timelines y la auditoría solo llevan conteos. Lo prueban J1, `e2e/incidents-real.spec.ts:939` y `e2e/incidents-journeys.spec.ts:307`.
- **PII.** La identidad de terceros se guarda sellada (`pii1.`) y solo se ve con `view_pii` e `incidents:view` (`incident-cases.test.ts:137`, `e2e/incidents-real.spec.ts:535`).
- **Atomicidad.** El caso (CAS), el folio, el historial, la auditoría local, la clave de idempotencia, el outbox y las escrituras hijas van en una transacción (`packages/persistence/incidents/cases/src/store.ts:105-182`). El outbox valida una allowlist exacta de ids, versión, estado y ciclo (`packages/domain/incidents/cases/src/events.ts`). `expectNoLeak` en J1, J2, J3 y J5 confirma que no hay texto libre ni importes en auditoría ni outbox.
- **Grants exactos** de `opslog_incidents_*`: `tests/e2e/fleet/mysql.ts:123-138` y `:316-321`, verificados por la matriz y por `incident-costs.test.ts:351`. Los snapshots y los cierres son `SELECT, INSERT`: el runtime no puede reescribirlos.

## 5. UX y accesibilidad

`e2e/incidents-real.spec.ts` y `e2e/incidents-journeys.spec.ts` cubren:

- listado con filtros en la URL y un 404 neutro para un caso ajeno (`:468`);
- asistente completo a 360 px con foto comprimida una vez, un reintento tras un corte de red y sin scroll horizontal (`:643`);
- ficha con pestañas, siguiente paso con los faltantes del servidor y 409 seguro que conserva lo escrito y ofrece «Recargar» (`:568`);
- teclado y foco (`:746`);
- axe WCAG 2.1 AA (`expectNoViolations`) en cada pantalla.

La compresión a 2 MB está en `apps/web/features/incidents/prepareFile.ts:4` y `:43-70`: emite PNG cuando hay transparencia y no toca PDF, DOCX ni XLSX. Las pruebas unitarias web (`wizard`, `tabs`, `plumbing`, `costs`, `repair`, `settings` y `sla`) pasaron dentro de `test:unit`.

## 6. Pruebas repetidas y mutación dirigida

### Repeticiones (×3)

| Conjunto                                                                                                                                                                                                                                                    | Resultado                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `tests/e2e/incidents`, `tests/integration/incidents`, `tests/e2e/fleet/incident-{cases,close,costs,workflow}.test.ts` y `tests/integration/platform/{incident-sla,mysql-incident-sla,periodic,alerts,mysql-alerts}.test.ts` (15 archivos, `--maxWorkers=4`) | 113/113 cada vez                                   |
| `test:integration` de `@opslog/persistence-incident-{cases,third-parties,workflow,repairs,costs,sla}`                                                                                                                                                       | 11, 13, 5, 6, 12 y 8 cada vez                      |
| `e2e/incidents-real.spec.ts` + `e2e/incidents-journeys.spec.ts` con `CI=1`                                                                                                                                                                                  | 18/18; **16/18** (1 fallida y 1 sin correr); 18/18 |

El fallo de la segunda corrida fue en `acceptance 12` (`e2e/incidents-real.spec.ts:990`): el asistente no mostró «Tipo de siniestro» en 15 s (`:167`). En aislamiento (`-g "acceptance 12"`) falló 1 de 7 veces, y el archivo completo pasó otras 2 de 2. Es una prueba nueva de M4 que falla de forma intermitente sin carga externa (L-2). No es de las inestables preexistentes que lista el encargo.

### Mutación dirigida (11 de 13 detectados)

Se aplicó cada mutante por separado. Para cada uno corrieron:

- las unitarias sin cobertura de `packages/domain/incidents`, `apps/api/incidents`, las pruebas BFF de siniestros y ajustes, `apps/api/composition` y `apps/worker/incident-sla` (347 pruebas, en verde sin mutar);
- el conjunto MySQL de las repeticiones, salvo `periodic`;
- la integración de persistencia afectada.

Después se restauró el archivo original, con verificación byte a byte. Al final `git status` y `git diff` quedaron vacíos.

| Mutante                                                                                                  | Detectado por                                                                                                |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| T1. `get()` del caso sin `tenantId` (`packages/persistence/incidents/cases/src/store.ts:210`)            | persistencia de casos (`mysql.integration.test.ts:246`)                                                      |
| T2. Líneas de costo sin `tenantId` (`packages/persistence/incidents/costs/src/store.ts:95`)              | **Ninguna** (L-3)                                                                                            |
| C1. `requireCosts` no exige `incidents:view_costs` (`packages/domain/incidents/costs/src/service.ts:78`) | unitarias de costos, API y BFF; MySQL `incident-costs.test.ts:149` y J1 (`accepted.integration.test.ts:124`) |
| C2. El `GET` de ajustes siempre incluye el umbral (`apps/api/composition/src/settings.ts:120`)           | `tests/integration/platform/alerts.test.ts:344`                                                              |
| C3. El `PUT` de ajustes acepta el umbral sin permiso (`settings.ts:167`)                                 | `alerts.test.ts:456`                                                                                         |
| C4. Cerrar sin `view_costs` (`packages/domain/incidents/workflow/src/access.ts:31`)                      | unitarias `close.test.ts:459` y `service.test.ts:573`                                                        |
| V1. `UPDATE` del caso sin versión (`packages/persistence/incidents/cases/src/store.ts:124`)              | persistencia de casos (`:207`) y MySQL `incident-workflow.test.ts:333`                                       |
| V2. El comando no compara la versión (`packages/domain/incidents/workflow/src/service.ts:169`)           | unitaria `service.test.ts:705` y BFF `incident-workflow.test.ts:145`                                         |
| D1. D20 con `>=` (`packages/domain/incidents/workflow/src/d20.ts:16`)                                    | 7 unitarias de workflow y J2 (`rejected.integration.test.ts:78`, igual al umbral)                            |
| D2. El cierre acepta en la transacción una aprobación vencida (`workflow/src/closing.ts:68-71`)          | **Ninguna** (L-4)                                                                                            |
| D3. La aprobación nunca vence por costos (`packages/domain/incidents/costs/src/ledger.ts:121`)           | unitaria `ledger.test.ts:150` y persistencia de costos (`mysql.integration.test.ts:539`)                     |
| M1. `isMechanicScoped` siempre falso (`packages/domain/incidents/cases/src/access.ts:15-16`)             | 7 unitarias de dominio, API y BFF (`incidents.test.ts:157`, `index.test.ts:258`, `delivery.test.ts` y otras) |
| M2. La sesión ignora `mechanicLinked` (`apps/api/incidents/cases/src/session.ts:78`)                     | API `index.test.ts:258` y BFF `incidents.test.ts:157`                                                        |

Las detecciones son por aserción, no por umbral de cobertura. C4, V2, M1 y M2 solo los detectan las pruebas unitarias o BFF sobre la composición real. Ninguna prueba MySQL los detecta, pero el código es el mismo y esas pruebas recorren la composición completa.

## Hallazgos

No hay hallazgos Critical ni High, ni Medium de seguridad.

- **M-1 (Medium, no de seguridad; el propietario puede diferirlo).** `pnpm test:visual` falla en 709 de 778 capturas. Las líneas base de `e2e/visual/__snapshots__/` se regeneraron por última vez en `d4674d7` (PR #99, piloto del tema v2). Después, las fases 1–6 de ADR-0013 (#102 a #108) y las pantallas de M4 cambiaron la interfaz sin regenerarlas. Ejemplo: `flota-alertas-lista--empty` muestra el nuevo estado vacío centrado y la captura todavía tiene el aviso anterior. Las diferencias son de un 2 % de píxeles y de alto de página, no del entorno: Chromium 1194 es el fijado por la configuración. Además, la story `foundations-avisos-y-controles-de-formulario` (`packages/ui/src/components/FormWidgets.stories.tsx`, PR #115) no tiene captura; la corrida generó cuatro y el auditor las retiró del worktree. El propietario sacó las capturas del CI (`.github/workflows/quality.yml:144`; ADR-0013, sección «Regresión visual fuera del CI», líneas 64-71). Aun así, ADR-0013:70-71 dice que la regresión visual de SPECS §9.1 «queda cubierta de forma local», y hoy no lo está: con estas líneas base la herramienta no puede detectar ninguna regresión. El encargo (punto 1) y el paquete INC-INTEGRATE (punto 7) piden `pnpm test:visual` en verde, e INC-INTEGRATE declara que no lo ejecutó (`docs/tasks/INC-INTEGRATE-M4-20261013.md:196`). Remedio: revisar las diferencias y regenerar con `pnpm test:visual:update`, o que el propietario registre que G4 se acepta sin esa comprobación.
- **L-1 (Low, trazabilidad y prueba).** `docs/traceability/incidents.md:90` afirma que el paso por `repair` con órdenes terminadas, costos de la orden y evidencia final está probado en `tests/e2e/fleet/incident-costs.test.ts` y en `e2e/incidents-real.spec.ts` (acceptance 11). No es así:

  - `incident-costs.test.ts:309` resuelve desde `under_review`;
  - acceptance 11 (`e2e/incidents-real.spec.ts:820`) se detiene en «En reparación»;
  - fuera de las unitarias de dominio (`close.test.ts`, `service.test.ts`), ninguna prueba menciona `repair_orders_finished`, `final_evidence` ni `repair_orders_closed`.

  El tramo funciona (prueba del auditor en el punto 2), así que es una brecha de evidencia, no de producto. Remedio: añadir ese tramo a J1 o J3 y corregir la frase.

- **L-2 (Low, prueba inestable).** `acceptance 12` (`e2e/incidents-real.spec.ts:990`) falló 2 de 11 veces: el formulario del asistente no apareció en 15 s tras `page.goto` (`:166-167`). No se investigó la causa (queda fuera del alcance ligero). Con `retries: 0` (SPECS §9.1), puede tumbar el job `e2e` del CI.
- **L-3 (Low, defensa en profundidad sin prueba).** Quitar `tenantId` del filtro de líneas de costo (`packages/persistence/incidents/costs/src/store.ts:95`) no rompe ninguna prueba. El aislamiento primario (una base física y una cuenta runtime por empresa) está probado por la matriz y los grants, y `visible()` rechaza antes de leer los costos de un caso ajeno. Por eso no es un hueco explotable. Aun así, el filtro por tenant de la segunda capa solo está probado en `get()` del caso (T1). Remedio: una aserción de persistencia con dos tenants en la misma base, como la de `cases` (`mysql.integration.test.ts:246`).
- **L-4 (Low, carrera de D20 sin prueba).** Se puede quitar la recomprobación, dentro de la transacción, de una aprobación de cierre vencida (`packages/domain/incidents/workflow/src/closing.ts:68-71`) sin que falle ninguna prueba. La comprobación previa (`requirements.ts:148-150`) cubre el caso secuencial. La de la transacción solo importa si el costo de una orden vinculada crece en mantenimiento entre la carga de hechos y la escritura, porque ese cambio no sube la versión del caso. El código es correcto al leerlo. Remedio: una prueba que inyecte el crecimiento del costo entre ambos momentos.
- **Info.** `IncidentWorkflowService.execute` valida el cuerpo y la clave antes de comprobar visibilidad y permiso (`packages/domain/incidents/workflow/src/service.ts:125-130`), así que un cuerpo inválido da 400 incluso a quien no ve el caso. La respuesta no depende del caso, así que no filtra nada. El paquete INC-WORKFLOW describe «permiso antes de parsear» (`docs/tasks/INC-WORKFLOW-M4-20261013.md:194`); conviene alinear la frase.
- **Info.** Los grants exactos de `opslog_incidents_*` solo existen en el arnés de pruebas (`tests/e2e/fleet/mysql.ts`). El aprovisionamiento real de cuentas sigue diferido con AWS (ADR-0002); al activarlo, se debe derivar de esa misma lista.

## 7. Deuda y pendientes declarados

| Pendiente                                                                                                                                                                                     | Valoración                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No hay `main` de servidor que arranque `platform.runtime.periodic`                                                                                                                            | **Diferible.** Sin anfitrión desplegado (AWS diferido, producción no autorizada) no hay proceso donde arrancarlo, y el planificador está probado. Pasa a ser bloqueante para cualquier despliegue: sin él, los avisos SLA y de inactividad nunca se generan. Lo mismo vale para los escaneos de planes de mantenimiento |
| D20 por monto en órdenes de mantenimiento (ADR-0014 §1)                                                                                                                                       | **Diferible.** Hoy mantenimiento pide aprobación en todo cierre con umbral, que es más estricto, no más laxo. Queda como FIX de mantenimiento                                                                                                                                                                           |
| Disparador periódico en la nube y envío real de correo (ADR-0002)                                                                                                                             | **Diferible.** El arranque en producción falla cerrado sin remitente ni directorio reales (punto 3)                                                                                                                                                                                                                     |
| FR-124, FR-125 y vistas guardadas                                                                                                                                                             | **Diferible.** Prioridad S, marcados como pendientes en la trazabilidad y no contados como implementados                                                                                                                                                                                                                |
| Validación ISO 4217 (solo la forma `[A-Z]{3}`)                                                                                                                                                | **Diferible (Low).** Es igual en los cuatro módulos y los totales nunca mezclan monedas                                                                                                                                                                                                                                 |
| Capacidad del escaneo SLA (500 casos ≈ 16,5 s)                                                                                                                                                | **Diferible.** Muy por debajo del presupuesto de 15 min por tenant (SPECS §9.3)                                                                                                                                                                                                                                         |
| INC-COSTS: lecturas de órdenes fuera de la transacción del caso                                                                                                                               | **Diferible.** La orden pertenece a otro módulo; se relee al decidir y D20 relee los totales en la transacción. El residuo de carrera es L-4                                                                                                                                                                            |
| INC-COSTS: `PUT costs` puede dar 500 tras confirmar; un `PUT` sin cambios no registra su clave                                                                                                | **Diferible.** Falla cerrado («nunca un cero») y el reintento con la misma clave repite la respuesta                                                                                                                                                                                                                    |
| INC-CASES: filtro de estado del `PATCH`; nombres de campo en el audit                                                                                                                         | **Diferible.** Decisión de diseño de plataforma; solo nombres de campo, nunca valores                                                                                                                                                                                                                                   |
| INC-SLA L1: `void kernel.outbox.transaction` en memoria                                                                                                                                       | **Diferible.** Solo afecta a la composición en memoria; el adaptador MySQL lo sustituye                                                                                                                                                                                                                                 |
| INC-INTEGRATE: umbral de mantenimiento según `view_costs`; escaneos encolados que no se fusionan; reloj de los journeys desde la hora real; `down` de `2026101500030` con `sql_mode` estricto | **Diferibles (Low/Info).** Ninguno afecta a la seguridad ni al resultado del flujo                                                                                                                                                                                                                                      |

Ningún pendiente declarado bloquea G4.

## Recomendación

1. Aceptar G4 sobre `64bd116`, sin hallazgos bloqueantes, una vez que el propietario decida sobre M-1: regenerar las capturas antes de aceptar, o registrar su diferimiento. Mientras no lo decida, el requisito de «checks acumulativos en verde» del encargo no se cumple para `pnpm test:visual`.
2. Registrar L-1 a L-4 y las notas Info como deuda diferible, a criterio del propietario. L-1 y L-2 son baratas de corregir y conviene hacerlo antes de M5.
3. El arranque del planificador periódico y la cuenta de correo real siguen siendo condiciones de cualquier despliegue, no de G4.

Este informe no declara G4 aprobado. La aceptación final de G4, y con ella el inicio de M5, corresponde al propietario.
