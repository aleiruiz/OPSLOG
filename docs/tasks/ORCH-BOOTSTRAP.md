# ORCH-BOOTSTRAP — Activar sesión de orquestación M0

Tipo: bootstrap de coordinación, previo al runtime FND-ORCH.
Autorización: petición directa del usuario de iniciar otra sesión con Luna 5.6 para Codex y Sonnet 5 para Claude.
Baseline: SPEC-1.0 / ORCH-1.0; modelos obligatorios `gpt-5.6-luna` (Codex) / `claude-sonnet-5` (Claude), según ADR-0004.
Dependencias: planificación presente, hashes válidos y sesión dedicada configurada con ese modelo.
Propósito: convertir el plan M0 en paquetes asignables y despachar trabajo asíncrono aislado sin perder contexto/calidad.

## Lecturas

AGENTS.md, CLAUDE.md, SPECS.md, Orchestrator.md, docs/operations/ORCHESTRATOR_START.md, ADR-0001/0002/0004, infra/plan/AWS.md y fuentes de producto. ADR-0003 está supersedido. No leer .env.

## Alcance y permisos

Único escritor de Tasks.md y `.orchestrator/`. Puede materializar paquetes, registrar leases, preparar commit documental inicial, crear ramas/worktrees y coordinar subagentes/PRs de M0. Escrituras de preparación: docs/tasks, docs/operations y estado local. Código de aplicación y del runtime se asigna a implementadores, no se implementa silenciosamente como orquestador.

Prohibido: editar SPECS/Orchestrator/fuentes congeladas; leer/publicar secretos; configurar/conectar AWS; usar producción; lanzar modelos distintos de los fijados por proveedor; force-push; autoaprobar; avanzar M1 sin G0.

## Entregables y aceptación

1. Hashes válidos y estado Git/local/remoto conocido; evidencia por nombres y SHAs, sin secretos.
2. Commit base seguro disponible para worktrees o limitación de Git concreta registrada.
3. Paquetes FND materializados con requisitos individuales, contratos, acceptance, tests/commands y paths sin solapamiento antes de despacharlos.
4. Tres carriles M0 despachados con modelo explícito, worktree/branch/baseSHA/lease; si slots/acceso impiden algo, estado honesto y trabajo independiente preparado.
5. Auditorías locales con el modelo autorizado por proveedor planificadas sin recursión ni capacidad ficticia; revisión externa Luna/Sonnet 5 con disponibilidad real documentada.
6. Tasks.md actualizado localmente, ignorado y sin credenciales; evento de handoff y estado recuperable.
7. No gates pasados ni AWS configurado como consecuencia de este bootstrap.

## Comprobaciones mínimas

- Verificar hashes con SHA-256 contra docs/baselines/BASELINE-1.0.json.
- Comprobar `.env`, Tasks.md y `.orchestrator/` ignorados; revisar nombres staged antes de commit.
- Comprobar commit/base de cada worktree y modelo solicitado/confirmado en respuesta de herramienta.
- Validar enlaces/dependencias de cada paquete y tres leases distintos sin path de escritura compartido.
- Reconciliar resultados al reiniciar o recibir mensajes; no confundir resúmenes de agentes con checks.

Rollback: detener nuevas asignaciones, conservar commits/worktrees y evidencias, liberar leases confirmados; no borrar trabajo ni recursos. Resultado esperado en sesión: registro de bootstrap, tareas/agentes reales o bloqueos concretos y acción siguiente.
