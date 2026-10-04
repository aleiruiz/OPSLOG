# ADR-0002 — Diferir configuración AWS y documentar su preparación

Estado: decisión directa del usuario, vigente.
Fecha: 2026-10-03. Compatible con SPEC-1.0 / ORCH-1.0.

## Decisión

La configuración AWS puede esperar. Conservar su plan y dependencias documentados en [infra/plan/AWS.md](../../infra/plan/AWS.md); preparar localmente contratos, adaptadores y pruebas sintéticas sin conectar, configurar ni provisionar recursos cloud hasta que se reactive ese trabajo.

## Consecuencias

- Documentación FND-AWS continúa en el plan; configuración y verificaciones remotas quedan diferidas.
- El .env local permanece ignorado, sin probar credenciales ni usar producción.
- Evidencia local no se presenta como prueba de IAM/RDS/servicios reales.
- Los gates acumulativos y criterios de seguridad siguen vigentes. Requisitos externos de un gate pueden quedar pendientes; no se omiten ni se sustituyen tácitamente.
- SPECS.md, Orchestrator.md y sus hashes originales se conservan.
