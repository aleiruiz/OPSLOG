# ADR-0004 — Luna 5.6 para Codex y Sonnet 5 para Claude

Estado: vigente; aclaración directa del usuario, supersede ADR-0003.
Fecha: 2026-10-03, America/Mexico_City.
Compatible con SPEC-1.0 / ORCH-1.0, cuyos archivos se conservan sin cambios.

## Política obligatoria

| Proveedor / entorno | Modelo solicitado | Identificador explícito |
|---|---|---|
| OpenAI / Codex | GPT-5.6 Luna | `gpt-5.6-luna` |
| Anthropic / Claude | Claude Sonnet 5 | `claude-sonnet-5` |

Aplica a orquestador, implementadores, integradores, subagentes y auditores. El orquestador inicial de la sesión Codex usa Luna. Un agente Claude y sus subagentes usan Sonnet 5. No cambiar automáticamente a modelos más nuevos, más costosos o de otro proveedor; no usar alias `sonnet` que pueda apuntar a otra versión.

Configurar el modelo en la herramienta/CLI/adaptador real y registrar modelo solicitado y observado. Si no se puede seleccionar o comprobar el modelo requerido, registrar bloqueo; no decir que se lanzó solo por mencionarlo en el prompt.

## Auditoría

Se conserva el protocolo original: subauditoría local independiente y luego auditor externo OpenAI Luna más auditor externo Anthropic Sonnet 5 sobre el mismo SHA. Los agentes tienen sesiones/contextos separados del autor; calidad, CI y gates siguen obligatorios. Proveedor inaccesible deja pendiente su revisión, no se sustituye por otro proveedor.

La independencia se obtiene mediante sesiones, roles y contexto limpio; no exige autorizar otro modelo del mismo proveedor. Esta selección explícita prevalece sobre la preferencia de cambiar modelo para auditar en ORCH-1.0.

## Contexto para modelos económicos

Guía obligatoria: docs/operations/ORCHESTRATOR_START.md. Materializar paquete autocontenido antes de despachar: objetivo, requisitos individuales, paths, contratos, ejemplos, dependencias, comandos de prueba, criterios de aceptación y bloqueos. No bajar estándares para ahorrar capacidad.

## Disponibilidad observada y referencia

Las herramientas de sesión de este host admiten `gpt-5.6-luna`. Durante esta preparación no se encontró CLI `claude` en PATH ni un conector de agentes Anthropic entre las herramientas expuestas; esto no prueba que no exista otro mecanismo instalado/autorizado. El orquestador debe verificar un adaptador real sin inspeccionar secretos ni instalar/provisionar integraciones por suposición. Preparar evidencia local mientras obtiene acceso compatible.

Identificador Sonnet 5 verificado en [documentación oficial de Anthropic](https://platform.claude.com/docs/en/models/sonnet-5/overview), consultada el 2026-10-03. No se usa Sonnet 5.5.
