import { describe, expect, it } from 'vitest';
import { areaOf, scopeOf } from '../../tools/ci/changed-scope.mjs';

describe('quality workflow change scope', () => {
  it('sorts files into areas', () => {
    expect(areaOf('docs/tasks/INC-CASES-M4-20261013.md')).toBe('docs');
    expect(areaOf('docs/adr/0013-visual-redesign-mui-theme-v2.md')).toBe('docs');
    expect(areaOf('SPECS.md')).toBe('docs');
    expect(areaOf('LICENSE')).toBe('docs');
    expect(areaOf('docs/baselines/BASELINE-1.4.json')).toBe('config');
    expect(areaOf('.github/workflows/quality.yml')).toBe('config');
    expect(areaOf('tools/ci/changed-scope.mjs')).toBe('config');
    expect(areaOf('tests/harness/leak-scan.mjs')).toBe('config');
    expect(areaOf('package.json')).toBe('config');
    expect(areaOf('pnpm-lock.yaml')).toBe('config');
    expect(areaOf('apps/web/alerts/AlertsScreen.tsx')).toBe('web');
    expect(areaOf('packages/ui/src/index.ts')).toBe('web');
    expect(areaOf('e2e/components.spec.ts')).toBe('web');
    expect(areaOf('apps/api/bff/src/http.ts')).toBe('server');
    expect(areaOf('packages/contracts/src/index.ts')).toBe('server');
    // Markdown inside a package is read by its tests.
    expect(areaOf('infra/runtime/STAGING.md')).toBe('server');
  });

  it('skips product suites for documentation-only changes', () => {
    expect(scopeOf(['docs/adr/0014-x.md', 'AGENTS.md'])).toEqual({
      product: false,
      integration: false,
      visual: false,
    });
    expect(scopeOf([])).toEqual({ product: false, integration: false, visual: false });
  });

  it('runs only the suites the changed areas can affect', () => {
    expect(scopeOf(['apps/web/app/router.tsx', 'docs/x.md'])).toEqual({
      product: true,
      integration: false,
      visual: true,
    });
    expect(scopeOf(['packages/domain/vehicles/src/vin.ts'])).toEqual({
      product: true,
      integration: true,
      visual: false,
    });
    expect(scopeOf(['pnpm-lock.yaml'])).toEqual({ product: true, integration: true, visual: true });
  });

  it('runs everything when the change set is unknown', () => {
    expect(scopeOf(null)).toEqual({ product: true, integration: true, visual: true });
  });
});
