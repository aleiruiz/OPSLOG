# MNT-INTEGRATE — integración real de mantenimiento para G3

```yaml
id: MNT-INTEGRATE-M3-20261012
baseline: [SPEC-1.3, ORCH-1.3, inherited: SPEC-1.0/ORCH-1.0, SPEC-1.1/ORCH-1.1, SPEC-1.2/ORCH-1.2]
active_provider: anthropic (transferred by direct owner instruction on 2026-10-12)
model: claude-opus-5-5 (direct owner instruction "usa opus por ahora")
milestone: M3
kind: integration
base_sha: 0466f050984b8a40e44fa322cfc6b7e777302791
accepted_dependencies:
  [
    MNT-PLANS-M3-20261011 (PR #83),
    MNT-ORDERS-M3-20261011 (PR #84),
    MNT-UI-M3-20261011 (PR #85),
    MNT-QA-M3-20261011 backend stage (PR #86),
  ]
write_paths:
  [
    apps/web/app/**,
    apps/web/api/**,
    apps/web/features/maintenance/**,
    apps/api/composition/**,
    apps/worker/composition/**,
    e2e/**,
    tests/e2e/maintenance/**,
    tests/fixtures/maintenance/**,
    docs/traceability/maintenance*,
    package.json,
    tsconfig*.json,
    docs/tasks/MNT-INTEGRATE-M3-20261012.md,
  ]
forbidden_paths:
  [SPECS.md, Orchestrator.md, docs/baselines/**, Tasks.md, .env*, infra/aws/**, production]
```

## Objetivo y límites

Componer en el producto las cuatro entregas aceptadas de M3 y producir la evidencia acumulativa que G3 exige: mantenimiento preventivo y correctivo de principio a fin, por API real sobre MySQL 8.4 sintético y por navegador, sin regresión de flota. Orchestrator.md asigna a este paquete la composición/registro y `docs/traceability/maintenance*`, y exige QA final.

No se crean reglas de negocio nuevas. Si una brecha de contrato bloquea un escenario, se documenta como pendiente con su condición de desbloqueo; no se inventa comportamiento. Este paquete no declara G3 aprobado ni inicia M4.

## Alcance

1. **Shell web.** Montar `MaintenanceArea` en el shell autenticado: entrada de navegación «Mantenimiento» visible con permiso `view`, puertos sobre el cliente tipado (`createMaintenancePorts`), permisos y usuario de la sesión, y manejo común de 401. La lista de miembros para vincular mecánicos internos sale del directorio de usuarios existente cuando la sesión puede leerlo.
2. **API simulada del shell.** Extender la API simulada del arnés web con las rutas de mantenimiento aceptadas (mismas formas y errores que el contrato, saneo de costos sin `view_costs` y alcance del mecánico). Así los recorridos del shell corren en el Playwright actual, igual que los demás módulos.
3. **Journey de navegador sobre API real.** Agregar un arnés que levante el BFF compuesto contra una base MySQL 8.4 sintética desechable y sirva el shell web real. El recorrido exigido por MNT-QA es: crear plan → orden vencida → asignar → registrar trabajo y refacciones → terminar y cerrar → próxima ocurrencia; además, un tenant B aislado y un rol sin `view_costs`.
4. **Trazabilidad consolidada.** Publicar `docs/traceability/maintenance.md` con la cadena requisito → contrato → implementación → prueba → evidencia por SHA para FR-095–108, D9, D11, D14 y D20. Conservar las etiquetas de fuente (`CONFIRMED`, `PROPOSED`, `DECISION REQUIRED`).
5. **Regresión acumulativa.** En el SHA candidato deben pasar `pnpm quality`, `pnpm test:integration`, `pnpm test:fleet-integration`, `pnpm test:e2e` y `pnpm test:visual`, sin escenarios MySQL omitidos.

## Aceptación Given / When / Then

1. Given una sesión con `view`, When abre «Mantenimiento» desde la navegación del shell, Then ve órdenes, Mis órdenes, planes y catálogo con datos del contrato y estados compartidos.
2. Given el arnés de API real con MySQL 8.4 sintético y tenants A/B, When el journey de navegador ejecuta el ciclo preventivo completo, Then cada paso persiste, el plan avanza una sola vez y la próxima ocurrencia aparece. Given el tenant B o un rol sin `view_costs`, Then no ve datos de A ni importes.
3. Given el SHA candidato, When corren los comandos de regresión, Then todos pasan sin omisiones. Se registra la versión exacta de MySQL de cada corrida.
4. Given los pendientes de MNT-QA (Idempotency-Key, evidencias configurables, umbral D20 en configuración), When se publica la trazabilidad, Then siguen marcados pendientes con su condición de desbloqueo y no como aprobados.

## Comandos y evidencia

```text
pnpm quality
pnpm test:integration
pnpm test:fleet-integration
pnpm test:e2e
pnpm test:visual
git diff --check
```

Se requiere un PR listo (no draft), CI verde y exactamente una auditoría independiente por SHA. Cada cambio de código invalida la auditoría anterior. La evidencia registra SHA, comando, resultado, versión de MySQL y artefacto o reporte de Playwright.
