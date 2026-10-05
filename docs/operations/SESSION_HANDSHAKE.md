# Protocolo de enlace de sesiones del orquestador

Este documento concreta la coordinación de sesiones sin modificar las baselines congeladas.

## Estados de identidad

- `clientThreadId`: identificador provisional devuelto mientras se prepara una sesión. No es direccionable y no debe enviarse a herramientas de mensajería.
- `threadId`: UUID real devuelto por la plataforma cuando la sesión está materializada. Es la única identidad válida para comunicación.
- `sessionStatus`: `provisioning`, `anchored`, `unresolved-provisional-id`, `blocked` o `completed`.

La creación de un worktree no prueba por sí sola que exista una sesión comunicable. El estado debe conservar por separado el worktree, la rama, el SHA base y la identidad de conversación.

Cada enlace usa un `handshakeId` único y conserva `parentThreadId`, `childThreadId`, `taskId`, `leaseId`, `epoch`, `baseSHA` y `pathScope`. El `leaseId` y el `epoch` deben proceder del lease vigente; no se inventan ni se infieren desde un nombre de rama.

## Handshake obligatorio

1. Crear la hija con `create_thread` sobre el mismo proyecto, fijar el pin activo de Codex `gpt-6-luna` (o, si Claude es el proveedor activo, `claude-sonnet-5-5` para código y `claude-opus-5-5` para investigación/revisión) y pasarle el `threadId` real del padre en el prompt. `fork_thread` queda reservado para recuperación explícita del canal, no para el flujo normal.
2. Registrar la intención de creación con `taskId`, proveedor, modelo, paths, baseSHA y el identificador recibido. Si solo hay `clientThreadId`, conservarlo únicamente para correlación.
3. Nunca enviar mensajes al identificador provisional. Para un `create_thread` asíncrono, reconciliar una sola vez `list_threads` usando título, proyecto, worktree y rama; nunca por coincidencia parcial de un identificador provisional.
4. Aceptar la sesión solo cuando exista un `threadId` real y el `cwd`/worktree correspondan al lease registrado.
5. Guardar el `threadId` real, host, worktree, rama y estado `anchored` de forma atómica.
6. Si la sesión alcanza un bloqueo, publicar un evento compacto con esta forma:

```yaml
event: session.blocked
taskId: CORE-EXAMPLE
threadId: <UUID real o null si aún no fue resuelto>
clientThreadId: <solo para correlación, nunca para mensajería>
worktree: C:\\path\\to\\worktree
branch: codex/example
headSha: <SHA>
blocker:
  kind: provisioning|tooling|dependency|ci|contract|user-input
  summary: <bloqueo concreto>
  evidence: <comando, runId o ruta verificable>
  unblockCondition: <condición precisa>
nextAction: repair|resume|await-external-change|request-user-decision
```

7. El orquestador valida el evento contra ownership, lease, SHA y paths antes de actuar.
8. Si solo existe `clientThreadId`, el estado es `unresolved-provisional-id`: no se envían mensajes, no se declara avance y no se crea una sesión duplicada.
9. Una única sesión de reparación puede tomar el mismo alcance cuando la sesión autora no sea direccionable; la reparación debe conservar el SHA de origen y generar una nueva evidencia auditable.

## Autorización explícita antes del trabajo real

`HANDSHAKE_READY` es una declaración de preparación, no autorización. El padre vigente debe validar, para el mismo `handshakeId`, la identidad real de ambos threads, host, modelo fijado, lease, epoch, baseSHA, worktree, rama y `pathScope`, y responder `HANDSHAKE_ACK` con todos esos campos y `startAuthorized: true`. Hasta entonces la hija permanece `await-parent-ack` y solo puede hacer lectura de preparación.

Es trabajo real cualquier escritura, instalación, prueba, commit, publicación de PR o auditoría. Ninguno puede comenzar por timeout, identidad `anchored`, creación del worktree, mensaje inicial o ausencia de respuesta. Un READY/ACK incompleto, stale, duplicado fuera de secuencia o con campos incompatibles bloquea. Solo el padre vigente puede autorizar; repetir un ACK válido para el mismo handshake es idempotente.

Un cambio de ownership, lease, epoch, base por reasignación, `pathScope` o reprovisionamiento requiere un nuevo `handshakeId` y READY/ACK. Los commits normales posteriores a un ACK válido no requieren nuevo handshake mientras permanezcan esos campos.

Ejemplo mínimo de autorización:

```yaml
event: session.handshake_ack
handshakeId: <unique-id>
parentThreadId: <real-parent-uuid>
childThreadId: <real-child-uuid>
taskId: <task-id>
leaseId: <current-lease>
epoch: <current-epoch>
model: gpt-6-luna|claude-sonnet-5-5|claude-opus-5-5
hostId: <host>
worktree: <absolute-worktree>
branch: <assigned-branch>
baseSHA: <assigned-base-sha>
pathScope: [<exclusive-path>]
startAuthorized: true
```

## Sesión hija con contexto del proyecto y sin historial heredado

Cuando la hija necesite el contexto del proyecto pero no el historial completo del orquestador, usar `create_thread` apuntando al mismo proyecto y pasar el `threadId` real del padre en el prompt inicial. La hija debe:

1. leer las instrucciones, baselines y paquete de tarea del proyecto;
2. esperar a estar materializada con un `threadId` real;
3. enviar al padre un `HANDSHAKE_READY` compacto con `handshakeId`, `childThreadId`, `taskId`, `hostId`, modelo, lease, epoch, cwd/worktree, rama, SHA base, `pathScope` y estado de preparación;
4. no empezar trabajo, bifurcarse ni crear otra sesión hasta recibir el `HANDSHAKE_ACK` correlacionado con `startAuthorized: true`.

Formato mínimo del prompt de arranque:

```text
Parent threadId: <UUID real>
TaskId: <ID>
Project: <projectId>
Lease: <worktree, branch, baseSHA, paths>
Handshake: <handshakeId, leaseId, epoch>
Reply to the parent with your real child threadId, hostId, cwd/worktree and readiness status.
Do not fork, create another session, or start real work until the parent sends HANDSHAKE_ACK with startAuthorized: true.
```

Si `create_thread` solo devuelve `clientThreadId`, se conserva únicamente para correlación y la sesión permanece `unresolved-provisional-id`. El `threadId` del padre sirve como dirección de retorno, pero no sustituye la validación del UUID real de la hija.

## Criterios de prueba

- Un `clientThreadId` rechazado por mensajería no se usa como `threadId`.
- Un worktree sin UUID real permanece no comunicable.
- Un bloqueo incluye evidencia y condición de desbloqueo.
- La reconciliación es idempotente: repetirla no crea otra sesión ni otra auditoría.
- Autor, reparación y auditoría mantienen sesiones distintas; cada PR conserva una única auditoría independiente por SHA.
- Una sesión creada con contexto del proyecto debe devolver al padre su UUID real, host, cwd/worktree, lease y estado de preparación antes de recibir trabajo.
- `fork_thread(same-directory)` solo se acepta como prueba o recuperación cuando `create_thread` no materializa un UUID; no se encadenan bifurcaciones.
