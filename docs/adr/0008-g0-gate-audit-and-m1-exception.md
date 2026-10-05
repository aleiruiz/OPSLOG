# ADR-0008 — Auditoría de gate G0 con dos revisores Opus 5.5 y excepción registrada de M1

Estado: adoptado por instrucción directa del usuario el 2026-10-05.
Fecha: 2026-10-05, America/Mexico_City.

## Contexto

La revisión independiente de G0 sobre `main@776abce` (sus conclusiones se recogen en el informe vigente en `docs/audits/G0/8b1b61c187c153c2c24e4cf3d714f8ae7f41051e/`) encontró dos hechos de proceso:

1. ORCH-1.1 §2 y SPEC-1.3 conservan **dos auditores independientes por hito**; la regla de una sola auditoría de ADR-0005 y ADR-0007 aplica por PR/headSHA, no por gate.
2. Los paquetes M1 de audit/outbox (#15), tenancy (#16) y auth (#17) y la corrección posterior (#20) se fusionaron antes de que G0 estuviera aprobado, aunque AGENTS.md, SPECS.md (gates G0–G5) y Orchestrator.md bloquean etapas posteriores mientras un gate esté pendiente.

## Decisiones

- **Segundo auditor de G0.** El usuario autorizó expresamente que G0 sea evaluado por dos auditores independientes `claude-opus-5-5`, con contexto limpio y distintos del autor. La autorización cubre solo auditorías de hito G0 (la exigencia de dos auditores por gate proviene de ORCH-1.1 §2 y SPEC-1.3, no de esta autorización); no cambia la regla de exactamente una auditoría por PR/headSHA.
- **Excepción de M1 (ratificación posterior).** La fusión de #15, #16, #17 y #20 ocurrió antes de esta decisión y de G0; el usuario la ratificó después del hecho el 2026-10-05, tras la primera revisión de G0. Las fusiones las ejecutó la misma sesión autora de las PR tras CI verde y revisión Opus, sin revisión formal de GitHub. Queda registrada como excepción aprobada por él. No convierte a G0 en aprobado: el código M1 fusionado queda dentro del alcance acumulativo del candidato G0 (CI, regresión y auditoría).
- **Gates posteriores.** G1 y los demás gates conservan dos auditores independientes por hito; esta autorización no los exime ni se extiende a PR individuales.
- **Decisión de aprobación.** La sesión que redactó las PR de cierre de G0 (#21 y #22) no declara G0 aprobado; la decisión final corresponde al usuario o a los auditores independientes.
- **Diferimiento de FND-ORCH a G1.** El 2026-10-05 el usuario aceptó explícitamente diferir a G1 (como máximo a su cierre) los componentes no construidos de FND-ORCH: reconstrucción desde fake de GitHub, store persistente y proyección de Tasks, `simulate`/simulación de dispatch, fake de git/worktree y los e2e de bootstrap, recuperación, gate que bloquea M1 e invalidación por SHA. La lista vigente está en `docs/tasks/FND-ORCH.md`.
- **Bloqueos externos explícitos.** (a) `main` no tiene branch protection ni rulesets: solo el usuario o un administrador de GitHub pueden configurarlos (checks `quality` requerido, sin pushes directos). (b) AWS está diferido (ADR-0002) y su viabilidad queda pendiente. Ninguno lo resuelve ni lo declara resuelto este repositorio.
- **Diferimientos de diseño.** Storybook como runtime y snapshots de píxeles quedan diferidos a antes de la primera pantalla funcional y, como máximo, a G1; las stories se renderizan y escanean con axe mediante el renderizador CSF mínimo de `e2e/browser-app/stories.tsx`.
- No se modifican las baselines congeladas ni sus manifests. Esta decisión no autoriza dispatch de nuevas tareas M1 posteriores a las ya fusionadas, ni AWS ni producción.

## Verificación

El informe G0 vigente nombra el SHA candidato, los modelos observados de ambos auditores y el resultado de cada criterio; G0 solo se considera aprobado si ambos auditores aprueban sobre ese SHA y `quality` está verde.
