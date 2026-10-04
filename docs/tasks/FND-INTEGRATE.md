# FND-INTEGRATE — composición M0

```yaml
id: FND-INTEGRATE
baseline: [SPEC-1.1, ORCH-1.1, inherited: SPEC-1.0/ORCH-1.0]
milestone: M0
kind: integration
purpose: Registrar y validar juntos workspace, contratos, design system, CI y controles de baseline.
depends_on: [FND-REPO, FND-CONTRACTS, FND-DS, FND-ORCH, FND-AWS]
write_paths:
  [
    package.json,
    pnpm-workspace.yaml,
    pnpm-lock.yaml,
    tsconfig*.json,
    eslint*,
    .github/workflows/quality*,
    packages/*/package.json,
    packages/*/tsconfig.json,
    packages/ui/**,
    packages/contracts/**,
    docs/tasks/FND-INTEGRATE.md,
  ]
forbidden_paths: [SPECS.md, Orchestrator.md, Tasks.md, .env*, infra/**]
acceptance:
  [
    'Given the accepted M0 packages, When frozen install and quality run on one SHA, Then contracts/UI/harness are reproducible together.',
    'Given the integrated candidate, When G0 validation runs, Then baseline integrity and dependency/provider blocks are explicit.',
  ]
commands:
  [
    'pnpm install --frozen-lockfile',
    'pnpm lint',
    'pnpm format:check',
    'pnpm typecheck',
    'pnpm test:unit',
    'pnpm test:integration',
    'pnpm build',
    'pnpm --filter @opslog/ui axe',
  ]
non_goals: ['implement FND-ORCH runtime', 'connect AWS', 'declare G0 passed']
completion_evidence:
  ['PR', 'baseSHA/headSHA', 'CI real', 'single independent audit', 'G0 revalidation']
```

FND-ORCH y FND-AWS permanecen dependencias explícitas; su ausencia no se representa como aceptación.
