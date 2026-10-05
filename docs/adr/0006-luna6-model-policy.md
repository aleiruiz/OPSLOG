# ADR-0006 — Pin de modelo Luna 6 para Codex

Estado: adoptado por instrucción directa del usuario el 2026-10-04.
Fecha: 2026-10-04, America/Mexico_City.

## Decisión

Codex/OpenAI usa explícitamente `gpt-6-luna` para el coordinador, autores, integradores, trabajadores, subagentes y auditores. Claude/Anthropic conserva `claude-sonnet-5`. Se fija y registra el modelo solicitado y el modelo observado; si no puede seleccionarse o comprobarse el modelo exigido, la asignación queda bloqueada. No hay fallback automático.

Esta adopción supersede únicamente la selección del modelo Codex en ADR-0003, ADR-0004 y ADR-0005 y en SPEC/ORCH-1.2. No reabre sus decisiones históricas ni modifica: proveedor único activo por repositorio, trabajo paralelo dentro del proveedor activo, independencia autor/auditor, exactamente una auditoría por PR/headSHA, gates acumulativos, publicación de PR ready, reglas de transferencia de ownership, prohibición de desplegar a producción sin autorización, ni aplazamiento de AWS.

Las sucesoras acotadas [SPEC-1.3](../baselines/1.3/SPECS.md) y [ORCH-1.3](../baselines/1.3/Orchestrator.md) cambian solamente el pin de Codex a `gpt-6-luna`; todo requisito no sustituido se hereda. Los documentos congelados y auditorías históricas permanecen intactos. La evidencia existente conserva su SHA y el modelo realmente observado; nunca se reetiqueta como Luna 6. Las nuevas asignaciones y revalidaciones usan el pin activo.

## Migración de sesiones vigentes

Antes de reasignar trabajo en una sesión existente, el coordinador confirma el modelo observado y los leases del propietario actual, drena agentes y leases, transfiere ownership con epoch nuevo y completa READY/ACK correlacionados con `startAuthorized: true`. Los candidatos ya auditados conservan la auditoría de su SHA; cualquier cambio de código produce un SHA nuevo y requiere la única auditoría independiente correspondiente a ese SHA bajo el proveedor activo. No se repiten automáticamente snapshots, PRs, pruebas o asignaciones históricas por el cambio de pin.

## Consecuencia y verificación

El runtime de orquestación acepta `gpt-6-luna` como pin Codex y rechaza `gpt-5.6-luna`, modelos observados distintos y auditorías del proveedor inactivo. Esta decisión no declara ejecución de pruebas, publicación, auditoría ni gates aprobados.
