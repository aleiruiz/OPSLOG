# ADR-0007 — Pines de modelo Claude: Sonnet 5.5 para código y Opus 5.5 para revisión

Estado: adoptado por instrucción directa del usuario el 2026-10-05.
Fecha: 2026-10-05, America/Mexico_City.

## Decisión

Cuando Claude/Anthropic es el proveedor activo, el trabajo se divide por rol y por modelo, por razones económicas:

- **Código** (autores, integradores, reparación de entorno, documentación de implementación): `claude-sonnet-5-5` explícito.
- **Investigación y revisión** (investigaciones, análisis de gates y la revisión de código de cada PR): `claude-opus-5-5` explícito.
- Cada PR recibe, antes de fusionarse, una revisión de código realizada por un agente `claude-opus-5-5` externo al autor. Esa revisión **es** la única auditoría independiente por PR/headSHA de ADR-0005 y SPEC/ORCH-1.3; no se agrega una segunda auditoría ni una review formal de GitHub. La instrucción del usuario autoriza únicamente que esa auditoría única use Opus 5.5.
- Un cambio de código crea un SHA nuevo y exige una revisión Opus 5.5 nueva sobre ese SHA. La revisión de un SHA anterior no autoriza el candidato nuevo.

Se fija y registra el modelo solicitado y el observado; si no puede seleccionarse o comprobarse, la asignación queda bloqueada, sin fallback. Esta adopción supersede únicamente la selección del modelo Claude (`claude-sonnet-5`) de ADR-0004/0005/0006 y SPEC/ORCH-1.3. No modifica: proveedor único activo, trabajo paralelo dentro del proveedor, independencia autor/auditor, exactamente una auditoría por PR/headSHA, CI requerido, gates acumulativos, PRs listos (no draft), reglas de transferencia, producción sin autorización ni AWS diferido. El pin de Codex (`gpt-6-luna`) no cambia.

Las sucesoras acotadas [SPEC-1.4](../baselines/1.4/SPECS.md) y [ORCH-1.4](../baselines/1.4/Orchestrator.md) heredan todo lo no sustituido. Los documentos congelados y la evidencia histórica quedan intactos: la evidencia previa conserva su SHA y el modelo realmente observado y no se reetiqueta.

## Consecuencia y verificación

El runtime de orquestación fija `claude-sonnet-5-5` como pin de autoría Claude y exige `claude-opus-5-5` como modelo observado de la auditoría de un candidato Claude; rechaza `claude-sonnet-5`, auditorías de Sonnet y auditorías del proveedor inactivo. Esta decisión no declara ejecución de pruebas, revisión ni gates aprobados.
