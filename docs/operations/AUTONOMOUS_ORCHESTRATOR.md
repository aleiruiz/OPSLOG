# Operación autónoma por sesiones

Guía vigente para ORCH-RESTART; sustituye el arranque antiguo en organización de sesiones, autoridad y pulse. Las instrucciones de 1.2 y AGENTS prevalecen sobre menciones antiguas de auditorías locales/dobles, drafts o subagentes internos.

El usuario autorizó crear y coordinar sesiones distintas para todas las tareas. Usar create_thread con proyecto OPSLOG, entorno local o worktree aislado según lease y model gpt-5.6-luna, thinking medium. list_projects resuelve el projectId; no inventarlo. El nombre incluye taskId/rol. No dar al worker autorización de editar root compartido: si chat local, cada comando usa el worktree absoluto asignado. Sesiones de auditoría separadas de autores. Notificar/continuar estas sesiones está dentro del encargo del usuario.

Para continuar PR existente asignar worktree/rama existente solo después de liberar propietario anterior. Para tarea nueva crear worktree propio desde commit aceptado y registrar lease antes de lanzamiento. No pasar startingState branch inventado a create_thread; usar operaciones Git/worktree explícitas con la ref verificada. Reconciliar operaciones de creación pendientes antes de duplicar un worker.

## Handshake antes de trabajo real

Toda sesión hija debe leer `docs/operations/SESSION_HANDSHAKE.md` y enviar `HANDSHAKE_READY` con `handshakeId`, `parentThreadId`, `childThreadId` real, `taskId`, `leaseId`, `epoch`, modelo, host, worktree, rama, `baseSHA` y `pathScope`. El padre valida esos campos contra el lease vigente y responde `HANDSHAKE_ACK` para el mismo `handshakeId`. Solo un ACK explícito con `startAuthorized: true` habilita escrituras, instalaciones, pruebas, commits, PRs o auditoría.

Un READY incompleto, stale, duplicado fuera de secuencia o con identidad, modelo, lease, epoch, baseSHA o paths incorrectos queda bloqueado. La identidad `anchored`, la creación del worktree, el mensaje inicial y el transcurso del tiempo no autorizan trabajo. El ACK debe provenir del padre vigente; repetir el mismo ACK válido es idempotente. Un cambio de ownership, lease, epoch, alcance o reprovisionamiento exige un nuevo handshake; commits normales posteriores al ACK no lo exigen.

Los problemas de herramientas/permisos locales se investigan con acciones concretas: localizar runtime disponible, comprobar PATH para esa sesión, ejecutar instalaciones del proyecto y pedir escalación de sandbox con justificación cuando la herramienta lo requiera. Esto no equivale a pedir permiso rutinario al humano. Si la revisión automática rechaza una acción y no hay alternativa autorizada, informar acción y razón concreta; no fingir reparación. Prohibido desactivar tests, aislamiento o quality gates para conseguir verde.

## Gate de navegador para trabajo posterior

Desde `FND-BROWSER-E2E`, todo proyecto o paquete posterior que introduzca o modifique interfaz debe incluir y ejecutar sus pruebas Playwright de navegador como parte del approval gate. El resultado debe corresponder al mismo SHA candidato y conservar browser, comando, resultado y artefacto o reporte. Si el runner, navegador, prueba aplicable o evidencia no está disponible, el candidato queda bloqueado; no se sustituye por una prueba jsdom ni por una declaración manual.

Pulse: heartbeat nativo ligado a nueva threadId, cada diez minutos, modelo de la sesión Luna. wait_threads con timeoutMs=0 y cursores para snapshot breve; consultar GitHub por ids/status/headSHA. Nunca usar esperas largas ni descargar todos los logs por rutina. Estado sin novedades implica terminar sin respuesta de progreso ni mensajes al usuario. Si el entorno no permite silencio total, usar la respuesta mínima interna que soporte sin notificación proactiva. La configuración nativa puede marcar notificationPolicy=failed_runs_only para evitar avisos de cada ejecución exitosa; decisiones que necesitan al humano se comunican en la sesión.

La recuperación inicia desde handoff, GitHub y state store; Tasks no es fuente autoritativa. Mientras haya sesiones trabajando, el coordinador puede cerrar turno: el heartbeat mantiene coordinación. Registrar bloqueo de cuota/capacidad real, conservar contexto y esperar reset en vez de sustituir el modelo. Separar sesiones reduce crecimiento del contexto; los límites de la cuenta siguen compartidos.

No publicar tokens, contenido .env, datos reales, dumps o logs sensibles. Solo MySQL local/efímero sintético para integración. Terminar o pausar pulse cuando se complete todo el alcance autorizado, no dejar ciclos vacíos indefinidos. Mantener gates acumulativos y revisión humana concreta del producto cuando corresponda.
