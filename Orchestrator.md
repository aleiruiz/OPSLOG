# OPSLOG — Orquestador de desarrollo y auditoría

Baseline: **ORCH-1.0**, compatible con **SPEC-1.0**.
Fecha: **2026-10-03**, America/Mexico_City.
Estado: especificación del sistema de coordinación; runtime aún no implementado.
Autoridad de producto: [SPECS.md](SPECS.md). Este documento es inmutable bajo su política de versiones sucesoras.

## 1. Objetivo y responsabilidades

Coordinar agentes OpenAI y Anthropic que trabajan de forma independiente/asíncrona en el mismo repositorio, con worktrees aislados, contratos estables, revisiones independientes y entregas integradas verificables. Mantener al menos tres líneas de implementación disponibles durante cada etapa, cuando el DAG y la capacidad lo permiten. La continuidad de asignaciones jamás prevalece sobre calidad, aislamiento ni gates.

El orquestador es el único escritor del estado compartido y el único actor autorizado a asignar/fusionar. Conoce propósito, fuentes, baseline, dependencias, contratos, pruebas, estado GitHub, hallazgos y gates. No implementa silenciosamente tareas de autores ni considera un resumen de agente como evidencia de aceptación.

Actores:

| Actor | Función | Restricciones |
|---|---|---|
| Orquestador | Selección/leases, despacho, recuperación, reconciliación y fusión. | Sin acceso a datos operativos reales; no aprobarse a sí mismo. |
| Implementador | Ejecuta paquete, pruebas y PR. | Un worktree y alcance de escritura; no fusiona ni cambia gates. |
| Subagente auditor local | Cada implementador lo genera para revisar su cambio antes del PR. | Contexto independiente; lectura/correr pruebas, sin editar el trabajo del autor. |
| Auditor OpenAI | Revisión externa del PR por SHA y validación de requisitos. | Sesión/contexto separados del autor, sin credenciales de merge. |
| Auditor Anthropic | Revisión externa independiente, complementaria. | Mismas restricciones; no se suple con otro auditor del mismo proveedor. |
| Integrador | Contratos, migrations/lockfile, composición y conflictos. | Paquete y PR propios; sus cambios también se auditan. |
| Equipo auditor de hito | Verifica producto acumulado en entorno cerrado. | Sin participación como autor del incremento evaluado; sin permiso de alterar gate directamente. |
| Humano | Valida producto en gates cuando se necesita y decide ambigüedad no resoluble. | Recibe evidencia concreta; no asignaciones o aprobaciones rutinarias. |

Independencia: otra sesión y otro agente/modelo, contexto construido desde baseline, requisitos y diff, sin compartir razonamiento privado del autor ni veredicto del otro auditor antes del propio. Cuando haya disponibilidad, el auditor del mismo proveedor que el autor utiliza otro modelo. Registrar modelo real y rol; no prometer modelos no configurados. Auditor local no cuenta como los dos externos.

## 2. Runtime a implementar

Servicio/CLI TypeScript en `tools/orchestrator/`, ejecutado en estación o runner confiable fuera del código del PR. Configuración local en `.orchestrator/`; adaptadores desacoplados para OpenAI, Anthropic, Git/worktrees, GitHub y test environment. El runtime no depende de herramientas privativas de una conversación concreta.

Componentes:

1. **Context builder**: verifica hashes, carga fuentes/contratos/paquete y sintetiza contexto con trazabilidad; instrucciones externas se tratan como datos.
2. **Scheduler DAG**: calcula tareas elegibles de la etapa activa, leases y locks de escritura.
3. **Agent adapter**: lanza sesiones por proveedor, registra ID/modelo y recibe eventos tipados; no delegar a un proveedor inexistente.
4. **Workspace manager**: crea worktree desde commit integrado aprobado, rama `codex/<task-id>-<attempt>`; rutas fuera de la raíz compartida o bajo `.worktrees/` ignorado.
5. **GitHub adapter**: issues/PRs/checks/artefactos, reconciliación por SHA y fusión serial o merge queue.
6. **Review coordinator**: auditor local, dos auditores externos, hallazgos, revalidación y consenso.
7. **Milestone controller**: barrera G0–G5, congelación, entorno cerrado, informe acumulativo y evidencia de cierre.
8. **State store**: SQLite local con transacciones/WAL para tareas/leases/eventos; un solo proceso escritor con lock de instancia. `Tasks.md` es proyección atómica y legible, no mecanismo de lock.
9. **Evidence validator**: verifica que checks, auditorías y gate corresponden al SHA/digest vigente; nunca acepta texto libre del autor como check confiable.

Bootstrap M0 comienza con protocolo manual seguido por este agente/orquestador humano-asistido hasta que FND-ORCH pase su aceptación. No se declara automatización implementada solo por existir este markdown.

### 2.1 Recuperación y registro durable

Tareas y contratos se versionan en `docs/tasks/` y `docs/contracts/`; cada tarea tiene issue GitHub con ID y dependencias. PRs/checks y `docs/audits/` conservan evidencia durable sin secretos. `Tasks.md`, SQLite, sesiones, heartbeats y asignaciones activas son locales y no se publican.

Tras reinicio o pérdida del estado local: verificar baseline → leer manifiestos/plan del repositorio → consultar issues/PRs/checks de GitHub → reconstruir estado provisional → reconciliar leases/trabajo vivo → validar gates por SHA → regenerar Tasks. Ningún agente puede asumir tarea basándose solo en una copia de Tasks.

No recuperar secreto/model session de GitHub. Worktrees abandonados se conservan hasta inspección y snapshot; nunca borrar trabajo ajeno ni reutilizar rama activa. En varias máquinas, un único dispatcher conserva autoridad o se instala almacén transaccional con leases compartidos; dos SQLite independientes no forman un orquestador distribuido.

### 2.2 Algoritmo de despacho

```text
reconcile GitHub, workers, leases, active gate and baseline integrity
if gate is pending/failed/auditing/waiting_human:
    eligible = corrections + independent revalidation for current/past milestones
else:
    eligible = tasks of active milestone whose hard dependencies are accepted
for eligible task by critical path, unblock value and aging:
    require validated packet, provider capacity and nonconflicting write locks
    acquire lease + fencing token in one state-store transaction
    record task attempt and base SHA before creating workspace
    dispatch context and scoped capabilities
persist events; atomically regenerate Tasks.md
```

Lease inicial 30min, heartbeat cada 60s; tolerancia 5min de heartbeat antes de investigar. El timeout no prueba que el agente murió. Confirmar estado/provider/worktree antes de reasignar. Reasignación incrementa fencing token; resultados de intento antiguo se marcan stale y no fusionan. API idempotente por taskId/attempt/eventId.

Cada tarea tiene máximo 3 ciclos de reparación antes de triage del orquestador y auditor adicional. Si discrepancia cambia producto/baseline o requiere decisión humana, escalar con repro/evidencia y opciones; conservar gate bloqueado. No forzar unanimidad ni bajar severidad para terminar.

### 2.3 Capacidad y paralelismo

Objetivo: **tres implementadores simultáneos** y capacidad separada para subagentes/auditores. Usar ventanas de auditoría si el entorno tiene pocos slots; no afirmar que tres autores y sus seis auditores caben en tres sesiones. Presupuesto, concurrencia y modelos se configuran por proveedor; subagentes acotados a un nivel de auditoría, sin recursión ilimitada.

Durante etapas hay carriles de backend/dominio, UI y plataforma/calidad. El comienzo de cada M0–M5 tiene al menos tres paquetes elegibles tras el gate previo. Cuando un carril espera contratos, puede trabajar en pruebas de contrato, adaptadores o documentación **del mismo hito**, con paquete explícito. No desarrollar módulos posteriores especulativamente. En gates todas las líneas se convierten a auditoría/remediación; al agotar alcance no se crean tareas artificiales para sostener ocupación.

## 3. Contrato de paquete de tarea

Materializar antes de asignar en `docs/tasks/<ID>.md`. Campos obligatorios:

```yaml
id: FLT-VEHICLES
baseline: [SPEC-1.0, ORCH-1.0]
milestone: M2
kind: implementation # foundation | implementation | integration | milestone-audit | remediation
purpose: "...resultado operativo..."
requirements: [FR-070, BR-002] # lista individual completa, no rango genérico
source_decisions: [U-05, "SPECS §5.2"]
depends_on: [G1] # enlaces a manifiestos; hard dependencies accepted
consumes: ["contracts/fleet-v1"]
produces: ["fleet-service-v1"]
write_paths: ["packages/domain/fleet/**", "packages/persistence/fleet/**"]
read_paths: ["SPECS.md", "docs/contracts/**"]
forbidden_paths: ["SPECS.md", "Orchestrator.md", "Tasks.md", ".env*"]
acceptance: ["...Given/When/Then reproducible..."]
unit_cases: ["...reglas/carreras/bordes..."]
integration_cases: ["...MySQL, HTTP, tenant A/B..."]
e2e_cases: ["...cuando aplica..."]
commands: ["...comandos establecidos en FND-REPO..."]
fixtures: ["...sintéticos, seed determinista..."]
non_goals: ["...fronteras explícitas..."]
completion_evidence: ["PR", "SHA", "CI", "reviews", "traceability"]
rollback: "...reversión de código y estrategia de datos..."
max_repair_cycles: 3
```

Propietario, agente/proveedor, lease, rama, worktree, intento y porcentaje se guardan en estado local; nunca en el contrato inmutable de tarea como si fueran requisitos.

Definition of Ready: requisitos individuales mapeados, dependencias aceptadas, contrato/version fijados, paths sin conflicto, criterios verificables, presupuesto/servicios disponibles y gate de entrada pasado. Un paquete puede consumir mocks de un contrato aprobado; no inventar interfaces mientras otro agente las implementa.

Definition of Done: alcance completo, pruebas relevantes/CI verdes, matriz de trazabilidad, auditor local resuelto, dos auditorías independientes conformes al SHA, candidato integrado verificado y merge aceptado. `accepted` habilita dependencias **dentro del hito**; no habilita la siguiente etapa sin gate.

## 4. Estados, eventos y permisos de agentes

Estados: `planned → ready → leased → running → local_review → pr_open → external_review → integration → accepted`. Salidas laterales: `blocked`, `changes_requested`, `failed`, `stale`, `cancelled`. Desde cambios solicitados vuelve a running en el mismo intento o uno nuevo. Accepted requiere merge a rama objetivo y checks del resultado; abrir PR no equivale a terminar.

Eventos tipados: TaskLeased, AgentHeartbeat, ContractChangeRequested, LocalReviewCompleted, PRPublished, ReviewFindingOpened/Resolved, ExternalReviewCompleted, CICompleted, IntegrationCandidateCreated, MergeCompleted, GateAuditStarted/Failed/Passed, HumanDecisionRecorded y LeaseExpired. Guardar actor, task/attempt, timestamp UTC, fencing token, SHA y evidenceRefs.

Capabilities por rol: autor escribe solo paths asignados y su rama; auditor lee y ejecuta en sandbox sin secretos; orquestador tiene merge por automatización confiable y permisos GitHub mínimos; provisioning/deploy solo entorno autorizado. Autores no editan workflows/gate status ni otorgan credenciales a subagentes. Cambios de CI/seguridad requieren auditor especializado y revisión independiente del nuevo check.

## 5. Worktrees y control de conflictos

- Un implementador por worktree; base de main aceptada o rama integrada de hito designada. Prohibido compartir carpeta de trabajo activa entre agentes.
- Antes de editar, verificar rama, base SHA y paths. Commits pequeños y PR único por paquete; mencionar taskId y baseline.
- Contratos/migraciones dependientes del ORM viven en carpetas por dominio; un integrador revisa orden y compatibilidad. No editar migraciones ya aplicadas; agregar nuevas.
- `pnpm-lock.yaml`, raíz de workspace, registry de contratos y workflows tienen lock exclusivo y paquete propietario. Solicitar cambio mediante ContractChangeRequested; otros autores no sobrescriben.
- Rebase/merge de main actualizado antes de integrar; resolver conflictos semánticos con pruebas, no solo eliminar marcadores. Cualquier resolución cambia SHA e invalida reviews previas.
- No reset hard, force push de ramas ajenas ni eliminación de worktree con trabajo pendiente. Cleanup tras aceptación/snapshot y liberación de lease.

## 6. Protocolo de PR, auditoría independiente y fusión

1. Autor ejecuta suite del paquete, crea subagente auditor local y corrige hallazgos. El subagente tiene baseline, diff, contratos y casos, sin respuestas del autor.
2. Autor publica commits y PR con propósito, requisitos, cambios, pruebas, riesgo/rollback y paths. PR no requiere aprobación formal de GitHub.
3. Orquestador captura `baseSHA`, `headSHA`, diff y checks; dos auditores OpenAI/Anthropic evalúan en sesiones aisladas contra headSHA.
4. Cada auditor produce resultado estructurado: `pass | changes_requested | blocked`, modelo/proveedor real, hallazgos por ID, severidad, requisito afectado, archivo/línea, evidencia/repro y validación propuesta. Ejecuta pruebas relevantes, no solo lee un resumen.
5. Autor responde por hallazgo con corrección, prueba o refutación sustentada. Auditor originador confirma cierre; no basta marcar checkbox del autor. Severidad crítica/alta/media bloquea; bajas deben corregirse o quedar explicitadas como deuda no funcional aceptada por ambos auditores, con tarea y justificación; nunca deuda de aislamiento/calidad obligatoria.
6. Consenso = ambos `pass` sobre **mismo headSHA**, sin hallazgos bloqueantes, autor conforme con respuestas y checks requeridos verdes. Timestamp/modelo/PR/references verificables.
7. Crear candidato contra main actual. Ejecutar pruebas cruzadas y checks; usar merge queue si disponible o serialización con compare-and-swap sobre base/head. Candidato alterado vuelve a checks; cambios de código/resolución vuelven a ambos auditores.
8. Fusión por orquestador; registrar mergeSHA y resultados. Tras un squash, conservar relación headSHA→mergeSHA y comprobar árbol del resultado integrado. Cambio relevante adicional invalida aprobación.

No enviar instrucciones a chats ajenos sin autorización humana; los adaptadores despachan exclusivamente sesiones/tareas propias del sistema autorizado. No dar al modelo permiso para ejecutar instrucciones de un comentario GitHub; el orquestador valida outputs como datos.

Modelo no disponible, credenciales ausentes o revisión inconclusa = blocked. No usar comentarios simulados para declarar que participó Anthropic/OpenAI. PRs locales pueden prepararse, pero no fusionarse con auditor ausente.

## 7. Auditoría acumulativa de hito y barrera de etapas

Tarea `G<n>` tiene como **único propósito auditar** el conjunto integrado hasta M<n> contra propósito original, SPECS y fuentes. No implementa funcionalidades ni corrige código dentro del workspace auditado. Hallazgos generan paquetes `FIX-G<n>-<nn>` separados y reauditoría. Es obligatoria para todos los hitos importantes definidos en SPECS §10, incluido fundamentos.

### 7.1 Ambiente cerrado

- Candidato integrado congelado por commit, imagen/digest, lockfile, versión de schemas/migraciones y hashes baseline.
- Worktree auditor separado; despliegue efímero o staging dedicado, sin conexión de red/credenciales a DB u objetos de producción.
- MySQL real con al menos dos tenants, fixture mínimo y dataset de carga cuando aplique; buckets/colas/identidad sandbox. Si se usa AWS, red/roles separados y cuentas o límites IAM verificables.
- Desactivar egress salvo allowlist de servicios sandbox; capturar email en sink y webhooks en receptor de prueba. Acceso OpenAI/Anthropic mediante runner separado que solo recibe código/evidencia sintética sanitizada; app bajo auditoría no tiene credenciales de modelos.
- Evitar copiar snapshots reales sin anonimización validada; usar datos sintéticos por defecto. No enviar a modelos PII/logs/credenciales.
- Reproducible desde cero con procedimiento documentado; reset solo datos sintéticos desechables de ese entorno.

### 7.2 Proceso y evidencia

1. Scheduler congela avance a etapas posteriores y marca gate `auditing`.
2. Inventario acumulativo: todos los taskIDs/PRs/mergeSHAs hasta el hito, FR/BR/NFR/US aplicables, diferidos explícitos y decisiones de artifact.
3. Dos auditores independientes verifican producto con contexto limpio; revisar finalidad y flujos, seguridad multitenant, integración real, UX/accessibilidad, calidad y deuda. En G0 validar contratos/tema/stories/plan; no exigir funcionalidades aún no construidas.
4. Ejecutar matriz acumulativa de pruebas, amenazas, regresión y escenarios del BRD §3/§22. Comparar UI con artifact y necesidad operativa; no aceptar un CRUD desconectado como workflow completo.
5. Publicar `docs/audits/G<n>/<candidateSHA>/report.md` con alcance, entorno, comandos/resultados, trazabilidad individual, capturas sintéticas, hallazgos, modelo/proveedor y veredicto. Adjuntar logs de CI/artefactos con digest/retención conocida, sin secretos.
6. Si falla, gate `failed`; asignar solo remediaciones/revalidaciones. Tras cada corrección construir nuevo candidato, repetir casos afectados y regresión acumulativa; informe previo queda histórico, no sobrescrito.
7. Si hay duda de intención/UX, mostrar demo cerrada, diferencias y preguntas concretas al humano; gate `waiting_human`. Registrar respuesta y alcance. No exigir revisión humana si auditores pueden resolver objetivamente; el permiso del usuario habilita solicitarla en estos gates.
8. Gate `passed` solo cuando dos auditores conformes, checks acumulativos verdes, cobertura de todos los requisitos aplicables, sin hallazgos bloqueantes/deuda incompatible y, si se pidió intervención humana, respuesta suficiente recibida.
9. Evidencia de gate se emite desde automatización confiable vinculada al candidato. PR de informe también auditado; el autor del incremento no puede declarar passed. Abrir siguiente etapa solo después de registrar aceptación.

### 7.3 Regresión e invalidación

Un gate aprobado vincula un árbol de código/configuración exacto. Remediación sobre funcionalidad previamente aprobada obliga a revalidar ese alcance en el gate actual. Si descubre que un invariante crítico previo ya no se cumple, congelar trabajo posterior, invalidar gate afectado y reparar; no conservar passed por conveniencia.

Pseudocondición de inicio de etapa:

```text
canStart(M0) = baseline checked and authorized planning complete
canStart(Mn) = G(n-1).passed and no invalidated previous gate and provider capacity
canPass(Gn) = cumulativeRequirementsCovered(candidate)
              and requiredChecksGreen(candidate)
              and twoIndependentAuditsPass(candidate)
              and blockingFindings == 0
              and (humanDecisionNotRequested or sufficientHumanDecisionReceived)
```

No tiempo transcurrido, silencio humano ni número de reintentos equivalen a consentimiento o gate cerrado. Producción sigue fuera de la autorización de despliegue; G5 passed significa listo para evaluación/publicación autorizada, no publicación automática.

## 8. Catálogo inicial de tareas y DAG

Los paquetes siguientes definen alcance, dependencias y aceptación inicial. Cada uno hereda SPECS §4/§9 y el contrato §3; antes del despacho se materializa con requisitos individuales, casos/commands y contratos concretos. No asignar paquetes incompletos. Dependencias son hard y están linkeadas; un gate depende de **todos** los paquetes de su hito.

Las dependencias de gate implican transitivamente todos los anteriores. Paths indicados son límites iniciales; registrar granularidad de archivos en el lease. Paquetes con directorio compartido usan subdirectorios propios o lock; no permitir escritura simultánea al mismo archivo.

### M0 — Fundamentos; cinco paquetes inicialmente elegibles

#### FND-REPO

Depende: baseline SPEC-1.0/ORCH-1.0. Paths: raíz workspace, configuración lint/format/TS, `.github/workflows/quality*`, `tests/harness/`. Entrega monorepo/lockfile, comandos reproducibles, CI MySQL, coverage, build y bootstrap fixtures. Aceptación: clon limpio ejecuta verificaciones; pipeline falla intencionalmente ante test aislado fallido, lint y cobertura insuficiente; sin AWS real en PR CI. Solo este paquete escribe lockfile/raíz inicialmente.

#### FND-CONTRACTS

Depende: baseline. Paths: `packages/contracts/**`, `docs/contracts/**`, `docs/traceability/**`. Entrega inventario individual de FR/BR/AC/NFR/US, alcance/diferidos y contratos tenant/auth/errores/eventos/archivos más contratos versionados de módulos futuros. Aceptación: ninguna regla huérfana, conflictos fuente/default explícitos, esquemas validan casos válidos e inválidos; no importar ORM. Pruebas son primera responsabilidad de este paquete.

#### FND-DS

Depende: baseline. Paths: `packages/ui/**`, `docs/design/**`. Primera tarea UI; tokens/tema/stories/componentes base y patrones del artifact. Puede preparar archivos aislados antes de FND-REPO; verificación ejecutable espera su integración. Aceptación: catálogo con todos los estados, teclado/contraste/axe y snapshots representativos; sin pantallas funcionales.

#### FND-AWS

Depende: baseline. Paths: `infra/plan/**`, `docs/adr/aws*`, `docs/runbooks/inventory*`. Inventario read-only de DB/entorno cuando exista acceso, motor/versión/región/capacidad/permisos, plan IaC/costos y secretos/red/backup; preparar sin credenciales. Aceptación: pruebas/plan de compatibilidad para base por tenant, separación de staging y plan de recuperación; ausencia de acceso registrada como dependencia real, no inventario aprobado. No provisiona ni modifica base existente.

#### FND-ORCH

Depende: baseline. Paths: `tools/orchestrator/**`, `docs/operations/**`, `tests/orchestrator/**`. Runtime, adaptadores, DAG, leases/fencing, state store y proyección Tasks; bootstrap sin API keys reales con fakes. Aceptación: simulación de tres agentes, caída/reinicio, reporte stale, bloqueo gate, doble asignación, invalidación por SHA, proveedor ausente y reconstrucción desde GitHub; pruebas verifican que gate pendiente nunca despacha etapa siguiente. Materializa paquetes/links/issues cuando acceso autorizado disponible; no mezcla estado local en Git.

#### FND-INTEGRATE

Depende: [FND-REPO](#fnd-repo), [FND-CONTRACTS](#fnd-contracts), [FND-DS](#fnd-ds), [FND-AWS](#fnd-aws), [FND-ORCH](#fnd-orch). Paths: composición raíz/lockfile/workflows, `docs/baselines/integrity*`. Integra bases sin funcionalidades, hashes confiables y checks de gobernanza, valida disponibilidad real de proveedores/merge/checks. Aceptación: tema + contratos + tests/runtime ejecutables juntos; protección de baseline/gates contra cambios del autor; si permisos externos faltan, no falsear G0.

#### G0

Depende: [FND-INTEGRATE](#fnd-integrate). Auditar acumulativamente M0 bajo §7: diseño, trazabilidad, interoperabilidad, CI, aislamiento previsto y viabilidad DB/AWS/proveedores. **Bloquea M1**. Informe en `docs/audits/G0/`; no implementación.

### M1 — Plataforma segura; cuatro paquetes inicialmente elegibles

#### CORE-AUTH

Depende: [G0](#g0). Paths: `packages/domain/identity/**`, `packages/platform/auth/**`, `apps/api/auth/**`. Cognito/BFF/sesión, invitación, revocación, RBAC/ownership y último admin. Aceptación: sesiones revocadas y roles cambiados no permiten operaciones/jobs; dos bajas concurrentes no eliminan último admin; permisos por DTO; provider adapter probado y flujo sandbox.

Incluye política de contraseña, MFA, invitación 72h, sesión 8h y recuperación segura de SPECS §5.4; validar que la configuración Cognito satisface cada control, con pruebas del BFF donde el proveedor no sea suficiente.

#### CORE-TENANCY

Depende: [G0](#g0). Paths: `packages/persistence/tenancy/**`, `packages/domain/tenants/**`, `apps/api/tenants/**`, `infra/database/**`. Directorio, pools acotados, credentials separadas, aprovisionamiento/migraciones y context factory. Aceptación: dos bases reales y usuario A denegado en B; concurrencia/reintento no mezcla conexiones; fallo de aprovisionamiento no activa tenant; inventario motor existente validado antes de conexión.

#### CORE-FILES

Depende: [G0](#g0). Paths: `packages/platform/files/**`, `packages/domain/files/**`, `apps/api/files/**`, `infra/storage/**`. S3 privado, quarantine/scan, originales/derivados y descarga autorizada. Aceptación: archivos falsos/pendientes/ajenos no se descargan; acceso directo privado; revocación bloquea proxy; scanner caído solo encola. Integración AWS IAM real aparte del emulator.

#### CORE-AUDIT

Depende: [G0](#g0). Paths: `packages/platform/audit/**`, `packages/platform/outbox/**`, `apps/worker/base/**`, `infra/queues/**`. Audit/outbox/transacciones, dispatcher worker, métricas y eventos. Aceptación: rollback no publica; retry no duplica; audit sin PII; jobs de tenant ausente/suspendido rechazan contexto; reconciliación durable demostrada.

#### CORE-WEB

Depende: [CORE-AUTH](#core-auth), [CORE-TENANCY](#core-tenancy). Paths: `apps/web/app/**`, `apps/web/auth/**`, `apps/web/settings/access/**`. Shell React/login/invitación/admin tenant/usuarios/roles en design system aceptado. Aceptación: empresa/usuario visibles, estados UI completos, sin tokens en almacenamiento navegador, rutas respetan permisos y sesión expirada conserva borradores del servidor.

#### CORE-INTEGRATE

Depende: [CORE-AUTH](#core-auth), [CORE-TENANCY](#core-tenancy), [CORE-FILES](#core-files), [CORE-AUDIT](#core-audit), [CORE-WEB](#core-web). Paths: composition API/worker, `tests/integration/platform/**`, `infra/runtime/**`. Une auth/context/storage/outbox y primer staging seguro. Aceptación: flujo tenant→usuario→objeto→audit con A/B; suite negativa integral y despliegue controlado solo staging.

#### G1

Depende: [CORE-INTEGRATE](#core-integrate). Auditoría M0–M1: sesiones, RBAC, base, archivos, caches/jobs y operación de control. **Bloquea M2**. Informe `docs/audits/G1/`.

### M2 — Flota y cumplimiento; siete paquetes inicialmente elegibles

#### FLT-PEOPLE

Depende: [G1](#g1). Paths: `packages/domain/people/**`, `packages/persistence/people/**`, `apps/api/people/**`. Áreas/empleados/perfiles/aptitud/PII/dispatcher y catálogo propio. Aceptación: árbol sin ciclos, restricciones de baja/reasignación, índices HMAC/cifrado, permisos de PII y históricos conservados; licencia vencida bloquea aptitud.

#### FLT-VEHICLES

Depende: [G1](#g1). Paths: dominio/persistence/API `fleet/**`. Vehículo/borrador/estado/odómetro/asignaciones/historial. Consume interfaces people aprobadas con fake de contrato hasta integración. Aceptación: race de principales solo acepta uno, odómetro monotónico/corrección auditada, VIN por tenant, cambios con motivo; fixtures A/B.

#### FLT-DOCS

Depende: [G1](#g1). Paths: dominio/persistence/API `documents/**`, `insurance/**`. Versionado, propietarios tipados, pólizas y fotos/set, metadatos/renovación. Aceptación: histórico preservado, fechas/coverage evento coherentes, original inalterado, links ajenos denegados; sin activar purga provisional.

#### FLT-SETTINGS

Depende: [G1](#g1). Paths: dominio/persistence/API `settings/**`, `apps/web/settings/company/**`. Catálogos/branding seguro/etiquetas/campos/obligatoriedad/cuotas/umbrales. Aceptación: defaults MX no obligan país real; catálogos en uso se desactivan sin borrar; schema valida límites y entradas no ejecutables; branding conserva contraste.

#### FLT-UI-PEOPLE

Depende: [G1](#g1). Paths: `apps/web/features/people/**`. Listas/fichas/personas/áreas con contratos publicados y mocks de API. Aceptación: búsqueda/tablas/estados/validación/aptitud accesibles; PII nunca requerida para vistas sin permiso; mapper API real se verifica al integrar.

#### FLT-UI-FLEET

Depende: [G1](#g1). Paths: `apps/web/features/fleet/**`, `apps/web/features/documents/**`, `apps/web/features/insurance/**`. Listados, ficha, wizard vehículo y renovación según artifact. Aceptación: wizard guarda pasos/borrador, errores de concurrencia recuperables, versiones y motivos visibles; sin duplicar estilos/reglas.

#### FLT-IMPORT

Depende: [G1](#g1). Paths: dominio/platform/API `imports/**`, `apps/web/features/imports/**`. CSV/XLSX plantilla/dry-run/jobs/error rows con puertos people/fleet. Aceptación: dry-run 300 filas/12 inválidas no escribe; modo válidas importa 288 una sola vez; confirma snapshot/permisos; rechaza injection/formulas y tenant manipulado.

#### FLT-ALERTS

Depende: [FLT-PEOPLE](#flt-people), [FLT-VEHICLES](#flt-vehicles), [FLT-DOCS](#flt-docs), [FLT-SETTINGS](#flt-settings). Paths: `packages/domain/eligibility/**`, `packages/domain/expiry/**`, `apps/worker/expiry/**`. Motor elegibilidad/vencimientos y eventos in-app/email de cumplimiento. Aceptación: fecha/zona, umbrales idempotentes, renovaciones reinician ciclo, estado sugerido no evita marcar no apto; jobs no mezclan tenants.

#### FLT-INTEGRATE

Depende: [FLT-PEOPLE](#flt-people), [FLT-VEHICLES](#flt-vehicles), [FLT-DOCS](#flt-docs), [FLT-SETTINGS](#flt-settings), [FLT-UI-PEOPLE](#flt-ui-people), [FLT-UI-FLEET](#flt-ui-fleet), [FLT-IMPORT](#flt-import), [FLT-ALERTS](#flt-alerts). Paths: composition/migration registry y `tests/e2e/fleet/**`. Aceptación: escenarios BRD seguro vencido, conductor no apto, alta/renovación/import/asignación completos sobre DB real; regresión plataforma verde.

#### G2

Depende: [FLT-INTEGRATE](#flt-integrate). Auditar M0–M2: persona/flota/documentos/seguro/elegibilidad y trazabilidad completa. **Bloquea M3**. Informe `docs/audits/G2/`.

### M3 — Mantenimiento; cuatro paquetes inicialmente elegibles

#### MNT-PLANS

Depende: [G2](#g2). Paths: dominio/persistence/API `maintenance/plans/**`, `workshops/**`, `mechanics/**`, `apps/worker/maintenance-plans/**`. Planes por fecha/km, talleres/mecánicos, generación/alertas idempotentes. Aceptación: lo que ocurra primero, actualización de plan no cambia historia, dos workers no duplican orden; asignación a mecánico respeta tenant.

#### MNT-ORDERS

Depende: [G2](#g2). Paths: dominio/persistence/API `maintenance/orders/**`. Workflow, trabajo/refacciones/costo/ownership/reapertura. Aceptación: transiciones tabla SPECS, completion checklist, confirmación estado sin ignorar bloqueos, costos exactos, permisos del mecánico y rollback audit/outbox; consumir puerto planes.

#### MNT-UI

Depende: [G2](#g2). Paths: `apps/web/features/maintenance/**`. Listado/calendario/planes/talleres/ficha/NextStep/Mis órdenes; mocks de contratos aprobados. Aceptación: flujo de orden operable por rol con teclado y responsive mínimo; faltantes claros, costos omitidos sin permiso, estados por workflow artifact.

#### MNT-QA

Depende: [G2](#g2). Paths: `tests/integration/maintenance/**`, `tests/e2e/maintenance/**`, `tests/fixtures/maintenance/**`. Diseña casos independientes de implementadores y contratos, luego los ejecuta contra candidato. Aceptación: carrera, costo/stock sin inventario, evidence pendiente, reabrir sin duplicar plan, vehículo con dos bloqueos; no pasa con mocks como evidencia final.

La preparación de la suite puede aceptarse como artefacto de este paquete contra contratos; la ejecución verde sobre todos los módulos reales es requisito de MNT-INTEGRATE/G3. Un test aún sin implementación se registra pendiente, no se omite ni se declara validado.

#### MNT-INTEGRATE

Depende: [MNT-PLANS](#mnt-plans), [MNT-ORDERS](#mnt-orders), [MNT-UI](#mnt-ui), [MNT-QA](#mnt-qa). Paths: composition/registry y `docs/traceability/maintenance*`. Aceptación: preventivo/correctivo completo real, factura/evidencia/alertas y regresión flota; QA final obligatorio.

#### G3

Depende: [MNT-INTEGRATE](#mnt-integrate). Auditar M0–M3, mantenimiento de principio a fin y propósito de reducir trabajo reactivo. **Bloquea M4**. Informe `docs/audits/G3/`.

### M4 — Siniestros; cinco paquetes inicialmente elegibles

#### INC-CASES

Depende: [G3](#g3). Paths: dominio/persistence/API `incidents/cases/**`, `incidents/third-parties/**`. Evento/borrador/terceros/seguro a fecha del evento/ownership. Aceptación: evento válido, sugerencia conductor histórico, póliza histórica, datos de terceros protegidos y vehículo obligatorio de tenant.

#### INC-WORKFLOW

Depende: [G3](#g3). Paths: dominio/persistence/API `incidents/workflow/**`. Máquina SPECS, requisitos, rechazo/apelación/No Insurance, cierre/reopen/aprobación opcional. Aceptación: tabla exhaustiva de pares estado/permiso, rechaza saltos/override, version conflicts, evidencia limpia, casos cerrados realmente inmutables.

#### INC-COSTS

Depende: [G3](#g3). Paths: dominio/persistence/API `incidents/costs/**`, `incidents/repairs/**`. Vincular mantenimiento, consolidar costos/coberturas y snapshot cierre. Aceptación: no duplicar costos de orden, currencies incompatibles explícitas, ausencia view_costs elimina datos del payload, reparación resuelta sin órdenes pendientes.

#### INC-UI

Depende: [G3](#g3). Paths: `apps/web/features/incidents/**`. Listado/ficha/wizard/evidencia/timeline/rechazo/cierre/NextStep; escritorio primero. Aceptación: transiciones y faltantes efectivos, borradores del servidor recuperables, terceros/evidencia/seguro; sin tareas internas del caso en MVP ni mock final.

#### INC-SLA

Depende: [G3](#g3). Paths: dominio/API `incidents/sla/**`, `apps/worker/incident-sla/**`. Objetivos por severidad, inactivity/escalation/notificación y preferencias obligatorias. Aceptación: 80/100% una vez, regla horas corridas explícita, reapertura métricas separadas, cambio severidad auditado, expiración actor bloquea export/correo sensible.

#### INC-INTEGRATE

Depende: [INC-CASES](#inc-cases), [INC-WORKFLOW](#inc-workflow), [INC-COSTS](#inc-costs), [INC-UI](#inc-ui), [INC-SLA](#inc-sla). Paths: composition/registry, `tests/integration/incidents/**`, `tests/e2e/incidents/**`. Aceptación: siniestro aceptado→repair→resolved→closed, rechazado→apelado/asumido, sin seguro, pérdida total y reapertura con regresión acumulativa.

#### G4

Depende: [INC-INTEGRATE](#inc-integrate). Auditar M0–M4, trazabilidad, seguro histórico, reparación/costos y control de caso completo. **Bloquea M5**. Informe `docs/audits/G4/`.

### M5 — MVP integrado; ocho paquetes inicialmente elegibles

#### MVP-ANALYTICS

Depende: [G4](#g4). Paths: dominio/API `analytics/**`, `apps/web/features/dashboard/**`. KPI por rol y drill-down/filtros con datos reales. Aceptación: fórmulas/fechas/denominadores explícitos, no fuga de costos/PII o conteos, estados vacíos útiles y p95 definido.

#### MVP-REPORTS

Depende: [G4](#g4). Paths: dominio/platform/API `reports/**`, `exports/**`, `apps/web/features/reports/**`. Todo catálogo BRD §13.1, CSV/XLSX/PDF e historial jobs. Aceptación: filtros/columnas/permisos, formula injection, jobs >5000 y descarga revocada, PDF paginado legible y costos reparación no dobles. Inventario por reporte individual, sin sustituir todos por una exportación genérica.

#### MVP-SEARCH

Depende: [G4](#g4). Paths: dominio/API `search/**`, `saved-views/**`, `apps/web/features/search/**`. Global search/filtros guardados/URL y columnas persistentes. Aceptación: A/B y permisos, índices y exact-only PII cifrada, rendimiento 1M datos, invalidación de vista ajena y enlaces al detalle correcto.

#### MVP-NOTIFY

Depende: [G4](#g4). Paths: dominio/platform/API `notifications/**`, `apps/web/features/notifications/**`. Centro/preferencias/subscriptions/email sink/plantillas; integrar eventos existentes. Aceptación: deduplicación/retry/silencio/canales obligatorios, contenido mínimo por rol y revocación; un fallo no revierte comando.

#### MVP-WEBHOOKS

Depende: [G4](#g4). Paths: dominio/platform/API `webhooks/**`, `apps/worker/webhooks/**`, `apps/web/settings/integrations/**`. Entregas HMAC, scopes payload, retries/DLQ/panel; sin API pública completa. Aceptación: firma bytes/replay/idempotencia, SSRF/DNS/redirect/metadata AWS, tenant aislado y cadencia de reintentos verificada.

#### MVP-AUDIT-UI

Depende: [G4](#g4). Paths: `apps/web/features/audit/**`, `apps/api/audit-query/**`, `packages/domain/audit-query/**`. Audit global/entity, timeline/diffs con permisos. Aceptación: PII/costos enmascarados en backend, filtros/export seguros, historial coherente y almacenamiento append-only reconciliado.

#### MVP-OPS

Depende: [G4](#g4). Paths: `infra/operations/**`, `docs/runbooks/**`, `tests/recovery/**`, `tests/performance/**`. Alertas/telemetría/costos/quotas/backups/PITR/restauración tenant y release/rollback. Aceptación: simulacro RPO/RTO, restaura tenant aislado desde backup de instancia, prueba de carga y plan de presupuesto/región; no publicar prod.

#### MVP-QA

Depende: [G4](#g4). Paths: `tests/acceptance/**`, `docs/traceability/final*`. Plan de aceptación acumulativa individual FR/BR/NFR/US, amenazas/axe/visual/mutation; correr sobre candidato final. Aceptación: identificar gaps aunque tickets estén cerrados; ejecución real y evidencias sintéticas; no dar pass con requisitos aplicables sin prueba.

La suite y matriz preparadas son el entregable paralelo; MVP-INTEGRATE ejecuta y entrega sus resultados sobre módulos completos. G5 verifica esos resultados independientemente y no los sustituye por la aprobación del plan de pruebas.

#### MVP-INTEGRATE

Depende: [MVP-ANALYTICS](#mvp-analytics), [MVP-REPORTS](#mvp-reports), [MVP-SEARCH](#mvp-search), [MVP-NOTIFY](#mvp-notify), [MVP-WEBHOOKS](#mvp-webhooks), [MVP-AUDIT-UI](#mvp-audit-ui), [MVP-OPS](#mvp-ops), [MVP-QA](#mvp-qa). Paths: composición final/registry, release manifest. Aceptación: todos los módulos conectados en staging, suites sin skips, traceability completa y artifacts/digest congelados para G5.

#### G5

Depende: [MVP-INTEGRATE](#mvp-integrate). Auditoría M0–M5 completa, centrada en propósito BRD/UX del artifact y calidad requerida. Disponibilidad/recuperación, security, performance y todos los journeys. Informe `docs/audits/G5/`. **Bloquea fase 1.5, cualquier etapa futura y declaración de MVP terminado** hasta passed. Solicitar al humano evaluación del producto final con demo/evidencia cuando corresponda; publicación prod requiere autorización independiente.

### 8.1 Carriles iniciales por etapa

| Etapa | Carril A | Carril B | Carril C | Trabajo adicional elegible |
|---|---|---|---|---|
| M0 | FND-REPO | FND-CONTRACTS | FND-DS | FND-AWS, FND-ORCH |
| M1 | CORE-AUTH | CORE-TENANCY | CORE-FILES | CORE-AUDIT |
| M2 | FLT-PEOPLE | FLT-VEHICLES | FLT-DOCS | SETTINGS, UI-PEOPLE, UI-FLEET, IMPORT |
| M3 | MNT-PLANS | MNT-ORDERS | MNT-UI | MNT-QA |
| M4 | INC-CASES | INC-WORKFLOW | INC-COSTS | INC-UI, INC-SLA |
| M5 | MVP-ANALYTICS | MVP-REPORTS | MVP-SEARCH | NOTIFY, WEBHOOKS, AUDIT-UI, OPS, QA |

Después de paquetes paralelos, integrador y auditores pueden reducir número de implementadores elegibles. Es una consecuencia explícita del DAG. No evitar barreras ni alterar Tasks para simular tres agentes trabajando.

## 9. Tasks.md y métricas honestas

Tasks.md solo muestra estado operativo: hito/gate activo, taskId, dependencies, ready/blocked reason, agent/provider/model/sessionRef opaca, branch/worktree/baseSHA, lease/heartbeat/fencing, PR/headSHA/CI/reviews, intentos, progreso y next action. Sin prompts completos, credenciales ni datos personales.

Progreso por evidencias: 0 planned, 10 ready, 20 leased, 40 implementación, 55 auditoría local, 65 PR/CI, 80 consenso externo, 90 candidato integrado, 100 accepted. Es indicador de estado, no porcentaje exacto de trabajo ni predicción de fecha. Gate solo 0 pending / 50 auditing / 100 passed; failed/waiting no avanzan por tiempo.

Escritura atómica mediante archivo temporal/rename y única autoridad. Prohibido editar Tasks en cada worktree. Cuando se cree worktree, comprobar que `/Tasks.md` sigue ignorado. Si aparece trackeado, retirar del índice sin borrar estado local y bloquear publicación hasta corregir.

Reportar al usuario únicamente cambios relevantes: resultado integrado, hallazgo material, gate pasado/fallido, bloqueo externo o decisión de producto. No pedir permiso por cada PR ni por tareas rutinarias ya autorizadas.

## 10. Aceptación de esta primera etapa

Esta entrega de planificación debe incluir SPECS.md y Orchestrator.md con baseline conservada, Tasks.md ignorado y sin agentes ficticios, AGENTS.md/CLAUDE.md equivalentes, fuentes consultadas y manifiesto de hashes. No supone que CI, runtime, AWS ni proveedores ya estén conectados. La implementación comienza únicamente al ejecutar paquetes M0; el primer gate comprueba que estas políticas se volvieron mecanismos efectivos.
