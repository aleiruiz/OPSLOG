# FND-BROWSER-E2E — pruebas de navegador y gate de aprobación

```yaml
id: FND-BROWSER-E2E
baseline: [SPEC-1.1, ORCH-1.1, inherited: SPEC-1.0/ORCH-1.0]
milestone: M0+
kind: quality-gate
purpose: Crear una suite Playwright reproducible que cubra todos los componentes UI existentes y convertir su resultado en requisito acumulativo de aprobación para todo proyecto posterior.
depends_on: [FND-REPO, FND-CONTRACTS, FND-DS, FND-INTEGRATE]
write_paths:
  [
    e2e/**,
    playwright.config.*,
    package.json,
    pnpm-lock.yaml,
    packages/ui/**,
    docs/tasks/FND-BROWSER-E2E.md,
  ]
forbidden_paths: [SPECS.md, Orchestrator.md, Tasks.md, .env*, infra/**]
acceptance:
  [
    'Given every existing UI component and story, When the Playwright suite runs in a clean environment, Then each component has at least one browser-level smoke or interaction test.',
    'Given keyboard, loading, empty, error, permission and closed states, When the browser suite runs, Then the required interaction and accessibility assertions pass without relying only on color.',
    'Given a future project or package, When its approval candidate is evaluated, Then its required Playwright browser suite runs on the same candidate SHA and a failure blocks approval.',
    'Given a browser test cannot run, When the candidate is evaluated, Then the approval gate is blocked with the missing evidence recorded; it is never treated as a pass.',
  ]
commands:
  [
    'pnpm install --frozen-lockfile',
    'pnpm exec playwright install --with-deps chromium',
    'pnpm test:e2e',
    'pnpm test:e2e -- --project=chromium',
  ]
approval_gate:
  required: true
  applies_to: [all subsequent projects, all subsequent approval candidates]
  evidence: [candidateSHA, browser, test-command, result, artifact-or-report]
  failure_policy: block approval until remediated and revalidated on the same updated SHA
non_goals:
  [
    'test production or AWS resources',
    'use real customer data or secrets',
    'replace unit, accessibility, integration or contract tests',
  ]
completion_evidence:
  [
    'PR listo para revisión',
    'Playwright config and locked dependency',
    'one browser test per existing component',
    'CI result on candidate SHA',
    'single independent audit for candidate SHA',
  ]
```

## Política de aprobación

Este paquete añade un gate acumulativo para todo trabajo posterior a FND-BROWSER-E2E. Cada tarea nueva que introduzca o modifique una interfaz debe declarar sus casos Playwright, ejecutarlos en CI sobre el SHA candidato y adjuntar el reporte o artefacto resultante. La ausencia del runner, del navegador, del reporte o de una prueba aplicable bloquea la aprobación; no se permite omitir el gate por tratarse de un cambio documental o pequeño.

La suite usa únicamente fixtures sintéticos y servicios efímeros locales. No conecta AWS, producción ni bases de datos existentes. Los cambios de componentes invalidan la evidencia de navegador correspondiente y exigen revalidación en el SHA actualizado.
