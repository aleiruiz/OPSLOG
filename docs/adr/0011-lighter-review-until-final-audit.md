# ADR-0011 — Revisión más ligera hasta una auditoría completa final

Estado: **Decisión del propietario transcrita por la sesión autora.** Este repositorio no puede verificar esa decisión (la misma limitación que ADR-0008 y ADR-0009, que también recogen decisiones tomadas fuera del repositorio): el registro es una transcripción, no una firma del propietario ni una aprobación de los auditores.
Fecha de la decisión: 2026-10-06 10:38 UTC, en el hilo del proyecto.
Decisor: Alei Ruiz (propietario).

## Contexto

Las revisiones de G1 tardaron aproximadamente 24 horas para un cambio pequeño. El propietario decidió bajar la profundidad de revisión de aquí en adelante y concentrar una única revisión pesada, completa, al FINAL del proyecto, cuando todo funcione.

## Decisión

Hasta la auditoría final:

1. **Gates G2 en adelante:** un solo auditor independiente `claude-opus-5-5` sobre el SHA del gate, en lugar de dos. El informe se publica en `docs/audits/<gate>/` como hasta ahora. La aceptación del propietario sigue siendo requerida. Los hallazgos Medium de seguridad siguen bloqueando; los demás Medium se registran y el propietario puede diferirlos.
2. **PRs:** una revisión de código Opus acotada al diff. Una ronda de corrección la verifica el driver contra los hallazgos y con CI en verde, sin segunda pasada de Opus, salvo que la corrección sea un cambio grande de lógica.
3. **Pruebas y mutación:** los revisores repiten las pruebas nuevas unas 3 veces y hacen comprobaciones de mutación dirigidas solo en cambios críticos de seguridad, no barridos exhaustivos.
4. **PRs solo de documentación** (ADR, docs, LICENSE): no requieren revisión Opus; se fusionan con CI en verde.
5. **Auditoría final de fin de proyecto:** de profundidad completa (dos auditores, repeticiones y barridos de mutación) y cubre todo de forma acumulativa.

## Qué reglas supera

Supera únicamente las partes incompatibles de las reglas de revisión vigentes:

- `AGENTS.md`, reglas 7 y 8 (revisión por PR y revalidación tras cambio de código): la corrección verificada por el driver y la fusión de PRs solo de documentación sin revisión Opus son excepciones nuevas.
- `AGENTS.md`, regla 9 («auditoría de hito»): el hito G2+ usa un auditor en lugar de dos hasta la auditoría final.
- ORCH-1.1 §2 (`docs/baselines/1.1/Orchestrator.md`: «Auditor independiente A y B», consenso A/B y «los dos auditores de hito» de §7/G0–G5) y el `Orchestrator.md` original, §7 (pasos de gate: «dos auditores independientes», «dos auditores conformes»): se reduce a uno para G2+ hasta la auditoría final, que los restituye.
- SPEC-1.1 (`docs/baselines/1.1/SPECS.md`): «los hitos conservan dos auditores independientes».
- `docs/operations/AUTONOMOUS_ORCHESTRATOR.md` no cambia: no se agregan auditorías locales ni dobles de PR.

ADR-0007 sigue siendo consistente: «exactamente una auditoría independiente por PR/headSHA» no cambia; esta decisión solo reduce la profundidad de esa revisión y el número de auditores de gate.

## Lo que esta decisión no cambia

- El leak scan (`pnpm leak:scan`), el baseline check (`pnpm baseline:check`) y el CI de calidad requerido.
- El ruleset del repositorio.
- `docs/baselines` y los documentos protegidos, que no se tocan (la evidencia histórica no se reescribe).
- G0 y G1: conservan sus dos auditores y la aceptación del propietario (ADR-0008).
- Proveedor único activo, pines de modelo (ADR-0006/0007), independencia autor/auditor, PRs listos (no draft), AWS diferido (ADR-0002) y producción sin autorización.

## Consecuencias y verificación

- Si el propietario retira o corrige la decisión, un ADR posterior debe sustituir este; el repositorio no puede comprobar el hilo del proyecto.
- Los informes de gate deben citar este ADR como decisión del propietario transcrita y no verificable desde el repositorio.
- Esta decisión no declara ningún gate pasado.
