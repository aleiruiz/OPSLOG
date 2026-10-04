# ADR-0003 — Política de ejecución exclusiva con GPT-5.6 Luna

Estado: supersedido por ADR-0004 tras aclaración directa del usuario: Luna para Codex y Sonnet 5 para Claude. Se conserva como historia; no aplicar la prohibición Anthropic ni la exclusividad global descritas abajo.
Fecha: 2026-10-03, America/Mexico_City.

## Decisión y alcance

El usuario solicita iniciar un orquestador en otra sesión y exige que todos los agentes que realicen actividades usen Luna 5.6. El identificador disponible en las herramientas de este host es `gpt-5.6-luna`.

- Orquestador, implementadores, integrador, subagentes y auditores ejecutables deben usar explícitamente `gpt-5.6-luna`.
- No sustituir el modelo por uno más potente ni cambiar proveedor/modelo ante límites o fallos. Registrar indisponibilidad y continuar solo trabajo independiente autorizado.
- El modelo debe configurarse en la herramienta de creación, no solamente mencionarse en un prompt. Registrar modelo solicitado y modelo observado cuando la herramienta lo reporte; no afirmar verificación si solo se conoce configuración solicitada.
- Subagentes: usar override explícito de modelo y contexto nuevo (`fork_turns=none` o contexto limitado), con paquete autocontenido. No usar un fork completo que impida aplicar override de modelo.
- Auditores mantienen sesiones independientes, contexto limpio y evidencia por SHA. Compartir modelo no los convierte en el autor ni habilita autoaprobación.

## Relación con las baselines

SPEC-1.0 y ORCH-1.0 se conservan sin editar. Esta instrucción posterior prevalece sobre preferir otro modelo para auditar. La auditoría externa de Anthropic exigida por las baselines no puede ejecutarse con un modelo OpenAI Luna; no cambiarle el nombre a un auditor Luna ni declarar consenso entre proveedores.

Por ahora no invocar ningún modelo Anthropic ni considerar un segundo auditor Luna sustituto de ese requisito. Registrar la auditoría externa incompatible como pendiente. Si impide cerrar un gate o fusionar un PR, presentar al usuario el candidato/evidencia y la decisión concreta necesaria para adoptar una política sucesora; no detener preparación local que no dependa de esa aprobación.

Esta decisión limita la ejecución; no reduce cobertura, seguridad, independencia, calidad ni las auditorías acumulativas por hito. No se modifica la baseline para resolver el conflicto implícitamente.

## Contexto previo a delegación

La guía [ORCHESTRATOR_START.md](../operations/ORCHESTRATOR_START.md) y el paquete [ORCH-BOOTSTRAP](../tasks/ORCH-BOOTSTRAP.md) dan pasos concretos, criterios de evidencia y límites. El orquestador debe completar un paquete autocontenido antes de asignar cada FND; no enviar únicamente un ID y confiar en inferencias del modelo.
